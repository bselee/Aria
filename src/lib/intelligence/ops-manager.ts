/**
 * @file    ops-manager.ts
 * @purpose Handles background operations: PO tracking, email filtering, summaries,
 *          and daily Calendar BOM build risk analysis.
 *          Cross-posts daily/weekly summaries to both Telegram and Slack #purchasing.
 *          Posts completed build notifications to the MFG Google Calendar.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-03-04
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
import { leadTimeService } from "../builds/lead-time-service";
import { APAgent } from "./ap-agent";
import { CalendarClient, CALENDAR_IDS, PURCHASING_CALENDAR_ID } from "../google/calendar";
import type { FullPO } from "../finale/client";
import { BuildParser } from "./build-parser";
import { FinaleClient } from "../finale/client";
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
 * Build an RFC 2822 raw email string for a vendor follow-up reply.
 * Returns a raw MIME email suitable for Gmail's `users.messages.send` (before base64url encoding).
 */
function buildFollowUpEmail(opts: {
    to: string;
    subject: string;
    inReplyTo: string;
    references: string;
    body: string;
}): string {
    const lines = [
        `From: bill.selee@buildasoil.com`,
        `To: ${opts.to}`,
        `Subject: ${opts.subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=UTF-8`,
    ];
    if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
    if (opts.references) lines.push(`References: ${opts.references}`);
    lines.push('', opts.body);
    return lines.join('\r\n');
}

/**
 * Main Operations Manager Class
 */
export class OpsManager {
    private bot: Telegraf;
    private slack: WebClient | null;
    private slackChannel: string;
    private apAgent: APAgent;
    // In-memory dedup for build completion alerts.
    // Hydrated from Supabase on startup to prevent duplicate alerts after restart.
    private seenCompletedBuildIds = new Set<string>();
    // In-memory dedup for PO receiving alerts.
    // Hydrated from today's received POs on startup to prevent replay after restart.
    private seenReceivedPOIds = new Set<string>();
    // In-memory dedup for outside-PO-thread email alerts.
    // Prevents the same vendor email from triggering a Telegram notification on every sync cycle.
    // Hydrated from Supabase on startup.
    private seenOutsideThreadMsgIds = new Set<string>();

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

        // Hydrate dedup Sets from Supabase/Finale so a restart doesn't re-alert on
        // builds completed or POs received in the last 2 hours.
        this.hydrateSeenSets().catch(err =>
            console.warn('[ops-manager] hydrateSeenSets failed (non-fatal):', err.message)
        );

        // DECISION(2026-03-04): Build Risk Analysis @ 5:00 AM — team starts early.
        // Fires before the crew arrives so calendar annotations and stockout
        // warnings are visible when they check the build schedule.
        cron.schedule("0 5 * * 1-5", () => {
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

        // Build Completion Watcher every 30 minutes
        // Polls Finale for newly-completed build orders, sends Telegram alert,
        // and appends a completion timestamp to the matching calendar event description.
        cron.schedule("*/30 * * * *", () => {
            this.pollBuildCompletions();
        });

        // PO Receiving Watcher every 30 minutes
        // Polls Finale for today's newly-received purchase orders and sends Telegram alerts.
        cron.schedule("*/30 * * * *", () => {
            this.pollPOReceivings();
        });

        // Purchasing Calendar Sync every 4 hours
        // Creates/updates calendar events for outgoing and received POs.
        cron.schedule("0 */4 * * *", () => {
            this.syncPurchasingCalendar();
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

                // Extract vendor email from the "To:" header (PO emails are sent TO the vendor)
                const toHeader = firstMsg.payload?.headers?.find((h: any) => h.name === 'To')?.value || '';
                const vendorEmailMatch = toHeader.match(/<([^>]+)>/);
                const vendorEmail = (vendorEmailMatch ? vendorEmailMatch[1] : toHeader.split(',')[0].trim()).toLowerCase();

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

                // ── Vendor follow-up + outside-thread search (non-responders only) ──
                const vendorReplied = responseAt !== null;
                const poIsOlderThan3Days = sentAt < Date.now() - 3 * 86_400_000;

                if (!vendorReplied && trackingNumbers.length === 0 && poIsOlderThan3Days && vendorEmail) {
                    // 1. Follow-up email in original thread (once per PO)
                    try {
                        const { data: poRow } = await supabase
                            .from("purchase_orders")
                            .select("follow_up_sent_at")
                            .eq("po_number", poNumber)
                            .maybeSingle();

                        if (!poRow?.follow_up_sent_at) {
                            const sentDateStr = new Date(sentAt).toLocaleDateString('en-US', {
                                month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver',
                            });
                            const firstMsgId = firstMsg.payload?.headers?.find((h: any) => h.name === 'Message-ID')?.value || '';
                            const rawEmail = buildFollowUpEmail({
                                to: vendorEmail,
                                subject: `Re: ${subject}`,
                                inReplyTo: firstMsgId,
                                references: firstMsgId,
                                body: `Hi,\n\nFollowing up on PO #${poNumber} sent ${sentDateStr}. Could you share an expected ship date or tracking number?\n\nThank you!`,
                            });
                            await gmail.users.messages.send({
                                userId: 'me',
                                requestBody: { raw: Buffer.from(rawEmail).toString('base64url'), threadId: m.threadId! },
                            });
                            await supabase.from("purchase_orders").upsert({
                                po_number: poNumber,
                                follow_up_sent_at: new Date().toISOString(),
                                updated_at: new Date().toISOString(),
                            }, { onConflict: "po_number" });
                            console.log(`📧 [po-sync] Sent follow-up to ${vendorEmail} for PO #${poNumber}`);
                            this.bot.telegram.sendMessage(
                                process.env.TELEGRAM_CHAT_ID || "",
                                `📧 Sent ETA follow-up to <b>${vendorName}</b> for PO #${poNumber} (${sentDateStr}, no response in 3+ days)`,
                                { parse_mode: "HTML" }
                            );
                        }
                    } catch (e: any) {
                        console.warn(`[po-sync] Follow-up email failed for PO #${poNumber}: ${e.message}`);
                    }

                    // 2. Outside-thread search: look for vendor replies in other Gmail threads
                    const vendorDomain = vendorEmail.split('@')[1];
                    if (vendorDomain && !vendorDomain.includes('buildasoil.com')) {
                        try {
                            const sendDateStr = new Date(sentAt).toISOString().slice(0, 10).replace(/-/g, '/');
                            const { data: outsideSearch } = await gmail.users.messages.list({
                                userId: 'me',
                                q: `from:${vendorDomain} after:${sendDateStr} -label:PO`,
                                maxResults: 5,
                            });
                            for (const outsideMsg of outsideSearch?.messages || []) {
                                if (outsideMsg.threadId === m.threadId) continue;
                                // DEDUP: Skip messages we've already alerted on (persisted across restarts)
                                if (this.seenOutsideThreadMsgIds.has(outsideMsg.id!)) continue;
                                const { data: msgData } = await gmail.users.messages.get({
                                    userId: 'me', id: outsideMsg.id!, format: 'metadata',
                                    metadataHeaders: ['Subject', 'From'],
                                });
                                const snippet = msgData.snippet || '';
                                const hasEta = /ship|eta|tracking|dispatch|deliver|expect/i.test(snippet);
                                const outsideTracking: string[] = [];
                                for (const [carrier, regex] of Object.entries(TRACKING_PATTERNS)) {
                                    const match = snippet.match(regex);
                                    if (!match) continue;
                                    const t = carrier === 'generic' ? match[2] : match[0];
                                    if (t) outsideTracking.push(t);
                                }
                                if (hasEta || outsideTracking.length > 0) {
                                    // Mark as seen BEFORE sending to prevent duplicates on concurrent runs
                                    this.seenOutsideThreadMsgIds.add(outsideMsg.id!);
                                    // Persist to Supabase so restarts don't re-alert
                                    supabase.from('outside_thread_alerts').upsert({
                                        gmail_message_id: outsideMsg.id!,
                                        po_number: poNumber,
                                        vendor_name: vendorName,
                                        created_at: new Date().toISOString(),
                                    }, { onConflict: 'gmail_message_id' }).then(() => { }).catch(() => { });

                                    const outsideSubject = msgData.payload?.headers?.find((h: any) => h.name === 'Subject')?.value || '(no subject)';
                                    this.bot.telegram.sendMessage(
                                        process.env.TELEGRAM_CHAT_ID || "",
                                        `📧 Found <b>${vendorName}</b> email outside PO thread\nPO #${poNumber} | Subject: ${outsideSubject}\n"${snippet.slice(0, 250)}"`,
                                        { parse_mode: "HTML" }
                                    );
                                    if (outsideTracking.length > 0) {
                                        const merged = [...new Set([...trackingNumbers, ...outsideTracking])];
                                        await supabase.from("purchase_orders").upsert({
                                            po_number: poNumber,
                                            tracking_numbers: merged,
                                            updated_at: new Date().toISOString(),
                                        }, { onConflict: "po_number" });
                                    }
                                }
                            }
                        } catch (e: any) {
                            console.warn(`[po-sync] Outside-thread search failed for ${vendorDomain}: ${e.message}`);
                        }
                    }
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
    /**
     * On startup, pre-populate the dedup Sets so a bot restart doesn't re-alert
     * on completions/receivings that already fired in the current session.
     *
     * Builds: query `build_completions` for the last 2 hours.
     * POs:    query Finale for today's received POs (low volume, safe to re-query).
     */
    private async hydrateSeenSets(): Promise<void> {
        // Hydrate build completions: load today's completions from Supabase (midnight MT → now)
        // Using today rather than 2h prevents re-alerting after a mid-day restart.
        try {
            const db = createClient();
            if (db) {
                const todayMidnight = new Date();
                todayMidnight.setHours(0, 0, 0, 0);  // local midnight — conservative, always earlier than MT midnight
                const since = todayMidnight.toISOString();
                const { data } = await db
                    .from('build_completions')
                    .select('build_id')
                    .gte('created_at', since);
                if (data) {
                    for (const row of data) this.seenCompletedBuildIds.add(row.build_id);
                    console.log(`[ops-manager] Hydrated ${data.length} recent build completions into dedup set.`);
                }
            }
        } catch (err: any) {
            console.warn('[ops-manager] Build completions hydration failed:', err.message);
        }

        // Hydrate PO receivings: load today's received PO IDs from Finale
        try {
            const finale = new FinaleClient();
            const todayPOs = await finale.getTodaysReceivedPOs();
            for (const po of todayPOs) this.seenReceivedPOIds.add(po.orderId);
            console.log(`[ops-manager] Hydrated ${todayPOs.length} today's received POs into dedup set.`);
        } catch (err: any) {
            console.warn('[ops-manager] PO receivings hydration failed:', err.message);
        }

        // Hydrate outside-thread email dedup: load recently alerted message IDs from Supabase
        try {
            const db = createClient();
            if (db) {
                const { data } = await db
                    .from('outside_thread_alerts')
                    .select('gmail_message_id')
                    .gte('created_at', new Date(Date.now() - 14 * 86_400_000).toISOString());
                if (data) {
                    for (const row of data) this.seenOutsideThreadMsgIds.add(row.gmail_message_id);
                    console.log(`[ops-manager] Hydrated ${data.length} outside-thread alerts into dedup set.`);
                }
            }
        } catch (err: any) {
            console.warn('[ops-manager] Outside-thread alerts hydration failed:', err.message);
        }
    }

    /**
     * Poll Finale for today's newly-received purchase orders (runs every 30 min).
     * Sends a Telegram notification for each PO not previously seen.
     * Deduplication via `seenReceivedPOIds` (hydrated from Finale on startup).
     */
    async pollPOReceivings(): Promise<void> {
        try {
            const finale = new FinaleClient();
            const received = await finale.getTodaysReceivedPOs();

            for (const po of received) {
                if (this.seenReceivedPOIds.has(po.orderId)) continue;
                this.seenReceivedPOIds.add(po.orderId);

                const itemCount = po.items.reduce((s, i) => s + i.quantity, 0);
                const skuList = po.items
                    .slice(0, 5)
                    .map(i => `\`${i.productId}\``)
                    .join(', ');
                const moreItems = po.items.length > 5 ? ` +${po.items.length - 5} more` : '';

                const msg =
                    `📦 *PO Received*\n` +
                    `PO: \`${po.orderId}\`  |  Supplier: ${po.supplier}\n` +
                    `Units: ${itemCount.toLocaleString()}  |  Value: $${po.total.toLocaleString()}\n` +
                    `SKUs: ${skuList}${moreItems}`;

                this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID || '',
                    msg,
                    { parse_mode: 'Markdown' }
                ).catch((e: any) => console.warn('[po-watcher] Telegram send failed:', e.message));

                // Update the purchasing calendar event for this PO (best-effort)
                setImmediate(async () => {
                    try {
                        const supabase = createClient();
                        if (!supabase) return;
                        const { data: calRow } = await supabase
                            .from('purchasing_calendar_events')
                            .select('event_id, calendar_id')
                            .eq('po_number', po.orderId)
                            .single();
                        if (!calRow) return;

                        const receivedDate = po.receiveDate
                            ? new Date(po.receiveDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                            : new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

                        const title = `✅ PO #${po.orderId} — ${po.supplier}`;
                        const itemLines = po.items.slice(0, 5)
                            .map(i => `${i.productId} × ${i.quantity.toLocaleString()}`)
                            .join('\n');
                        const moreStr = po.items.length > 5 ? `\n+ ${po.items.length - 5} more` : '';
                        const description =
                            `Ordered: ${po.orderDate ? new Date(po.orderDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown'} | Received: ${receivedDate}\n` +
                            `Items:\n${itemLines}${moreStr}\n` +
                            `Total: $${po.total.toLocaleString()}\n` +
                            `Status: Received\n` +
                            `→ <a href="${po.finaleUrl}">PO# ${po.orderId}</a>`;

                        const calendar = new CalendarClient();
                        await calendar.updateEventTitleAndDescription(calRow.calendar_id, calRow.event_id, title, description);

                        await supabase.from('purchasing_calendar_events')
                            .update({ status: 'received', updated_at: new Date().toISOString() })
                            .eq('po_number', po.orderId);

                        console.log(`📅 [po-watcher] Calendar event updated for PO ${po.orderId}`);
                    } catch (e: any) {
                        console.warn('[po-watcher] Calendar update failed:', e.message);
                    }
                });

                console.log(`📦 [po-watcher] PO received: ${po.orderId} from ${po.supplier} (${itemCount} units)`);
            }
        } catch (err: any) {
            console.error('[po-watcher] pollPOReceivings error:', err.message);
        }
    }

    /**
     * Poll Finale for recently completed build orders (runs every 30 min).
     *
     * On completion detected:
     *   1. Sends a Telegram notification to Will
     *   2. Appends "✅ Completed: [timestamp]" to the matching Google Calendar event description
     *
     * Calendar writes are best-effort — description-only PATCH, no color/title changes.
     * Finale endpoint discovery is required; see src/cli/test-finale-builds.ts.
     */
    async pollBuildCompletions() {
        try {
            const finale = new FinaleClient();
            const since = new Date(Date.now() - 31 * 60 * 1000); // 31 min ago (overlaps slightly to avoid gaps)
            const completed = await finale.getRecentlyCompletedBuilds(since);

            if (completed.length === 0) return;

            // Fetch calendar builds once so we can match by SKU + date
            const calendar = new CalendarClient();
            const parser = new BuildParser();
            const events = await calendar.getAllUpcomingBuilds(60); // wider window — build may be today
            const parsedBuilds = await parser.extractBuildPlan(events);

            for (const build of completed) {
                if (this.seenCompletedBuildIds.has(build.buildId)) continue;
                this.seenCompletedBuildIds.add(build.buildId);

                const completedAt = new Date(build.completedAt);
                const timeStr = completedAt.toLocaleString('en-US', {
                    month: 'short', day: 'numeric',
                    hour: 'numeric', minute: '2-digit',
                    timeZone: 'America/Denver',
                });

                // Match to a calendar event (same SKU, within ±1 day of build date)
                const buildDate = completedAt.toISOString().split('T')[0];
                const matched = parsedBuilds.find(p =>
                    p.sku === build.sku &&
                    p.eventId !== null &&
                    Math.abs(new Date(p.buildDate).getTime() - completedAt.getTime()) < 2 * 86400000
                );

                // Build the Finale deep-link URL for this build
                const accountPath = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
                // VERIFIED(2026-03-04): buildUrl comes from GraphQL; Finale route uses build/view/build/{base64}
                const buildApiPath = build.buildUrl || `/${accountPath}/api/workeffort/${build.buildId}`;
                const finaleUrl = `https://app.finaleinventory.com/${accountPath}/sc2/?build/view/build/${Buffer.from(buildApiPath).toString('base64')}`;

                if (matched?.eventId && matched.calendarId) {
                    const scheduledQty = matched.quantity;
                    let completionNote: string;
                    if (scheduledQty && scheduledQty !== build.quantity) {
                        const pct = Math.round((build.quantity / scheduledQty) * 100);
                        // 🟡 partial if under scheduled, ✅ if met or exceeded
                        const icon = build.quantity < scheduledQty ? '🟡' : '✅';
                        completionNote = `${icon} Completed: ${timeStr} — ${build.quantity.toLocaleString()} of ${scheduledQty.toLocaleString()} scheduled (${pct}%)`;
                    } else {
                        completionNote = `✅ Completed: ${timeStr} (${build.quantity.toLocaleString()} units)`;
                    }
                    completionNote += `\n→ <a href="${finaleUrl}">Build #${build.buildId}</a>`;
                    await calendar.appendToEventDescription(
                        matched.calendarId,
                        matched.eventId,
                        completionNote
                    );
                }

                // Persist to Supabase so the dashboard shows the completion indicator
                setImmediate(async () => {
                    const db = createClient();
                    if (!db) return;
                    await db.from('build_completions').upsert({
                        build_id: build.buildId,
                        sku: build.sku,
                        quantity: build.quantity,
                        completed_at: build.completedAt,
                        calendar_event_id: matched?.eventId ?? null,
                        calendar_id: matched?.calendarId ?? null,
                    }, { onConflict: 'build_id', ignoreDuplicates: true });
                });

                // DECISION(2026-03-04): Removed the separate MFG calendar event creation.
                // Build completions are now annotated directly onto the existing build plan
                // event (above) to avoid duplicate entries on the same calendar day.

                console.log(`✅ [build-watcher] Build complete: ${build.sku} × ${build.quantity} @ ${timeStr}`);
            }
        } catch (err: any) {
            console.error('[build-watcher] pollBuildCompletions error:', err.message);
        }
    }

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

            // Restock detection: compare today's risk vs yesterday's snapshot.
            // Any component that was CRITICAL/WARNING and is now OK → send Telegram
            // alert and append a note to the affected calendar events.
            setImmediate(async () => {
                const { getLastSnapshot, saveBuildRiskSnapshot } = await import('../builds/build-risk-logger');
                const lastSnapshot = await getLastSnapshot();

                if (lastSnapshot) {
                    const restocked: string[] = [];
                    for (const [sku, demand] of report.components.entries()) {
                        const prev = lastSnapshot[sku];
                        if (prev && (prev.riskLevel === 'CRITICAL' || prev.riskLevel === 'WARNING') && demand.riskLevel === 'OK') {
                            restocked.push(sku);
                        }
                    }

                    if (restocked.length > 0) {
                        // Telegram alert
                        const restockMsg = `✅ *Component Restock Alert*\n` +
                            restocked.map(sku => `• \`${sku}\` — back in stock, was ${lastSnapshot[sku].riskLevel}`).join('\n') +
                            `\n_Affected builds are no longer blocked by these components._`;
                        this.bot.telegram.sendMessage(
                            process.env.TELEGRAM_CHAT_ID || '',
                            restockMsg,
                            { parse_mode: 'Markdown' }
                        ).catch((e: any) => console.warn('[restock] Telegram send failed:', e.message));

                        // Calendar description write-back for each affected build event
                        const calClient = new CalendarClient();
                        const parser = new BuildParser();
                        const events = await calClient.getAllUpcomingBuilds(60);
                        const parsedBuilds = await parser.extractBuildPlan(events);
                        const today = new Date().toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver'
                        });

                        for (const sku of restocked) {
                            const demand = report.components.get(sku);
                            if (!demand) continue;
                            // `usedIn` contains finished-good SKUs that use this raw component
                            for (const fgSku of demand.usedIn) {
                                const build = parsedBuilds.find(p => p.sku === fgSku && p.eventId !== null);
                                if (build?.eventId && build.calendarId) {
                                    await calClient.appendToEventDescription(
                                        build.calendarId,
                                        build.eventId,
                                        `✅ ${sku} replenished — Build now Green (${today})`
                                    );
                                }
                            }
                        }
                    }
                }

                // ── Blocked-build calendar annotations ──
                // DECISION(2026-03-04): For each CRITICAL/WARNING component, annotate
                // the affected calendar build events with a concise warning showing the
                // blocking component, any PO on order + ETA, and whether it arrives in
                // time. Zero LLM tokens. Deduped via proactive_alerts so we don't
                // re-annotate the same build for the same shortage every day.
                try {
                    const cal = new CalendarClient();
                    const bp = new BuildParser();
                    const ev = await cal.getAllUpcomingBuilds(60);
                    const builds = await bp.extractBuildPlan(ev);
                    const todayLabel = new Date().toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver',
                    });

                    // Dedup: check which (componentSku, buildEventId) pairs we've already annotated
                    const db = createClient();
                    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                    const { data: recentAlerts } = db
                        ? await db.from('proactive_alerts').select('sku,risk_level').gte('alerted_at', cutoff24h)
                        : { data: [] };
                    const alertedSet = new Set((recentAlerts ?? []).map((r: any) => `${r.sku}:${r.risk_level}`));

                    const atRisk = Array.from(report.components.entries()).filter(
                        ([, d]) => d.riskLevel === 'CRITICAL' || d.riskLevel === 'WARNING'
                    );

                    let annotated = 0;
                    for (const [compSku, demand] of atRisk) {
                        // Skip if we already annotated this component today
                        if (alertedSet.has(`${compSku}:cal-block`)) continue;

                        for (const fgSku of demand.usedIn) {
                            const build = builds.find(p => p.sku === fgSku && p.eventId !== null);
                            if (!build?.eventId || !build.calendarId) continue;

                            // ── Build the annotation ──
                            const icon = demand.riskLevel === 'CRITICAL' ? '🔴' : '🟡';
                            const daysLabel = demand.stockoutDays !== null
                                ? `${demand.stockoutDays}d to stockout`
                                : 'low stock';

                            let note = `${icon} ${compSku} — ${daysLabel}`;

                            if (demand.incomingPOs.length > 0) {
                                const po = demand.incomingPOs[0]; // most relevant PO
                                // Estimate arrival: orderDate + leadTimeDays
                                let etaStr = '';
                                let arrivesBefore = false;
                                if (demand.leadTimeDays !== null && po.orderDate) {
                                    const orderMs = new Date(po.orderDate).getTime();
                                    const etaMs = orderMs + demand.leadTimeDays * 86400000;
                                    const eta = new Date(etaMs);
                                    etaStr = eta.toLocaleDateString('en-US', {
                                        month: 'short', day: 'numeric', timeZone: 'America/Denver',
                                    });
                                    const buildMs = new Date(build.buildDate + 'T12:00:00').getTime();
                                    arrivesBefore = etaMs <= buildMs;
                                }

                                const poLabel = `PO#${po.orderId} from ${po.supplier} (${po.quantity.toLocaleString()} units)`;
                                if (etaStr) {
                                    note += `\n   ${arrivesBefore ? '✅' : '⚠️'} ${poLabel} ETA ~${etaStr}`;
                                    if (!arrivesBefore) {
                                        const buildMs = new Date(build.buildDate + 'T12:00:00').getTime();
                                        const etaMs = new Date(po.orderDate).getTime() + (demand.leadTimeDays ?? 0) * 86400000;
                                        const daysLate = Math.ceil((etaMs - buildMs) / 86400000);
                                        note += ` — arrives ~${daysLate}d after build`;
                                    }
                                } else {
                                    note += `\n   📦 ${poLabel} on order`;
                                }

                                if (demand.incomingPOs.length > 1) {
                                    note += ` (+${demand.incomingPOs.length - 1} more PO${demand.incomingPOs.length > 2 ? 's' : ''})`;
                                }
                            } else {
                                note += '\n   ⛔ No PO on order';
                            }

                            note += ` (${todayLabel})`;

                            await cal.appendToEventDescription(build.calendarId, build.eventId, note);
                            annotated++;
                        }

                        // Mark as annotated so we don't repeat tomorrow
                        if (db) {
                            await db.from('proactive_alerts').upsert({
                                sku: compSku,
                                alert_type: 'cal-block',
                                risk_level: 'cal-block',
                                stockout_days: demand.stockoutDays,
                                alerted_at: new Date().toISOString(),
                            }, { onConflict: 'sku,alert_type' });
                        }
                    }

                    if (annotated > 0) {
                        console.log(`📅 [build-risk] Annotated ${annotated} calendar event(s) with component shortage warnings.`);
                    }
                } catch (err: any) {
                    console.warn('[build-risk] Calendar block annotation failed (non-fatal):', err.message);
                }

                await saveBuildRiskSnapshot(report);

                // Smart reorder prescriptions — fires as a follow-up Telegram message.
                // Deduped: only sends if (sku, 'reorder') hasn't been alerted in the last 20 hours.
                try {
                    const { generateReorderPrescriptions, formatPrescriptionsTelegram } = await import('../builds/reorder-engine');
                    const prescriptions = await generateReorderPrescriptions(report.components, report.fgVelocity);
                    if (prescriptions.length > 0) {
                        const db = createClient();
                        const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
                        const { data: recent } = db
                            ? await db.from('proactive_alerts').select('sku,risk_level').gte('alerted_at', cutoff)
                            : { data: [] };
                        const recentSet = new Set((recent ?? []).map((r: any) => `${r.sku}:${r.risk_level}`));
                        const fresh = prescriptions.filter(p => !recentSet.has(`${p.componentSku}:${p.riskLevel}`));
                        if (fresh.length > 0) {
                            const msg = formatPrescriptionsTelegram(fresh);
                            this.bot.telegram.sendMessage(
                                process.env.TELEGRAM_CHAT_ID || '',
                                msg,
                                { parse_mode: 'Markdown' }
                            ).catch((e: any) => console.warn('[prescriptions] Telegram failed:', e.message));
                            if (db) {
                                await db.from('proactive_alerts').upsert(
                                    fresh.map(p => ({
                                        sku: p.componentSku,
                                        alert_type: 'reorder',
                                        risk_level: p.riskLevel,
                                        stockout_days: p.stockoutDays,
                                        suggested_order_qty: p.suggestedOrderQty,
                                        days_after_order: p.daysAfterOrder,
                                        alerted_at: new Date().toISOString(),
                                    })),
                                    { onConflict: 'sku,alert_type' }
                                );
                            }
                            console.log(`🧠 [reorder] Sent ${fresh.length} prescription${fresh.length > 1 ? 's' : ''}.`);
                        }
                    }
                } catch (err: any) {
                    console.warn('[reorder] prescription engine failed (non-fatal):', err.message);
                }
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

    // ──────────────────────────────────────────────────
    // PURCHASING CALENDAR SYNC
    // ──────────────────────────────────────────────────

    /**
     * Build the status emoji prefix for a PO based on its Finale status string.
     */
    private poStatusEmoji(status: string): string {
        const s = (status || '').toLowerCase();
        if (s === 'completed') return '✅';
        if (s === 'cancelled') return '❌';
        return '🔜';
    }

    /**
     * Format a YYYY-MM-DD or ISO date string as "Mar 3, 2026".
     */
    private fmtDate(dateStr: string | null | undefined): string {
        if (!dateStr) return 'Unknown';
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    /**
     * Add N calendar days to a YYYY-MM-DD string, returns YYYY-MM-DD.
     */
    private addDays(dateStr: string, days: number): string {
        const d = new Date(dateStr);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().split('T')[0];
    }

    /**
     * Build the calendar event title for a PO.
     */
    private buildPOEventTitle(po: FullPO): string {
        const emoji = this.poStatusEmoji(po.status);
        return `${emoji} PO #${po.orderId} — ${po.vendorName}`;
    }

    /**
     * Build the calendar event description for a PO.
     */
    private buildPOEventDescription(
        po: FullPO,
        expectedDate: string,
        leadProvenance: string
    ): string {
        const isReceived = (po.status || '').toLowerCase() === 'completed';
        const isCancelled = (po.status || '').toLowerCase() === 'cancelled';

        const lines: string[] = [];

        if (isReceived && po.receiveDate) {
            // Compute on-time vs late
            const expectedMs = new Date(expectedDate).getTime();
            const actualMs = new Date(po.receiveDate).getTime();
            const diff = Math.round((actualMs - expectedMs) / 86_400_000);
            const timing = diff === 0 ? 'on time' : diff > 0 ? `${diff}d late` : `${Math.abs(diff)}d early`;
            lines.push(`Ordered: ${this.fmtDate(po.orderDate)} | Received: ${this.fmtDate(po.receiveDate)} (${timing})`);
        } else {
            lines.push(`Ordered: ${this.fmtDate(po.orderDate)}`);
            if (!isCancelled) {
                lines.push(`Expected: ${this.fmtDate(expectedDate)} (${leadProvenance})`);
            }
        }

        // Line items — max 5 + overflow count
        const itemLines = po.items.slice(0, 5).map(i => `${i.productId} × ${i.quantity.toLocaleString()}`);
        if (po.items.length > 5) itemLines.push(`+ ${po.items.length - 5} more`);
        lines.push(`Items: ${itemLines.join(', ')}`);

        lines.push(`Total: $${po.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

        const statusLabel = isReceived ? 'Received' : isCancelled ? 'Cancelled' : 'In Transit';
        lines.push(`Status: ${statusLabel}`);
        lines.push(`→ <a href="${po.finaleUrl}">PO# ${po.orderId}</a>`);

        return lines.join('\n');
    }

    /**
     * Sync all recent purchase orders to the purchasing Google Calendar.
     * - Creates a new all-day event (on the expected arrival date) for each new PO
     * - Updates the event title/description in place when status changes
     * - Expected arrival date: Finale's deliverDate → vendor median lead time → 14d default
     *
     * Runs every 4 hours via cron. Also called by the backfill script.
     * Never throws — all errors are logged and swallowed.
     */
    async syncPurchasingCalendar(daysBack: number = 7): Promise<{ created: number; updated: number; skipped: number }> {
        const counts = { created: 0, updated: 0, skipped: 0 };
        try {
            const finale = new FinaleClient();
            const supabase = createClient();
            if (!supabase) {
                console.warn('[cal-sync] Supabase unavailable — skipping purchasing calendar sync');
                return counts;
            }

            // Warm the shared lead time cache + fetch POs in parallel
            const [pos] = await Promise.all([
                finale.getRecentPurchaseOrders(daysBack),
                leadTimeService.warmCache(),
            ]);

            if (pos.length === 0) {
                console.log('[cal-sync] No recent POs found');
                return counts;
            }

            // Load existing Supabase rows into a Map for O(1) lookup
            const { data: existingRows } = await supabase
                .from('purchasing_calendar_events')
                .select('po_number, event_id, calendar_id, status');
            const existing = new Map<string, { event_id: string; calendar_id: string; status: string }>();
            for (const row of existingRows ?? []) {
                existing.set(row.po_number, row);
            }

            const calendar = new CalendarClient();

            for (const po of pos) {
                if (!po.orderId) continue;
                // Skip dropship POs — they're pass-through orders, not BuildASoil inventory
                if (po.orderId.toLowerCase().includes('dropship')) continue;
                // Only show committed or received — skip drafts and cancelled
                if (!['committed', 'completed'].includes((po.status || '').toLowerCase())) continue;

                // Determine expected arrival date.
                // NOTE: Finale's dueDate is payment terms (Net 30 etc), NOT delivery estimate — ignored.
                // Priority: vendor history median (≥3 completed POs) → 14d global default.
                let expectedDate: string;
                let leadProvenance: string;

                if (po.orderDate) {
                    const lt = await leadTimeService.getForVendor(po.vendorName);
                    expectedDate = this.addDays(po.orderDate, lt.days);
                    leadProvenance = lt.label;
                } else {
                    expectedDate = new Date().toISOString().split('T')[0];
                    leadProvenance = '14d default';
                }

                const title = this.buildPOEventTitle(po);
                const description = this.buildPOEventDescription(po, expectedDate, leadProvenance);
                const newStatus = (po.status || '').toLowerCase() === 'completed' ? 'received'
                    : (po.status || '').toLowerCase() === 'cancelled' ? 'cancelled'
                        : 'open';

                const existingRow = existing.get(po.orderId);

                if (!existingRow) {
                    // New PO — create calendar event
                    try {
                        const eventId = await calendar.createEvent(PURCHASING_CALENDAR_ID, {
                            title,
                            description,
                            date: expectedDate,
                        });
                        await supabase.from('purchasing_calendar_events').insert({
                            po_number: po.orderId,
                            event_id: eventId,
                            calendar_id: PURCHASING_CALENDAR_ID,
                            status: newStatus,
                        });
                        counts.created++;
                        console.log(`📅 [cal-sync] Created event for PO #${po.orderId} (${po.vendorName}) on ${expectedDate}`);
                    } catch (e: any) {
                        console.warn(`[cal-sync] Could not create event for PO #${po.orderId}: ${e.message}`);
                    }
                } else if (existingRow.status !== newStatus) {
                    // Status changed — update in place
                    await calendar.updateEventTitleAndDescription(
                        existingRow.calendar_id,
                        existingRow.event_id,
                        title,
                        description
                    );
                    await supabase.from('purchasing_calendar_events')
                        .update({ status: newStatus, updated_at: new Date().toISOString() })
                        .eq('po_number', po.orderId);
                    counts.updated++;
                    console.log(`📅 [cal-sync] Updated event for PO #${po.orderId}: ${existingRow.status} → ${newStatus}`);
                } else {
                    counts.skipped++;
                }
            }

            console.log(`[cal-sync] Done — ${counts.created} created, ${counts.updated} updated, ${counts.skipped} skipped`);
        } catch (err: any) {
            console.error('[cal-sync] syncPurchasingCalendar error:', err.message);
        }
        return counts;
    }
}
