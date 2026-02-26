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

const TRACKING_PATTERNS = {
    ups: /1Z[0-9A-Z]{16}/i,
    fedex: /\b\d{12,15}\b/i,
    usps: /\b94\d{20}\b/i,
    generic: /\b(tracking|track|carrier|waybill)\s*[#:]?\s*([0-9A-Z]{10,25})\b/i
};

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

        // Daily Summary @ 8:00 AM
        cron.schedule("0 8 * * *", () => {
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

            // Search for PO emails sent recently
            const { data: search } = await gmail.users.messages.list({
                userId: "me",
                q: "label:PO after:2026/01/01",
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
                        if (match && !trackingNumbers.includes(match[0])) {
                            trackingNumbers.push(match[0]);
                        }
                    }
                }

                // Alert for NEW tracking numbers
                if (trackingNumbers.length > 0) {
                    const { data: existingPO } = await supabase.from("purchase_orders").select("tracking_numbers").eq("po_number", poNumber).single();
                    const oldTracking = existingPO?.tracking_numbers || [];
                    const newTracking = trackingNumbers.filter(t => !oldTracking.includes(t));

                    if (newTracking.length > 0) {
                        this.bot.telegram.sendMessage(
                            process.env.TELEGRAM_CHAT_ID || "",
                            `🚚 **New Tracking Detected!**\n\nPO: #${poNumber}\nVendor: ${subject}\nNumbers: ${newTracking.join(", ")}\n\n_Correlation logic in effect._`,
                            { parse_mode: "Markdown" }
                        );
                    }
                }

                // Index to Pinecone for RAG
                await indexOperationalContext(
                    `po-${poNumber}`,
                    `PO ${poNumber} for ${subject}. Sent: ${new Date(sentAt).toLocaleString()}. Response: ${responseAt ? new Date(responseAt).toLocaleString() : 'Pending'}. Tracking: ${trackingNumbers.join(", ") || 'None'}`,
                    { po_number: poNumber, subject, vendor_response_time: responseTimeMins, tracking_numbers: trackingNumbers }
                );

                // Update DB
                await supabase.from("purchase_orders").upsert({
                    po_number: poNumber,
                    vendor_response_at: responseAt ? new Date(responseAt).toISOString() : null,
                    vendor_response_time_minutes: responseTimeMins,
                    tracking_numbers: trackingNumbers,
                    updated_at: new Date().toISOString()
                }, { onConflict: "po_number" });
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

        try {
            const [pos, invoices, documents] = await Promise.all([
                supabase.from("purchase_orders").select("po_number, vendor_name, total, status").gte("created_at", isoDate).limit(10),
                supabase.from("invoices").select("invoice_number, vendor_name, amount_due, status").gte("created_at", isoDate).limit(10),
                supabase.from("documents").select("type, status, email_from, email_subject, action_required").gte("created_at", isoDate).limit(10)
            ]);

            // Grab Finale received and committed PO data independently
            let finaleReceivedDataText = "No direct receivings data from Finale.";
            let finaleCommittedDataText = "No direct committed PO data from Finale.";
            try {
                const { FinaleClient } = await import("../finale/client");
                const finale = new FinaleClient();
                const [receivedPOs, committedPOs] = await Promise.all([
                    finale.getTodaysReceivedPOs(),
                    finale.getTodaysCommittedPOs()
                ]);
                finaleReceivedDataText = finale.formatReceivingsDigest(receivedPOs);
                finaleCommittedDataText = await finale.formatCommittedDigest(committedPOs);
            } catch (err) {
                console.warn("Could not fetch Finale PO activity for summary", err);
            }

            // Attempt to grab unread actionable emails
            let unreadCount = 0;
            let unreadSubjects: string[] = [];
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

            return {
                purchase_orders_db: pos.data || [],
                finale_receivings_digest: finaleReceivedDataText,
                finale_committed_digest: finaleCommittedDataText,
                invoices: invoices.data || [],
                documents: documents.data || [],
                unread_emails: {
                    count: unreadCount,
                    subjects: unreadSubjects
                }
            };
        } catch (err) {
            return { purchase_orders_db: [], finale_receivings_digest: "Error", finale_committed_digest: "Error", invoices: [], documents: [], unread_emails: { count: 0, subjects: [] } };
        }
    }

    private async generateLLMSummary(title: string, data: any) {
        const isEmpty = !data.purchase_orders_db.length && !data.invoices.length && !data.documents.length && data.unread_emails.count === 0 && data.finale_receivings_digest.includes("No direct");
        if (isEmpty) return "No operations tracked in the system for this timeframe.";

        const prompt = `Summarize the following operations activity for the ${title} report. 
        Focus on total spend/amount due, vendors contacted or invoiced. Mention both 'finale_receivings_digest' and 'finale_committed_digest' including anomalies found. Highlight incoming documents and mention the unread email count/subjects.
        Format cleanly with markdown bullets. Be concise but actionable. If a section has no data, skip it without mentioning it.
        Data: ${JSON.stringify(data)}`;

        try {
            return await unifiedTextGeneration({
                system: SYSTEM_PROMPT,
                prompt: prompt
            });
        } catch (err) {
            return "Unable to generate intelligent summary at this time.";
        }
    }
}
