/**
 * @file    watchdog.ts
 * @purpose Monitors Will's Slack for product/SKU requests from individual users.
 *          Laser-focused on detecting when someone needs something ordered.
 *          Uses fuzzy matching (Fuse.js) against known products from PO history.
 *          Cross-references active POs for instant ETA lookups.
 *          Reports actionable findings to Will on Telegram.
 * @author  Antigravity / Aria
 * @created 2026-02-24
 * @updated 2026-02-24
 * @deps    @slack/web-api, fuse.js, intelligence/llm, supabase, axios
 */

import { WebClient } from "@slack/web-api";
import { unifiedObjectGeneration } from "../intelligence/llm";
import { z } from "zod";
import { createClient } from "../supabase";
import axios from "axios";
import Fuse from "fuse.js";

// ──────────────────────────────────────────────────
// SCHEMAS
// ──────────────────────────────────────────────────

const RequestExtractionSchema = z.object({
    isProductRequest: z.boolean().describe("True ONLY if someone is asking for a product, material, supply, or inventory item to be ordered, restocked, or procured"),
    itemDescription: z.string().describe("The product, material, or supply being requested — use the most specific name possible"),
    quantity: z.number().optional().describe("How many units requested, if mentioned"),
    urgency: z.enum(["low", "medium", "high"]).describe("low = general mention, medium = clearly needs it, high = urgent/ASAP language"),
    confidence: z.number().min(0).max(1).describe("How confident you are this is a real product request (0.0-1.0)"),
    requesterIntent: z.string().describe("One sentence summary of what the person actually needs"),
});

type RequestExtraction = z.infer<typeof RequestExtractionSchema>;

// Known product from PO history or catalog
interface KnownProduct {
    name: string;
    sku: string;
    vendor?: string;
    lastOrdered?: string;
}

// A detected request ready for reporting
interface DetectedRequest {
    channel: string;
    channelId: string;
    userId: string;
    userName: string;
    originalText: string;
    analysis: RequestExtraction;
    matchedProduct: KnownProduct | null;
    matchScore: number;
    activePO: string | null;
    eta: string | null;
    timestamp: string;
}

// ──────────────────────────────────────────────────
// WATCHDOG
// ──────────────────────────────────────────────────

export class SlackWatchdog {
    private client: WebClient;
    private lastChecked: Map<string, string> = new Map();
    private channelNames: Map<string, string> = new Map();
    private userNames: Map<string, string> = new Map(); // userId -> display name
    private productCatalog: KnownProduct[] = [];
    private fuse: Fuse<KnownProduct> | null = null;
    private pendingRequests: DetectedRequest[] = []; // buffer for batch reporting
    private pollIntervalMs: number;

    constructor(pollIntervalSeconds: number = 60) {
        const token = process.env.SLACK_ACCESS_TOKEN;
        if (!token) throw new Error("SLACK_ACCESS_TOKEN is required");

        this.client = new WebClient(token);
        this.pollIntervalMs = pollIntervalSeconds * 1000;
    }

    // ──────────────────────────────────────────────────
    // LIFECYCLE
    // ──────────────────────────────────────────────────

    async start() {
        console.log("🦊 Aria Slack Watchdog v2: SILENT MONITOR mode");
        console.log(`📡 Polling every ${this.pollIntervalMs / 1000}s`);

        // 1. Build product catalog from PO history
        await this.buildProductCatalog();

        // 2. Discover channels
        await this.discoverChannels();

        // 3. First poll — establish baseline (don't alert on old messages)
        await this.pollAllChannels();

        // 4. Start polling loop
        setInterval(async () => {
            try {
                await this.pollAllChannels();

                // Flush any pending requests to Telegram
                if (this.pendingRequests.length > 0) {
                    await this.sendDigestToTelegram();
                }
            } catch (err: any) {
                console.error("❌ Poll cycle error:", err.message);
            }
        }, this.pollIntervalMs);

        // 5. Refresh product catalog every 30 minutes
        setInterval(() => this.buildProductCatalog(), 30 * 60 * 1000);

        console.log("🦊 Aria Slack Watchdog: LIVE and hunting for requests.");
    }

    /**
     * Returns pending requests (for Telegram /requests command)
     */
    getRecentRequests(): DetectedRequest[] {
        return [...this.pendingRequests];
    }

    // ──────────────────────────────────────────────────
    // PRODUCT CATALOG (Fuzzy Matching Source)
    // ──────────────────────────────────────────────────

    /**
     * Builds a searchable product catalog from PO line item history.
     * This is Aria's "memory" of what BuildASoil buys.
     */
    private async buildProductCatalog() {
        const supabase = createClient();
        if (!supabase) {
            console.warn("⚠️ No Supabase connection — using empty catalog");
            return;
        }

        try {
            // Pull line items from recent POs
            const { data: pos } = await supabase
                .from("purchase_orders")
                .select("line_items, vendor_name, created_at")
                .order("created_at", { ascending: false })
                .limit(100);

            const seen = new Set<string>();
            const products: KnownProduct[] = [];

            for (const po of (pos || [])) {
                for (const item of (po.line_items || [])) {
                    const key = (item.sku || item.description || "").toLowerCase();
                    if (key && !seen.has(key)) {
                        seen.add(key);
                        products.push({
                            name: item.description || item.name || key,
                            sku: item.sku || "N/A",
                            vendor: po.vendor_name,
                            lastOrdered: po.created_at,
                        });
                    }
                }
            }

            this.productCatalog = products;

            // Build Fuse.js index for fuzzy search
            this.fuse = new Fuse(products, {
                keys: ["name", "sku"],
                threshold: 0.4,       // Tolerant fuzzy matching
                includeScore: true,
                minMatchCharLength: 3,
            });

            console.log(`📦 Product catalog loaded: ${products.length} unique items from PO history`);
        } catch (err: any) {
            console.warn("⚠️ Catalog build error:", err.message);
        }
    }

    /**
     * Fuzzy matches a description against the product catalog
     */
    private fuzzyMatch(description: string): { product: KnownProduct; score: number } | null {
        if (!this.fuse) return null;

        const results = this.fuse.search(description);
        if (results.length === 0) return null;

        const best = results[0];
        return {
            product: best.item,
            score: 1 - (best.score || 1), // Fuse score is 0=perfect, convert to 0-1 confidence
        };
    }

    // ──────────────────────────────────────────────────
    // CHANNEL DISCOVERY
    // ──────────────────────────────────────────────────

    private async discoverChannels() {
        const channelTypes = [
            { type: "public_channel", label: "Public Channels" },
            { type: "private_channel", label: "Private Channels" },
            { type: "im", label: "Direct Messages" },
        ];

        for (const { type, label } of channelTypes) {
            try {
                const result = await this.client.conversations.list({
                    types: type,
                    exclude_archived: true,
                    limit: 200,
                });

                let count = 0;
                for (const ch of (result.channels || [])) {
                    if (ch.is_member || ch.is_im) {
                        this.channelNames.set(ch.id!, ch.name || ch.id || "dm");
                        count++;
                    }
                }
                console.log(`  ✅ ${label}: ${count}`);
            } catch (err: any) {
                console.warn(`  ⚠️ ${label}: skipped (${err.data?.error || err.message})`);
            }
        }

        console.log(`📋 Monitoring ${this.channelNames.size} channels total`);
    }

    // ──────────────────────────────────────────────────
    // POLLING
    // ──────────────────────────────────────────────────

    private async pollAllChannels() {
        for (const [channelId, channelName] of this.channelNames) {
            try {
                await this.pollChannel(channelId, channelName);
            } catch (err: any) {
                if (!err.message?.includes("not_in_channel") && !err.message?.includes("channel_not_found")) {
                    // Silently skip non-critical errors
                }
            }
        }
    }

    private async pollChannel(channelId: string, channelName: string) {
        const oldest = this.lastChecked.get(channelId);

        const result = await this.client.conversations.history({
            channel: channelId,
            oldest: oldest || undefined,
            limit: 20,
        });

        const messages = result.messages || [];
        if (messages.length === 0) return;

        // Update bookmark
        const newestTs = messages[0]?.ts;
        if (newestTs) this.lastChecked.set(channelId, newestTs);

        // Skip first poll (baseline)
        if (!oldest) return;

        // Only human messages (no bots, no system)
        const humanMessages = messages.filter(
            (m) => m.type === "message" && !m.subtype && !m.bot_id && m.text && m.text.length > 10
        );

        for (const msg of humanMessages) {
            await this.processMessage(msg.text!, msg.user || "unknown", channelId, channelName);
        }
    }

    // ──────────────────────────────────────────────────
    // MESSAGE ANALYSIS
    // ──────────────────────────────────────────────────

    private async processMessage(text: string, userId: string, channelId: string, channelName: string) {
        // Step 1: LLM intent analysis — is this a product request?
        const analysis = await this.analyzeIntent(text);

        // Only proceed if the LLM is confident this is a real product request
        if (!analysis.isProductRequest || analysis.confidence < 0.6) return;

        console.log(`📡 [#${channelName}] Request detected (conf: ${analysis.confidence}): "${text.substring(0, 60)}..."`);

        // Step 2: Fuzzy match against product catalog
        const match = this.fuzzyMatch(analysis.itemDescription);

        // Step 3: Check for active POs if we have a match
        let activePO: string | null = null;
        let eta: string | null = null;

        if (match) {
            const poInfo = await this.checkActivePOs(match.product);
            activePO = poInfo?.poNumber || null;
            eta = poInfo?.eta || null;
        }

        // Step 4: Resolve user name
        const userName = await this.resolveUserName(userId);

        // Step 5: Queue the detected request
        const request: DetectedRequest = {
            channel: channelName,
            channelId,
            userId,
            userName,
            originalText: text,
            analysis,
            matchedProduct: match?.product || null,
            matchScore: match?.score || 0,
            activePO,
            eta,
            timestamp: new Date().toISOString(),
        };

        this.pendingRequests.push(request);
        console.log(`  → Queued for Telegram digest (${this.pendingRequests.length} pending)`);
    }

    private async analyzeIntent(text: string): Promise<RequestExtraction> {
        return await unifiedObjectGeneration({
            system: `You are Aria, analyzing Slack messages at BuildASoil (premium living soil & organic growing supply company).

Your ONLY job: determine if the message is someone requesting a product, material, or supply that needs ordering.

POSITIVE signals (mark as product request):
- "We need more X"
- "Can we order Y?"  
- "Running low on Z"
- "Are we out of [product]?"
- "I need [X] for [project]"
- "When is [product] coming in?"

NEGATIVE signals (NOT a product request):
- General status updates
- Questions about processes
- Social chat
- Technical discussions
- Meeting scheduling

Be STRICT. Only flag messages where someone clearly needs a physical product or supply.
Use the most specific product name possible in itemDescription.`,
            prompt: text,
            schema: RequestExtractionSchema,
            schemaName: "ProductRequestAnalysis",
            temperature: 0.1, // Low temperature for consistent classification
        });
    }

    // ──────────────────────────────────────────────────
    // PO CROSS-REFERENCE
    // ──────────────────────────────────────────────────

    private async checkActivePOs(product: KnownProduct): Promise<{ poNumber: string; eta: string | null } | null> {
        const supabase = createClient();
        if (!supabase) return null;

        try {
            // Find open POs
            const { data: pos } = await supabase
                .from("purchase_orders")
                .select("po_number, line_items, status, created_at")
                .eq("status", "open")
                .order("created_at", { ascending: false })
                .limit(20);

            if (!pos) return null;

            // Check if any open PO contains this product
            for (const po of pos) {
                const items = po.line_items || [];
                const hasItem = items.some((item: any) => {
                    const itemName = (item.description || item.name || "").toLowerCase();
                    const itemSku = (item.sku || "").toLowerCase();
                    const productName = product.name.toLowerCase();
                    const productSku = product.sku.toLowerCase();

                    return itemName.includes(productName) ||
                        productName.includes(itemName) ||
                        (productSku !== "n/a" && itemSku === productSku);
                });

                if (hasItem) {
                    // Check for shipment tracking
                    const { data: shipment } = await supabase
                        .from("shipments")
                        .select("status, estimated_delivery, tracking_number")
                        .contains("po_numbers", [po.po_number])
                        .single();

                    const eta = shipment
                        ? `${shipment.status} — ETA: ${shipment.estimated_delivery || "TBD"}`
                        : "No tracking yet";

                    return { poNumber: po.po_number, eta };
                }
            }

            return null;
        } catch (err) {
            return null;
        }
    }

    // ──────────────────────────────────────────────────
    // USER RESOLUTION
    // ──────────────────────────────────────────────────

    private async resolveUserName(userId: string): Promise<string> {
        if (this.userNames.has(userId)) return this.userNames.get(userId)!;

        try {
            const result = await this.client.users.info({ user: userId });
            const name = result.user?.real_name || result.user?.name || userId;
            this.userNames.set(userId, name);
            return name;
        } catch {
            return userId;
        }
    }

    // ──────────────────────────────────────────────────
    // TELEGRAM REPORTING
    // ──────────────────────────────────────────────────

    /**
     * Sends a batched digest of all pending requests to Will on Telegram.
     * Groups by urgency, includes PO status, and provides actionable next steps.
     */
    private async sendDigestToTelegram() {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!token || !chatId) return;

        const requests = this.pendingRequests;
        if (requests.length === 0) return;

        // Sort by urgency (high first)
        const urgencyOrder = { high: 0, medium: 1, low: 2 };
        requests.sort((a, b) => urgencyOrder[a.analysis.urgency] - urgencyOrder[b.analysis.urgency]);

        let message = `🦊 *Aria Slack Digest* — ${requests.length} request${requests.length > 1 ? "s" : ""} detected\n\n`;

        for (const req of requests) {
            const urgencyEmoji = req.analysis.urgency === "high" ? "🔴" :
                req.analysis.urgency === "medium" ? "🟡" : "🟢";

            const matchLine = req.matchedProduct
                ? `✅ Matched: \`${req.matchedProduct.sku}\` — ${req.matchedProduct.name}${req.matchedProduct.vendor ? ` (${req.matchedProduct.vendor})` : ""}`
                : `⚠️ No exact SKU match — may need manual lookup`;

            const poLine = req.activePO
                ? `📋 Active PO: #${req.activePO} — ${req.eta}`
                : `📭 No active PO found`;

            message +=
                `${urgencyEmoji} *${req.userName}* in #${req.channel}\n` +
                `💬 _"${req.originalText.substring(0, 120)}"_\n` +
                `📦 Wants: ${req.analysis.itemDescription}` +
                `${req.analysis.quantity ? ` (×${req.analysis.quantity})` : ""}\n` +
                `${matchLine}\n` +
                `${poLine}\n\n`;
        }

        message += `_Reply /requests for full details_`;

        try {
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: "Markdown",
            });
            console.log(`🚀 Telegram digest sent: ${requests.length} requests`);

            // Clear the buffer after sending
            this.pendingRequests = [];
        } catch (err: any) {
            console.error("❌ Telegram digest failed:", err.message);
        }
    }
}
