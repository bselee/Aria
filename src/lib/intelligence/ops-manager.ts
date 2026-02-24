/**
 * @file    ops-manager.ts
 * @purpose Handles background operations: PO tracking, email filtering, and summaries.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-02-20
 * @deps    googleapis, node-cron, telegraf
 */

import { google } from "googleapis";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import cron from "node-cron";
import { Telegraf } from "telegraf";
import { SYSTEM_PROMPT } from "../../config/persona";
import { indexOperationalContext } from "./pinecone";
import { unifiedTextGeneration } from "./llm";

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

    constructor(bot: Telegraf) {
        this.bot = bot;
    }

    /**
     * Start all scheduled tasks
     */
    start() {
        console.log("🚀 Starting Ops Manager Scheduler...");

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
     * Generate and send the daily summary
     */
    async sendDailySummary() {
        console.log("📊 Preparing Daily PO Summary...");
        const poData = await this.getPOStatsForTimeframe("yesterday");

        const summary = await this.generateLLMSummary("Daily", poData);

        this.bot.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID || "",
            `📊 **Morning Operations Summary**\n\n${summary}`,
            { parse_mode: "Markdown" }
        );
    }

    /**
     * Generate and send the weekly summary (Friday)
     */
    async sendWeeklySummary() {
        console.log("📅 Preparing Weekly PO Summary...");
        const poData = await this.getPOStatsForTimeframe("week");

        const summary = await this.generateLLMSummary("Weekly", poData);

        this.bot.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID || "",
            `🗓️ **Friday Weekly Operations Review**\n\n${summary}`,
            { parse_mode: "Markdown" }
        );
    }

    private async getPOStatsForTimeframe(timeframe: "yesterday" | "week") {
        const supabase = createClient();
        const date = new Date();
        if (timeframe === "yesterday") date.setDate(date.getDate() - 1);
        else date.setDate(date.getDate() - 7);

        try {
            const { data: pos } = await supabase
                .from("purchase_orders")
                .select("*")
                .gte("issue_date", date.toISOString().split("T")[0]);

            return pos || [];
        } catch (err) {
            return [];
        }
    }

    private async generateLLMSummary(title: string, data: any[]) {
        if (!data.length) return "No POs processed in this timeframe.";

        const prompt = `Summarize the following PO activity for the ${title} report. 
        Focus on total spend, vendors contacted, and highlight any slow vendor responses.
        Data: ${JSON.stringify(data.slice(0, 10))}`;

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
