/**
 * @file    ops-manager.ts
 * @purpose Handles background operations: PO tracking, email filtering, summaries,
 *          and daily Calendar BOM build risk analysis.
 *          Cross-posts daily/weekly summaries to both Telegram and Slack #purchasing.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-02-25
 * @deps    googleapis, node-cron, telegraf, @slack/web-api, builds/build-risk
 */

import { google } from "googleapis";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import cron from "node-cron";
import { Telegraf } from "telegraf";
import { WebClient } from "@slack/web-api";
import { SYSTEM_PROMPT } from "../../config/persona";
import { indexOperationalContext } from "./pinecone";
import { unifiedTextGeneration } from "./llm";
import { runBuildRiskAnalysis } from "../builds/build-risk";
import { APAgent } from "./ap-agent";
import FirecrawlApp from "@mendable/firecrawl-js";

const TRACKING_PATTERNS = {
    ups: /\b1Z[0-9A-Z]{16}\b/i,
    // FedEx: 12-digit express, 15-digit ground, or 96XXXXXXXXXXXXXXXXXX (20-digit SmartPost)
    fedex: /\b(96\d{18}|\d{15}|\d{12})\b/,
    usps: /\b(94|92|93|95)\d{20}\b/,
    dhl: /\bJD\d{18}\b/i,
    generic: /\b(tracking|track|waybill)\s*[#:]?\s*([0-9A-Z]{10,25})\b/i
};

type TrackingCategory = 'delivered' | 'out_for_delivery' | 'in_transit' | 'exception';
interface TrackingStatus { category: TrackingCategory; display: string; }


function carrierUrl(trackingNumber: string): string {
    if (/^1Z/i.test(trackingNumber)) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
    if (/^(94|92|93|95)/.test(trackingNumber)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
    if (/^JD/i.test(trackingNumber)) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
    return `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`;
}

/**
 * Parse delivery status from carrier page markdown using regex — no LLM.
 */
function parseTrackingContent(content: string): TrackingStatus | null {
    // Delivered — check first; most definitive
    const deliveredDate = content.match(
        /delivered\s+(?:on\s+)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i
    );
    if (deliveredDate) return { category: 'delivered', display: `Delivered ${deliveredDate[1]}` };
    if (/\bdelivered\b/i.test(content)) return { category: 'delivered', display: 'Delivered' };

    // Out for delivery
    if (/out\s+for\s+delivery/i.test(content))
        return { category: 'out_for_delivery', display: 'Out for delivery' };

    // Exception / delay
    if (/\bexception\b|\bdelay(ed)?\b|unable to deliver/i.test(content))
        return { category: 'exception', display: 'Delivery exception' };

    // Estimated / scheduled / expected delivery date — optional day-of-week prefix handled
    const eta = content.match(
        /(?:estimated|scheduled|expected)\s+delivery[:\s]+(?:[A-Z][a-z]+,\s+)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i
    );
    if (eta) return { category: 'in_transit', display: `Expected ${eta[1]}` };

    // "by end of day <date>"
    const eod = content.match(/by\s+end\s+of\s+(?:business\s+)?day[,\s]+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i);
    if (eod) return { category: 'in_transit', display: `Expected by ${eod[1]}` };

    // Generic in-transit signals
    if (/in\s+transit|on\s+the\s+way|picked\s+up|departed/i.test(content))
        return { category: 'in_transit', display: 'In transit' };

    return null;
}

/**
 * Scrape a carrier tracking page via Firecrawl and return structured delivery status.
 * Pure regex parsing — no LLM. Times out after 20s; returns null on any failure.
 */
async function scrapeTrackingStatus(trackingNumber: string): Promise<TrackingStatus | null> {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) return null;

    try {
        const firecrawl = new FirecrawlApp({ apiKey });
        const result = await Promise.race([
            firecrawl.scrapeUrl(carrierUrl(trackingNumber), { formats: ["markdown"] }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Firecrawl timeout")), 20000)
            ),
        ]) as any;

        const content: string = result?.markdown || result?.content || "";
        if (content.length < 50) return null;

        return parseTrackingContent(content);
    } catch (err: any) {
        console.warn(`[tracking-scrape] ${trackingNumber}: ${err.message}`);
        return null;
    }
}

/**
 * Main Operations Manager Class
 */
export class OpsManager {
    private bot: Telegraf;
    private slack: WebClient | null;
    private slackChannel: string;
    private apAgent: APAgent;

    constructor(bot: Telegraf) {
        this.bot = bot;

        // DECISION(2026-02-25): Initialize Slack client alongside Telegram.
        // Slack posting is best-effort — if SLACK_BOT_TOKEN is missing, we
        // gracefully skip Slack without blocking the Telegram message.
        const slackToken = process.env.SLACK_BOT_TOKEN;
        this.slack = slackToken ? new WebClient(slackToken) : null;
        this.slackChannel = process.env.SLACK_MORNING_CHANNEL || "#purchasing";

        if (!this.slack) {
            console.warn("⚠️ OpsManager: SLACK_BOT_TOKEN not set — Slack cross-posting disabled.");
        }

        // Initialize dedicated AP inbox agent
        this.apAgent = new APAgent(bot);
    }

    /**
     * Start all scheduled tasks
     */
    start() {
        console.log("🚀 Starting Ops Manager Scheduler...");

        // DECISION(2026-02-25): Build Risk Analysis @ 7:30 AM, 30 min before
        // the daily summary. This gives Will actionable stockout warnings
        // first, so the daily PO summary that follows has full context.
        cron.schedule("30 7 * * 1-5", () => {
            this.sendBuildRiskReport();
        }, { timezone: "America/Denver" });

        // AP Agent checks for new invoices every 15 minutes
        cron.schedule("*/15 * * * *", () => {
            this.apAgent.processUnreadInvoices();
        });

        // Daily Summary @ 8:00 AM weekdays only
        cron.schedule("0 8 * * 1-5", () => {
            this.sendDailySummary();
        }, { timezone: "America/Denver" });

        // Friday Summary @ 8:01 AM
        cron.schedule("1 8 * * 5", () => {
            this.sendWeeklySummary();
        }, { timezone: "America/Denver" });

        // Email Maintenance (Advertisements) every hour
        cron.schedule("0 * * * *", () => {
            this.processAdvertisements();
        });

        // PO Sync every 30 minutes
        cron.schedule("*/30 * * * *", () => {
            this.syncPOConversations();
        });

        // AP Agent Daily Recap @ 5:00 PM MST weekdays
        // DECISION(2026-02-26): End-of-day recap provides a monitoring layer
        // so Will can review all AP Agent decisions daily. Critical during
        // early rollout to catch any misclassifications.
        cron.schedule("0 17 * * 1-5", () => {
            this.apAgent.sendDailyRecap();
        }, { timezone: "America/Denver" });
    }

    /**
     * Move advertisements to label
     */
    async processAdvertisements() {
        console.log("🧹 Running Advertisement Cleanup...");
        try {
            const auth = await getAuthenticatedClient("default");
            const gmail = google.gmail({ version: "v1", auth });

            const { data: search } = await gmail.users.messages.list({
                userId: "me",
                q: "unsubscribe -label:Advertisements",
                maxResults: 50
            });

            if (!search.messages?.length) return;

            const ids = search.messages.map(m => m.id!);

            await gmail.users.messages.batchModify({
                userId: "me",
                requestBody: {
                    ids,
                    addLabelIds: ["Label_20"], // Advertisements
                    removeLabelIds: ["INBOX"]
                }
            });

            console.log(`✅ Moved ${ids.length} advertisements.`);
        } catch (err: any) {
            console.error("Cleanup error:", err.message);
        }
    }

    /**
     * Sync PO conversations and tracking response times
     */
    async syncPOConversations() {
        console.log("📦 Syncing PO Conversations...");
        try {
            const auth = await getAuthenticatedClient("default");
            const gmail = google.gmail({ version: "v1", auth });
            const supabase = createClient();

            // Only scan POs from the last 14 days — tracking arrives well within that window
            const since = new Date();
            since.setDate(since.getDate() - 14);
            const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '/');

            const { data: search } = await gmail.users.messages.list({
                userId: "me",
                q: `label:PO after:${sinceStr}`,
                maxResults: 50
            });

            if (!search.messages?.length) return;

            for (const m of search.messages) {
                const { data: thread } = await gmail.users.threads.get({
                    userId: "me",
                    id: m.threadId!
                });

                if (!thread.messages) continue;

                const firstMsg = thread.messages[0];
                const subject = firstMsg.payload?.headers?.find(h => h.name === 'Subject')?.value || "";

                // Parse PO # from subject
                const poMatch = subject.match(/BuildASoil PO #\s?(\d+)/i);
                if (!poMatch) continue;
                const poNumber = poMatch[1];

                // Calculate response time
                const sentAt = parseInt(firstMsg.internalDate!);
                let responseAt: number | null = null;

                for (const msg of thread.messages.slice(1)) {
                    const from = msg.payload?.headers?.find(h => h.name === 'From')?.value || "";
                    if (!from.includes("buildasoil.com")) {
                        responseAt = parseInt(msg.internalDate!);
                        break;
                    }
                }

                const responseTimeMins = responseAt ? Math.round((responseAt - sentAt) / 60000) : null;

                // 🔍 Extract Tracking Numbers from Snippets
                let trackingNumbers: string[] = [];
                for (const msg of thread.messages) {
                    const body = msg.snippet || "";
                    for (const [carrier, regex] of Object.entries(TRACKING_PATTERNS)) {
                        const match = body.match(regex);
                        if (!match) continue;
                        // For the generic pattern, capture group [2] is the number itself.
                        // All other patterns are direct matches with no prefix in [0].
                        const trackingNum = carrier === "generic" ? match[2] : match[0];
                        if (trackingNum && !trackingNumbers.includes(trackingNum)) {
                            trackingNumbers.push(trackingNum);
                        }
                    }
                }

                // Extract vendor name from subject: "BuildASoil PO # 124350 - Vendor Name - date"
                // Declared here so it's available for both tracking alerts and vendor profiles.
                const vendorMatch = subject.match(/BuildASoil PO\s*#?\s*\d+\s*-\s*(.+?)\s*-\s*[\d/]+$/i);
                const vendorName = vendorMatch ? vendorMatch[1].trim() : subject;

                // Alert for NEW tracking numbers
                if (trackingNumbers.length > 0) {
                    const { data: existingPO } = await supabase.from("purchase_orders").select("tracking_numbers").eq("po_number", poNumber).single();
                    const oldTracking = existingPO?.tracking_numbers || [];
                    const newTracking = trackingNumbers.filter(t => !oldTracking.includes(t));

                    if (newTracking.length > 0) {
                        // Persist tracking numbers FIRST — prevents duplicate alerts if two
                        // processes run concurrently (e.g. PM2 restart during a sync cycle).
                        await supabase.from("purchase_orders").upsert({
                            po_number: poNumber,
                            vendor_response_at: responseAt ? new Date(responseAt).toISOString() : null,
                            vendor_response_time_minutes: responseTimeMins,
                            tracking_numbers: trackingNumbers,
                            updated_at: new Date().toISOString()
                        }, { onConflict: "po_number" });

                        // Format PO sent date
                        const sentDate = new Date(sentAt).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
                            timeZone: 'America/Denver'
                        });

                        // Fetch PO line items + Finale deep-link
                        const { FinaleClient } = await import("../finale/client");
                        const finale = new FinaleClient();
                        const poDetails = await finale.getPOLineItems(poNumber);

                        const poLine = poDetails
                            ? `PO: <a href="${poDetails.finaleUrl}">#${poNumber}</a>`
                            : `PO: #${poNumber}`;

                        const itemsLine = poDetails?.lineItems.length
                            ? `Items: ${poDetails.lineItems.map(i => `<code>${i.sku}</code> ×${i.qty}`).join(', ')}`
                            : "";

                        // Scrape delivery status + build message lines per tracking number
                        const trackingLines = await Promise.all(newTracking.map(async t => {
                            const ts = await scrapeTrackingStatus(t);
                            const statusStr = ts ? `  ${ts.display}` : "";
                            return `<a href="${carrierUrl(t)}">${t}</a><i>${statusStr}</i>`;
                        }));

                        let msg = `<b>Tracking Alert</b>\n\n${poLine}\nVendor: ${vendorName}\nSent: ${sentDate}`;
                        if (itemsLine) msg += `\n${itemsLine}`;
                        msg += `\n\n${trackingLines.join('\n')}`;

                        this.bot.telegram.sendMessage(
                            process.env.TELEGRAM_CHAT_ID || "",
                            msg,
                            { parse_mode: "HTML" }
                        );
                    }
                }

                // Index to Pinecone for RAG
                await indexOperationalContext(
                    `po-${poNumber}`,
                    `PO ${poNumber} for ${subject}. Sent: ${new Date(sentAt).toLocaleString()}. Response: ${responseAt ? new Date(responseAt).toLocaleString() : 'Pending'}. Tracking: ${trackingNumbers.join(", ") || 'None'}`,
                    { po_number: poNumber, subject, vendor_response_time: responseTimeMins, tracking_numbers: trackingNumbers }
                );

                // Update DB (full record sync — tracking already upserted above if new)
                await supabase.from("purchase_orders").upsert({
                    po_number: poNumber,
                    vendor_response_at: responseAt ? new Date(responseAt).toISOString() : null,
                    vendor_response_time_minutes: responseTimeMins,
                    tracking_numbers: trackingNumbers,
                    updated_at: new Date().toISOString()
                }, { onConflict: "po_number" });

                // Update vendor intelligence profile — accumulate known email addresses
                // and track whether this vendor replies to PO threads.
                // Re-extract vendor name here since it's scoped inside the newTracking block above.
                const vendorNameForProfile = (subject.match(/BuildASoil PO\s*#?\s*\d+\s*-\s*(.+?)\s*-\s*[\d/]+$/i) || [])[1]?.trim() || null;
                if (vendorNameForProfile) {
                    const vendorEmails: string[] = [];
                    for (const msg of thread.messages) {
                        const fromHeader = msg.payload?.headers?.find((h: any) => h.name === 'From')?.value || "";
                        if (fromHeader.includes("@") && !fromHeader.includes("buildasoil.com")) {
                            const emailMatch = fromHeader.match(/<([^>]+)>/);
                            const email = (emailMatch ? emailMatch[1] : fromHeader.trim()).toLowerCase();
                            if (email && !vendorEmails.includes(email)) vendorEmails.push(email);
                        }
                    }

                    const { data: existing } = await supabase
                        .from("vendor_profiles")
                        .select("vendor_emails")
                        .eq("vendor_name", vendorNameForProfile)
                        .maybeSingle();

                    const mergedEmails = [...new Set([...(existing?.vendor_emails || []), ...vendorEmails])];

                    await supabase.from("vendor_profiles").upsert({
                        vendor_name: vendorNameForProfile,
                        vendor_emails: mergedEmails,
                        communication_pattern: responseAt ? "thread_reply" : "no_response",
                        last_po_date: new Date(sentAt).toISOString(),
                        updated_at: new Date().toISOString(),
                    }, { onConflict: "vendor_name" });
                }
            }
        } catch (err: any) {
            console.error("PO Sync error:", err.message);
        }
    }

    /**
     * Posts a message to Slack #purchasing (best-effort).
     * Failures are logged but never block the Telegram path.
     *
     * @param text   - Slack mrkdwn formatted message
     * @param label  - Human label for log messages (e.g. "Daily Summary")
     */
    private async postToSlack(text: string, label: string): Promise<void> {
        if (!this.slack) return;

        try {
            await this.slack.chat.postMessage({
                channel: this.slackChannel,
                text,
                mrkdwn: true,
            });
            console.log(`✅ ${label} posted to Slack ${this.slackChannel}`);
        } catch (err: any) {
            // Non-fatal: Telegram message was already sent
            console.error(`❌ Slack post failed (${label}):`, err.data?.error || err.message);
        }
    }

    /**
     * Generate and send the daily summary to Telegram + Slack.
     */
    async sendDailySummary() {
        console.log("📊 Preparing Daily PO Summary...");
        const opsData = await this.getOperationsStatsForTimeframe("yesterday");

        const summary = await this.generateLLMSummary("Daily", opsData);
        const telegramMsg = `📊 **Morning Operations Summary**\n\n${summary}`;

        // 1. Always send to Telegram first (primary channel)
        this.bot.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID || "",
            telegramMsg,
            { parse_mode: "Markdown" }
        );

        // 2. Cross-post to Slack #purchasing
        const slackMsg = `:chart_with_upwards_trend: *Morning Operations Summary*\n\n${summary}`;
        await this.postToSlack(slackMsg, "Daily Summary");
    }

    /**
     * Generate and send the weekly summary (Friday) to Telegram + Slack.
     */
    async sendWeeklySummary() {
        console.log("📅 Preparing Weekly PO Summary...");
        const opsData = await this.getOperationsStatsForTimeframe("week");

        const summary = await this.generateLLMSummary("Weekly", opsData);
        const telegramMsg = `🗓️ **Friday Weekly Operations Review**\n\n${summary}`;

        // 1. Always send to Telegram first (primary channel)
        this.bot.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID || "",
            telegramMsg,
            { parse_mode: "Markdown" }
        );

        // 2. Cross-post to Slack #purchasing
        const slackMsg = `:calendar: *Friday Weekly Operations Review*\n\n${summary}`;
        await this.postToSlack(slackMsg, "Weekly Summary");
    }

    /**
     * Run the Calendar BOM build risk analysis and post results.
     * Fetches production calendars → parses events → explodes BOMs → checks stock.
     * Posts to both Telegram and Slack #purchasing.
     *
     * DECISION(2026-02-25): This runs at 7:30 AM weekdays, 30 min before
     * the daily summary. Errors are caught and reported but never block
     * the rest of the OpsManager schedule.
     */
    async sendBuildRiskReport() {
        console.log("🏭 Running daily Calendar BOM Build Risk Analysis...");

        try {
            const report = await runBuildRiskAnalysis(30, (msg) => {
                console.log(`[build-risk-cron] ${msg}`);
            });

            // 1. Send Telegram version
            const telegramMsg = report.telegramMessage;
            this.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID || "",
                telegramMsg,
                { parse_mode: "Markdown" }
            );

            // 2. Cross-post Slack version to #purchasing
            await this.postToSlack(report.slackMessage, "Build Risk Report");

            // 3. If critical items exist, send a follow-up with action items
            if (report.criticalCount > 0) {
                const urgentMsg = `🚨 *${report.criticalCount} CRITICAL stockout risk(s) detected!*\n` +
                    `_These components will stock out within 14 days and have no incoming POs._\n` +
                    `_Check the build risk report above for details, or run \`/buildrisk\` for the full analysis._`;

                this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID || "",
                    urgentMsg,
                    { parse_mode: "Markdown" }
                );
            }

            // Persist snapshot to Supabase for dashboard (fire-and-forget)
            setImmediate(async () => {
                const { saveBuildRiskSnapshot } = await import('../builds/build-risk-logger');
                await saveBuildRiskSnapshot(report);
            });

            console.log(`✅ Build risk report sent: 🔴 ${report.criticalCount} · 🟡 ${report.warningCount} · 👀 ${report.watchCount} · ✅ ${report.okCount}`);
        } catch (err: any) {
            console.error("❌ Build risk analysis failed:", err.message);

            // Report the failure to Telegram so Will knows
            this.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID || "",
                `⚠️ _Daily build risk analysis failed: ${err.message}_\n_Run \`/buildrisk\` manually to troubleshoot._`,
                { parse_mode: "Markdown" }
            );
        }
    }

    private async getOperationsStatsForTimeframe(timeframe: "yesterday" | "week") {
        const supabase = createClient();
        const date = new Date();
        if (timeframe === "yesterday") date.setDate(date.getDate() - 1);
        else date.setDate(date.getDate() - 7);
        const isoDate = date.toISOString().split("T")[0];

        // For weekly reports, calculate Monday of current week → today (Mountain Time)
        let finaleStartDate: string | undefined;
        let finaleEndDate: string | undefined;
        if (timeframe === "week") {
            const now = new Date();
            const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri
            const monday = new Date(now);
            monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
            finaleStartDate = monday.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
            const tomorrow = new Date(now);
            tomorrow.setDate(now.getDate() + 1);
            finaleEndDate = tomorrow.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
        }

        try {
            const [pos, invoices, documents] = await Promise.all([
                supabase.from("purchase_orders").select("po_number, vendor_name, total, status").gte("created_at", isoDate).limit(50),
                supabase.from("invoices").select("invoice_number, vendor_name, amount_due, status").gte("created_at", isoDate).limit(20),
                supabase.from("documents").select("type, status, email_from, email_subject, action_required").gte("created_at", isoDate).limit(10)
            ]);

            // Grab Finale received and committed PO data — use full week range for weekly reports
            let finaleReceivedDataText = "No receivings data from Finale.";
            let finaleCommittedDataText = "No committed PO data from Finale.";
            try {
                const { FinaleClient } = await import("../finale/client");
                const finale = new FinaleClient();
                const [receivedPOs, committedPOs] = await Promise.all([
                    finale.getTodaysReceivedPOs(finaleStartDate, finaleEndDate),
                    finale.getTodaysCommittedPOs(finaleStartDate, finaleEndDate)
                ]);
                finaleReceivedDataText = finale.formatReceivingsDigest(receivedPOs);
                finaleCommittedDataText = await finale.formatCommittedDigest(committedPOs);
            } catch (err) {
                console.warn("Could not fetch Finale PO activity for summary", err);
            }

            // Unread emails: daily only — not relevant for weekly review
            let unreadCount = 0;
            let unreadSubjects: string[] = [];
            if (timeframe === "yesterday") {
                try {
                    const auth = await getAuthenticatedClient("default");
                    const gmail = google.gmail({ version: "v1", auth });
                    const { data } = await gmail.users.messages.list({
                        userId: "me",
                        q: "is:unread -label:Advertisements -label:SPAM INBOX",
                        maxResults: 5
                    });
                    unreadCount = data.resultSizeEstimate || (data.messages ? data.messages.length : 0);

                    if (data.messages && data.messages.length > 0) {
                        for (const m of data.messages) {
                            const msg = await gmail.users.messages.get({ userId: "me", id: m.id! });
                            const subject = msg.data.payload?.headers?.find(h => h.name === 'Subject')?.value || "No Subject";
                            unreadSubjects.push(subject);
                        }
                    }
                } catch (gmailErr) {
                    console.warn("Could not fetch unread emails for summary:", gmailErr);
                }
            }

            return {
                timeframe,
                purchase_orders_db: pos.data || [],
                finale_receivings_digest: finaleReceivedDataText,
                finale_committed_digest: finaleCommittedDataText,
                invoices: invoices.data || [],
                documents: documents.data || [],
                unread_emails: { count: unreadCount, subjects: unreadSubjects }
            };
        } catch (err) {
            return { timeframe, purchase_orders_db: [], finale_receivings_digest: "Error", finale_committed_digest: "Error", invoices: [], documents: [], unread_emails: { count: 0, subjects: [] } };
        }
    }

    private async generateLLMSummary(title: string, data: any) {
        const isWeekly = data.timeframe === "week";
        const isEmpty = !data.purchase_orders_db.length && !data.invoices.length && !data.documents.length
            && data.unread_emails.count === 0 && data.finale_receivings_digest.includes("No ");
        if (isEmpty) return "No operations tracked in the system for this timeframe.";

        const prompt = isWeekly
            ? `Generate a concise Friday Weekly Operations Review for BuildASoil from the data below.

INCLUDE (in this order):
1. **Weekly Receivings** — List EVERY PO received this week. For each: vendor name, PO number, total units received, dollar amount, and key SKUs. End with a total (# POs, total units, total $).
2. **POs Committed This Week** — List each new PO placed: vendor, PO number, dollar amount. End with total spend.
3. **Notable items** — Any anomalies, large orders, or action items worth flagging.

DO NOT include: vendors-contacted/invoiced section, unread emails, document processing stats.
Format with clean markdown bullets. Be specific with numbers — no vague summaries.
Data: ${JSON.stringify(data)}`
            : `Summarize the following operations activity for the Daily Morning report.
Focus on: total spend/amount due, Finale receivings (POs received, units, vendors), committed POs, and unread actionable email count.
DO NOT include a vendors-contacted/invoiced section.
Format cleanly with markdown bullets. Be concise but actionable. If a section has no data, skip it.
Data: ${JSON.stringify(data)}`;

        try {
            return await unifiedTextGeneration({
                system: SYSTEM_PROMPT,
                prompt
            });
        } catch (err) {
            return "Unable to generate intelligent summary at this time.";
        }
    }
}
