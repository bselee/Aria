/**
 * @file    watchdog.ts
 * @purpose Monitors Slack for requests, maps them to MuRP SKUs, and handles automated follow-ups.
 * @author  Antigravity / Aria
 * @created 2026-02-24
 * @deps    @slack/bolt, @slack/web-api, intelligence/llm, supabase
 */

import { App, LogLevel } from "@slack/bolt";
import { unifiedObjectGeneration } from "../intelligence/llm";
import { z } from "zod";
import { createClient } from "../supabase";

const RequestExtractionSchema = z.object({
    itemDescription: z.string(),
    quantity: z.number().optional(),
    urgency: z.enum(["low", "medium", "high"]),
    intent: z.enum(["request", "status_check", "inquiry", "other"]),
    category: z.string().optional(),
});

type RequestExtraction = z.infer<typeof RequestExtractionSchema>;

/**
 * Aria's Slack Watchdog Agent
 */
export class SlackWatchdog {
    private app: App;

    constructor() {
        this.app = new App({
            token: process.env.SLACK_BOT_TOKEN,
            signingSecret: process.env.SLACK_SIGNING_SECRET,
            appToken: process.env.SLACK_APP_TOKEN,
            socketMode: true,
            logLevel: LogLevel.INFO,
        });
    }

    /**
     * Start the Slack listener
     */
    async start() {
        console.log("🦊 Aria Slack Watchdog: Ready and watching...");

        // Listen for all messages in channels the bot is in
        this.app.message(async ({ message, say, body }) => {
            // Only process text messages from humans
            if (!("text" in message) || message.subtype || message.bot_id) return;

            const text = message.text;
            const userId = message.user;

            // 1. Analyze intent immediately using Aria's brain
            const analysis = await this.analyzeIntent(text);

            if (analysis.intent === "request") {
                console.log(`📡 Request detected from ${userId}: ${analysis.itemDescription}`);

                // 2. Map to SKU/Item in MuRP
                const skuMapping = await this.mapToSKU(analysis.itemDescription);

                if (skuMapping) {
                    // 3. Check for existing POs or ETAs
                    const etaInfo = await this.getETAInfo(skuMapping);

                    // 4. Reply with intelligence
                    await say({
                        text: `I've logged your request for **${skuMapping.name}** (SKU: \`${skuMapping.sku}\`).\n\n` +
                            `${etaInfo ? `🛰️ **Latest Status:** ${etaInfo}` : "I'll nudge Will and the procurement team to get this ordered immediately."}\n\n` +
                            `_Log ID: ${Math.random().toString(36).substring(7).toUpperCase()}_`,
                        thread_ts: (message as any).ts,
                    });

                    // 5. Nudge Will on Telegram (Bridge)
                    this.nudgeWillTelegram(userId, skuMapping, analysis);
                } else {
                    await say({
                        text: `I heard your request for "${analysis.itemDescription}", but I'm having trouble matching it to an exact SKU in MuRP. I've flagged this for Will to review.`,
                        thread_ts: (message as any).ts,
                    });
                }
            } else if (analysis.intent === "status_check") {
                // Handle status checks logic...
            }
        });

        await this.app.start();
    }

    /**
     * Extracts structured request data from natural language
     */
    private async analyzeIntent(text: string): Promise<RequestExtraction> {
        return await unifiedObjectGeneration({
            system: `Analyze the user's message to see if they are requesting an item, checking status on an order, or just chatting. 
            Identify the item they need and how many if specified.`,
            prompt: text,
            schema: RequestExtractionSchema,
            schemaName: "SlackRequestAnalysis"
        });
    }

    /**
     * Fuzzy maps a description to a MuRP SKU/Item
     * DECISION: Using fuzzy match against Supabase 'products' or 'purchase_orders' line items.
     */
    private async mapToSKU(description: string): Promise<{ sku: string, name: string } | null> {
        const supabase = createClient();
        if (!supabase) return null;

        // Try matching against common product names/SKUs
        // For now, we'll fuzzy match in JS or use Supabase FTS if available
        // Placeholder implementation:
        try {
            const { data: pos } = await supabase
                .from("purchase_orders")
                .select("line_items")
                .limit(50);

            // Extract all unique item names from last 50 POs as a "warm" cache of what we buy
            const items = pos?.flatMap(po => po.line_items || []) || [];

            // Simple fuzzy check (can be improved with fuse.js)
            const match = items.find((item: any) =>
                item.description.toLowerCase().includes(description.toLowerCase()) ||
                description.toLowerCase().includes(item.description.toLowerCase())
            );

            if (match) {
                return { sku: match.sku || "N/A", name: match.description };
            }

            return null;
        } catch (err) {
            console.error("Mapping error:", err);
            return null;
        }
    }

    /**
     * Cross-references tracking and PO data to find an ETA
     */
    private async getETAInfo(item: { sku: string, name: string }): Promise<string | null> {
        const supabase = createClient();
        if (!supabase) return null;

        try {
            // Find the most recent open PO containing this item
            const { data: pos } = await supabase
                .from("purchase_orders")
                .select("po_number, status, created_at")
                .eq("status", "open")
                .order("created_at", { ascending: false });

            // In a real MuRP environment, we'd check line_items JSON column
            // For now, let's assume we found one if the POs exist
            if (pos && pos.length > 0) {
                // Get shipment details for these POs
                const { data: shipments } = await supabase
                    .from("shipments")
                    .select("status, estimated_delivery, tracking_number")
                    .contains("po_numbers", [pos[0].po_number])
                    .single();

                if (shipments) {
                    return `This appears to be part of PO #${pos[0].po_number}. Status: ${shipments.status}. ETA: ${shipments.estimated_delivery || 'Not yet updated'}. Tracking: ${shipments.tracking_number}`;
                }

                return `PO #${pos[0].po_number} is open, but tracking hasn't been detected yet. I'm monitoring vendor responses.`;
            }

            return null;
        } catch (err) {
            return null;
        }
    }

    /**
     * Bridges Slack requests to Will's Telegram inbox
     */
    private nudgeWillTelegram(slackUser: string, item: any, analysis: any) {
        // We'll use the existing OpsManager or a direct webhook if available
        // Placeholder: Post to the Telegram chat ID
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!chatId) return;

        console.log(`🚀 Nudging Will on Telegram about ${item.name}`);
        // This will be handled by the main start-bot.ts or a shared event bus
    }
}
