/**
 * @file    watchdog.ts
 * @purpose Monitors Will's Slack for product/SKU requests from individual users.
 *          Laser-focused on detecting when someone needs something ordered.
 *          Uses fuzzy matching (Fuse.js) against known products from PO history.
 *          Cross-references active POs for instant ETA lookups.
 *          Reports actionable findings to Will on Telegram.
 *          Replies in Slack threads with per-SKU Finale stock context.
 * @author  Antigravity / Aria
 * @created 2026-02-24
 * @updated 2026-03-04
 * @deps    @slack/web-api, fuse.js, intelligence/llm, supabase, axios, finale/client
 */

import { WebClient } from "@slack/web-api";
import { unifiedObjectGeneration } from "../intelligence/llm";
import { z } from "zod";
import { createClient } from "../supabase";
import axios from "axios";
import Fuse from "fuse.js";
import { FinaleClient } from "../finale/client";
import { BoxAgent } from "../agents/box-agent";

// ──────────────────────────────────────────────────
// SCHEMAS
// ──────────────────────────────────────────────────

const RequestExtractionSchema = z.object({
    isProductRequest: z.boolean().describe("True ONLY if someone is explicitly asking for a product to be ordered, restocked, or procured — NOT mere wishes, casual mentions, or hypothetical desires"),
    hasExplicitAsk: z.boolean().describe("True only if the message contains an actual directive or ask (e.g. 'can we order', 'we need to get', 'please order', 'can you grab') — NOT just an expression of wanting or liking something"),
    itemDescription: z.string().describe("The PRIMARY product, material, or supply being requested — use the most specific name or SKU possible"),
    allItems: z.array(z.string()).describe("ALL distinct products, materials, or SKUs mentioned in the request. If multiple SKUs or products are listed (e.g. 'BLM207, BLM209, ALK101'), include each one separately. Always includes itemDescription as the first entry."),
    quantity: z.number().nullable().optional().describe("How many units requested, if mentioned"),
    urgency: z.enum(["low", "medium", "high"]).describe("low = general mention, medium = clearly needs it, high = urgent/ASAP language"),
    confidence: z.number().min(0).max(1).describe("How confident you are this is a real, actionable product request (0.0-1.0)"),
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
    finaleContext: string | null;  // Real-time stock/risk context from Finale
    skuDescriptions: Map<string, string>;  // SKU (lowercase) → human-readable product name
    skuPOStatus: Map<string, string>;      // SKU (lowercase) → "On order PO#123 (×50)" or "❌ No PO"
    messageTs: string;             // Original Slack ts for thread replies & reactions
    threadTs?: string;             // Thread parent ts, if applicable
}

// Per-SKU Finale stock detail for intelligent replies
interface SkuStockDetail {
    sku: string;
    productName: string | null;   // Human-readable description from Finale
    onHand: number | null;
    onOrder: number | null;
    stockoutDays: number | null;
    incomingPOs: number;
    incomingPODetails: Array<{ orderId: string; quantity: number; supplier: string }>;  // Actual PO IDs awaiting arrival
    found: boolean;
    recommendation: string; // Human-readable one-liner
    vendorName: string | null;    // Primary supplier name from Finale
    vendorPartyUrl: string | null; // For PO matching
    unitCost: number | null;       // Last known supplier cost from Finale
    reorderQty: number | null;     // Finale-calculated reorder qty based on demand velocity
    needsReorder: boolean;         // True if stockout ≤ 30d or out of stock
}

// ──────────────────────────────────────────────────
// WATCHDOG
// ──────────────────────────────────────────────────

// DECISION(2026-02-26): Only monitor channels where legitimate purchasing
// requests come in. #inventory-management was too noisy with general chatter.
// DMs are always monitored for direct requests to Will.
// DECISION(2026-03-04): Also monitor ALL channels for @Bill mentions.
// Parker's 3.0BAGCF request was missed because it was posted outside
// the purchasing channels but tagged @Bill Selee directly.
const MONITORED_CHANNEL_NAMES = new Set([
    "purchasing",
    "purchase-orders",
]);

export class SlackWatchdog {
    private client: WebClient;
    private botClient: WebClient | null = null; // Bot token — used for users.info AND thread replies
    private lastChecked: Map<string, string> = new Map();
    private lastCheckedThreads: Map<string, string> = new Map(); // threadKey -> last reply ts
    private channelNames: Map<string, string> = new Map();       // Full-monitor channels (DMs + purchasing)
    private mentionChannels: Map<string, string> = new Map();    // All other channels — only process @Bill mentions
    private userNames: Map<string, string> = new Map();          // userId -> display name
    private productCatalog: KnownProduct[] = [];
    private fuse: Fuse<KnownProduct> | null = null;
    private pendingRequests: DetectedRequest[] = [];  // buffer for batch reporting
    private pollIntervalMs: number;
    private finaleClient: FinaleClient;
    private processedRequests: Set<string> = new Set(); // In-memory dedup for request alerts
    private ownerUserId: string | null = null; // Will's Slack ID — we skip his messages
    private boxAgent: BoxAgent;

    constructor(pollIntervalSeconds: number = 60) {
        const token = process.env.SLACK_ACCESS_TOKEN;
        if (!token) throw new Error("SLACK_ACCESS_TOKEN is required");

        this.client = new WebClient(token);
        // Bot token has users:read scope — used for resolving user display names
        if (process.env.SLACK_BOT_TOKEN) {
            this.botClient = new WebClient(process.env.SLACK_BOT_TOKEN);
        }
        this.pollIntervalMs = pollIntervalSeconds * 1000;

        // DECISION(2026-02-25): Initialize Finale client to cross-reference
        // detected Slack requests with real-time stock data. If Finale keys
        // are missing, we still work — just without stock context.
        this.finaleClient = new FinaleClient();
        this.boxAgent = new BoxAgent();

        // DECISION(2026-02-26): Dedup is now in-memory (Set) instead of Pinecone.
        // The old approach wrote 1024-dim dummy vectors to PINECONE_INDEX (email-embeddings),
        // which is a different dimension → silent failures. In-memory dedup is fine because
        // the watchdog re-establishes baselines on every restart anyway.

        // DECISION(2026-02-26): Will's own messages should never trigger alerts.
        // He's the one who does the ordering — alerting himself is noise.
        this.ownerUserId = process.env.SLACK_OWNER_USER_ID || null;
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

        // 6. Prune unbounded in-memory collections (OOM prevention)
        // DECISION(2026-03-09): processedRequests Set and lastCheckedThreads Map
        // grow indefinitely without pruning. Cap them to prevent memory leaks.
        setInterval(() => {
            if (this.processedRequests.size > 1000) {
                console.log(`[watchdog] processedRequests: ${this.processedRequests.size} → clearing`);
                this.processedRequests.clear();
            }
            if (this.lastCheckedThreads.size > 500) {
                console.log(`[watchdog] lastCheckedThreads: ${this.lastCheckedThreads.size} → clearing`);
                this.lastCheckedThreads.clear();
            }
            // Flush stale pending requests (should be empty after digest, but safety net)
            if (this.pendingRequests.length > 50) {
                this.pendingRequests = this.pendingRequests.slice(-20);
            }
        }, 30 * 60 * 1000);

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

                let fullCount = 0;
                let mentionCount = 0;
                for (const ch of (result.channels || [])) {
                    if (!ch.is_member && !ch.is_im) continue;

                    const name = ch.name || ch.id || "dm";
                    const isDM = ch.is_im === true;

                    if (isDM || MONITORED_CHANNEL_NAMES.has(name)) {
                        // Full-monitor: process ALL messages
                        this.channelNames.set(ch.id!, name);
                        fullCount++;
                    } else if (!isDM) {
                        // DECISION(2026-03-04): Register all other channels for @Bill mention detection.
                        // Parker's request was missed because it was in a non-purchasing channel
                        // but explicitly tagged @Bill Selee. We now catch those.
                        this.mentionChannels.set(ch.id!, name);
                        mentionCount++;
                    }
                }
                console.log(`  ✅ ${label}: ${fullCount} full-monitor, ${mentionCount} mention-watch`);
            } catch (err: any) {
                console.warn(`  ⚠️ ${label}: skipped (${err.data?.error || err.message})`);
            }
        }

        console.log(`📋 Full-monitor: ${this.channelNames.size} channels (DMs + ${[...MONITORED_CHANNEL_NAMES].join(', ')})`);
        console.log(`📋 @Mention-watch: ${this.mentionChannels.size} additional channels`);
    }

    // ──────────────────────────────────────────────────
    // POLLING
    // ──────────────────────────────────────────────────

    private async pollAllChannels() {
        // Skip weekends — no point alerting Will on Saturday/Sunday
        const day = new Date().getDay();
        if (day === 0 || day === 6) return;

        // 1. Full-monitor channels: process ALL messages (DMs + purchasing channels)
        for (const [channelId, channelName] of this.channelNames) {
            try {
                await this.pollChannel(channelId, channelName);
            } catch (err: any) {
                if (!err.message?.includes("not_in_channel") && !err.message?.includes("channel_not_found")) {
                    // Silently skip non-critical errors
                }
            }
        }

        // 2. @Mention channels: only process messages that tag @Bill
        // DECISION(2026-03-04): Poll all channels Will is a member of, but only
        // process messages containing <@OWNER_USER_ID>. This catches requests
        // like Parker's 3.0BAGCF post in any channel when @Bill is explicitly tagged.
        if (this.ownerUserId) {
            for (const [channelId, channelName] of this.mentionChannels) {
                try {
                    await this.pollMentionChannel(channelId, channelName);
                } catch (err: any) {
                    if (!err.message?.includes("not_in_channel") && !err.message?.includes("channel_not_found")) {
                        // Silently skip non-critical errors
                    }
                }
            }
        }
    }

    /**
     * Polls a non-purchasing channel for messages that explicitly tag @Bill.
     * Only processes messages containing `<@OWNER_USER_ID>`.
     * Same bookmark/thread logic as pollChannel, but with a mention filter.
     */
    private async pollMentionChannel(channelId: string, channelName: string) {
        const mentionTag = `<@${this.ownerUserId}>`;
        const oldest = this.lastChecked.get(channelId);

        const result = await this.client.conversations.history({
            channel: channelId,
            oldest: oldest || undefined,
            limit: 10, // Lower limit for mention channels — less traffic expected
        });

        const messages = result.messages || [];
        if (messages.length === 0) return;

        // Update bookmark
        const newestTs = messages[0]?.ts;
        if (newestTs) this.lastChecked.set(channelId, newestTs);

        // Skip first poll (baseline)
        if (!oldest) return;

        // Only human messages that mention @Bill (no bots, no system, not from Will himself)
        const mentionMessages = messages.filter((m: any) =>
            m.type === "message" && !m.subtype && !m.bot_id && m.text &&
            m.text.length > 10 && m.user !== this.ownerUserId &&
            m.text.includes(mentionTag)
        );

        for (const msg of mentionMessages) {
            await this.processMessage(msg.text!, msg.user || "unknown", channelId, channelName, msg.ts!, msg.thread_ts);
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

        // Only human messages (no bots, no system, not from Will himself)
        const isHumanMessage = (m: any) =>
            m.type === "message" && !m.subtype && !m.bot_id && m.text && m.text.length > 10
            && m.user !== this.ownerUserId;

        const humanMessages = messages.filter(isHumanMessage);

        for (const msg of humanMessages) {
            await this.processMessage(msg.text!, msg.user || "unknown", channelId, channelName, msg.ts!, msg.thread_ts);
        }

        // DECISION(2026-02-26): Also fetch replies from threads that had new activity.
        // conversations.history only returns parent messages — thread replies are invisible
        // without calling conversations.replies. This caused Krystal's Uline supply list
        // (a thread reply) to be completely missed.
        const threadedMessages = messages.filter(
            (m) => m.thread_ts && m.reply_count && m.reply_count > 0
        );

        for (const parent of threadedMessages) {
            try {
                const threadKey = `${channelId}:${parent.thread_ts}`;
                const lastReplyTs = this.lastCheckedThreads.get(threadKey);

                const replies = await this.client.conversations.replies({
                    channel: channelId,
                    ts: parent.thread_ts!,
                    oldest: lastReplyTs || oldest, // Only get new replies
                    limit: 20,
                });

                const replyMessages = (replies.messages || [])
                    // Skip the parent message itself (it's always first in replies)
                    .filter((r) => r.ts !== parent.thread_ts && isHumanMessage(r));

                if (replyMessages.length > 0) {
                    // Update thread bookmark
                    const newestReplyTs = replyMessages[replyMessages.length - 1]?.ts;
                    if (newestReplyTs) this.lastCheckedThreads.set(threadKey, newestReplyTs);

                    for (const reply of replyMessages) {
                        await this.processMessage(
                            reply.text!, reply.user || "unknown",
                            channelId, channelName,
                            reply.ts!, parent.thread_ts
                        );
                    }
                }
            } catch (err: any) {
                // Thread may have been deleted or we lack access — non-fatal
                if (!err.message?.includes("thread_not_found")) {
                    console.warn(`  ⚠️ Thread reply fetch failed: ${err.message}`);
                }
            }
        }
    }

    // ──────────────────────────────────────────────────
    // MESSAGE ANALYSIS
    // DECISION(2026-03-04): Aria now replies in Slack threads with stock context
    // for purchasing requests. This replaces the old "eyes-only" mode for product
    // requests. Aria replies as a bot (SLACK_BOT_TOKEN) — clearly Aria, not Will.
    // Still sends Telegram digest for Will's visibility.
    // ──────────────────────────────────────────────────

    private async processMessage(text: string, userId: string, channelId: string, channelName: string, messageTs: string, threadTs?: string) {
        // Step 1: LLM intent analysis — is this a product request?
        const analysis = await this.analyzeIntent(text);

        // Only proceed if the LLM is confident this is a real, actionable product request
        // hasExplicitAsk filters out casual wishes like "I'd like X" or "it'd be nice to have X"
        if (!analysis.isProductRequest || !analysis.hasExplicitAsk || analysis.confidence < 0.75) return;

        console.log(`📡 [#${channelName}] Request detected (conf: ${analysis.confidence}): "${text.substring(0, 60)}..."`);

        // Step 2: React with 👀 from Will's account (user token) to signal "looking into it"
        await this.addEyesReaction(channelId, messageTs);

        // Step 3: Fuzzy match against product catalog
        const match = this.fuzzyMatch(analysis.itemDescription);

        // Step 4: Check for active POs if we have a match
        let activePO: string | null = null;
        let eta: string | null = null;

        if (match) {
            const poInfo = await this.checkActivePOs(match.product);
            activePO = poInfo?.poNumber || null;
            eta = poInfo?.eta || null;
        }

        // Step 5: Resolve user name
        const userName = await this.resolveUserName(userId);

        // Step 6: Collect ALL SKU candidates for Finale lookup.
        // DECISION(2026-03-04): Use LLM's allItems extraction as PRIMARY source.
        // The old regex-only approach missed SKUs like "3.0BAGCF" (digit-first, period).
        // Now: merge LLM items + regex matches + fuzzy match, dedup, lookup each.
        const skuCandidates = new Set<string>();

        // Source 1: LLM-extracted items (most reliable for natural language)
        for (const item of (analysis.allItems || [analysis.itemDescription])) {
            if (item && item.length >= 2) skuCandidates.add(item.trim());
        }

        // Source 2: Regex fallback — expanded to catch digit-first SKUs
        // Handles: 3.0BAGCF, 3.0CF, S-4122, BLM207, ALK101, NC104, DOM101
        const skuPattern = /\b(\d+\.?\d*[A-Z]{2,}[A-Z0-9]*|[A-Z]{1,6}[._-]?[0-9]{2,5}(?:[._-][A-Z0-9]+)*)\b/g;
        for (const m of text.matchAll(skuPattern)) {
            skuCandidates.add(m[1]);
        }

        // Source 3: Fuzzy-matched product SKU
        if (match && match.product.sku !== 'N/A') {
            skuCandidates.add(match.product.sku);
        }

        // DECISION(2026-03-11): Also add hyphen-stripped variants of each SKU.
        // Finale stores SKUs without hyphens (e.g., "BASTM607") but Slack messages
        // often include them (e.g., "BASTM6-07"). We try both variants.
        const expandedCandidates = new Set<string>();
        for (const sku of skuCandidates) {
            expandedCandidates.add(sku);
            const stripped = sku.replace(/-/g, '');
            if (stripped !== sku) expandedCandidates.add(stripped);
        }

        const skusToLookup = [...expandedCandidates].slice(0, 10); // Cap at 10 to avoid hammering Finale

        // Step 6a: Look up each SKU in Finale for detailed stock context
        let finaleContext: string | null = null;
        const stockDetails: SkuStockDetail[] = [];
        const foundSkus = new Set<string>(); // Track found SKUs to avoid duplicates from variant expansion

        for (const sku of skusToLookup) {
            // Skip if we already found this SKU via a variant (e.g., found BASTM607, skip BASTM6-07)
            if (foundSkus.has(sku.replace(/-/g, ''))) continue;

            const detail = await this.getDetailedStockContext(sku);
            if (detail.found) foundSkus.add(sku.replace(/-/g, ''));
            stockDetails.push(detail);
        }

        // Remove "not found" entries if a variant of the same SKU WAS found
        const finalDetails = stockDetails.filter(d =>
            d.found || !foundSkus.has(d.sku.replace(/-/g, ''))
        );

        // Build the finaleContext string for Telegram
        // DECISION(2026-03-16): Show "SKU — Product Name: stock data" so Will
        // can immediately see what each SKU is without looking it up.
        if (finalDetails.length > 0) {
            finaleContext = finalDetails.map(d => {
                const label = d.productName
                    ? `*${d.sku}* — ${d.productName}`
                    : `*${d.sku}*`;
                if (!d.found) return `  ${label}: not found in Finale`;
                const parts: string[] = [];
                if (d.onHand !== null) parts.push(`${d.onHand.toLocaleString()} on hand`);
                if (d.onOrder !== null && d.onOrder > 0) parts.push(`${d.onOrder} on order`);
                if (d.stockoutDays !== null) {
                    if (d.stockoutDays <= 14) parts.push(`⚠️ Stockout in ${d.stockoutDays}d!`);
                    else parts.push(`${d.stockoutDays}d runway`);
                }
                // DECISION(2026-03-16): Show actual PO numbers, not just a count.
                // "On order PO#12345 (×50)" is infinitely more useful than "1 PO incoming".
                if (d.incomingPODetails.length > 0) {
                    const poList = d.incomingPODetails
                        .map(po => `PO#${po.orderId} (×${po.quantity})`)
                        .join(', ');
                    parts.push(`📋 ${poList}`);
                } else {
                    parts.push(`❌ No PO`);
                }
                return `  ${label}: ${parts.join(' · ') || 'in Finale, no stock data'}`;
            }).join('\n');
        }

        // Apply Box Agent overrides if it's explicitly talking about boxes
        const boxReport = await this.boxAgent.analyzeSlackMessage(text);
        if (boxReport) {
            finaleContext = boxReport;
        }

        // Step 6b: In-memory dedup to prevent repeat alerts for the same request
        const uniqueThreadContext = threadTs || messageTs;
        const dedupKey = match && match.product.sku !== 'N/A'
            ? `req_${channelId}_${uniqueThreadContext}_${match.product.sku}`
            : `req_${channelId}_${messageTs}`;

        if (this.processedRequests.has(dedupKey)) {
            console.log(`  💤 Skipping repeated request (already handled): ${dedupKey}`);
            return;
        }

        // DECISION(2026-03-11): Removed Slack thread auto-replies entirely.
        // The bot was posting confusing messages to coworkers:
        //   - Raw user IDs instead of names (U056HD83BK5)
        //   - False "not found in Finale" for valid SKUs (hyphen mismatch)
        //   - Non-sensical stock context that confused rather than helped
        // The 👀 reaction stays (signals "seen"). Telegram digest stays (for Will).
        // Slack channels are for humans only — Aria watches silently.

        // Step 7b: For urgent reorder SKUs, check for existing draft POs from the vendor
        // DECISION(2026-03-04): Instead of just alerting Will, proactively check if there's
        // a draft PO from the same vendor (e.g., ULINE) that the item could be added to.
        // Notify via Telegram (NOT Slack) with actionable context.
        const urgentSkus = finalDetails.filter(d => d.found && d.needsReorder);
        if (urgentSkus.length > 0 && !boxReport) {
            setImmediate(async () => {
                for (const urgent of urgentSkus) {
                    await this.sendPOActionToTelegram(urgent, userName, channelName);
                }
            });
        }

        // Build SKU → description + PO status lookups for the Telegram digest
        const skuDescriptions = new Map<string, string>();
        const skuPOStatus = new Map<string, string>();
        for (const d of finalDetails) {
            if (d.productName) skuDescriptions.set(d.sku.toLowerCase(), d.productName);
            // Always show PO status: either "On order PO#XXXXX (×qty)" or "❌ No PO"
            if (d.found) {
                if (d.incomingPODetails.length > 0) {
                    const poList = d.incomingPODetails
                        .map(po => `PO#${po.orderId} (×${po.quantity})`)
                        .join(', ');
                    skuPOStatus.set(d.sku.toLowerCase(), `📝 On order ${poList}`);
                } else {
                    skuPOStatus.set(d.sku.toLowerCase(), '❌ No PO');
                }
            }
        }
        // Also include the fuzzy-matched product name if available
        if (match?.product && match.product.sku !== 'N/A') {
            skuDescriptions.set(match.product.sku.toLowerCase(), match.product.name);
        }

        // Step 7c: Auto-create draft POs for requested items with no existing PO
        // DECISION(2026-03-16): When someone requests products and they have no PO on order,
        // proactively create draft POs in Finale grouped by vendor. Will reviews/commits them.
        const noPOItems = finalDetails.filter(d =>
            d.found && d.incomingPODetails.length === 0 && d.vendorPartyUrl
        );
        if (noPOItems.length > 0 && !boxReport) {
            // Group by vendor
            const byVendor = new Map<string, SkuStockDetail[]>();
            for (const item of noPOItems) {
                const key = item.vendorPartyUrl!;
                const group = byVendor.get(key) || [];
                group.push(item);
                byVendor.set(key, group);
            }

            for (const [partyUrl, items] of Array.from(byVendor.entries())) {
                const vendorPartyId = partyUrl.split('/').pop() || '';
                if (!vendorPartyId) continue;

                const vendorName = items[0].vendorName || 'Unknown Vendor';
                const lineItems = items.map(d => ({
                    productId: d.sku,
                    // DECISION(2026-03-16): Use Finale's demand-based reorderQuantityToOrder
                    // so draft POs reflect actual need, not placeholder 1s.
                    // Falls back to 1 only if Finale has no demand data for this SKU.
                    quantity: Math.max(1, d.reorderQty ?? 1),
                    unitPrice: d.unitCost || 0,
                }));

                try {
                    const result = await this.finaleClient.createDraftPurchaseOrder(
                        vendorPartyId,
                        lineItems,
                        `Slack request from ${userName} in #${channelName}: ${items.map(d => d.sku).join(', ')}`,
                    );

                    console.log(`  📝 Draft PO #${result.orderId} created for ${vendorName} (${items.length} items)`);

                    // Update PO status for the digest
                    for (const item of items) {
                        skuPOStatus.set(item.sku.toLowerCase(), `🆕 Draft PO Created #${result.orderId}`);
                    }

                    // Send immediate Telegram notification for draft PO creation
                    await this.sendDraftPOCreatedToTelegram(
                        result.orderId, result.finaleUrl, vendorName,
                        items, userName, channelName,
                    );
                } catch (err: any) {
                    console.error(`  ❌ Draft PO creation failed for ${vendorName}:`, err.message);
                    for (const item of items) {
                        skuPOStatus.set(item.sku.toLowerCase(), `❌ No PO (auto-create failed)`);
                    }
                }
            }
        }

        // Step 8: Queue the detected request (Telegram digest for Will)
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
            finaleContext,
            skuDescriptions,
            skuPOStatus,
            messageTs,
            threadTs,
        };

        this.pendingRequests.push(request);
        console.log(`  → Queued for Telegram digest (${this.pendingRequests.length} pending)`);

        // Mirror to dashboard (fire-and-forget)
        setImmediate(async () => {
            const { logChatMessage } = await import('../intelligence/chat-logger');
            await logChatMessage({
                source: 'slack',
                role: 'user',
                content: text,
                metadata: {
                    channel: channelName,
                    userName,
                    confidence: analysis.confidence,
                    matchedProduct: match?.product?.name || null,
                    activePO,
                    skusChecked: skusToLookup,
                },
            });
        });

        // Step 9: Mark as processed in dedup set
        this.processedRequests.add(dedupKey);
    }

    /**
     * Reacts with 👀 on a Slack message using Will's user token.
     * Signals to the requester that the message was seen.
     */
    private async addEyesReaction(channelId: string, messageTs: string) {
        try {
            await this.client.reactions.add({
                channel: channelId,
                timestamp: messageTs,
                name: "eyes",
            });
        } catch (err: any) {
            // "already_reacted" is fine — just means we already saw it
            if (!err.data?.error?.includes("already_reacted")) {
                console.warn(`  ⚠️ Could not react: ${err.data?.error || err.message}`);
            }
        }
    }

    private async analyzeIntent(text: string): Promise<RequestExtraction> {
        return await unifiedObjectGeneration({
            system: `You are Aria, analyzing Slack messages at BuildASoil (premium living soil & organic growing supply company).

Your ONLY job: determine if the message is an EXPLICIT REQUEST for a product to be ordered or procured.

POSITIVE — isProductRequest=true AND hasExplicitAsk=true:
- "We need more X" / "We're out of X, can we order more?"
- "Can we order Y?" / "Please order Z"
- "Running low on Z — need to restock"
- "I need [X] for [project] by [date]"
- "Can you grab some X?"
- Messages with a clear directive directed at a buyer/manager

PARTIAL — isProductRequest=true BUT hasExplicitAsk=false (do NOT alert):
- "I'd like some X" / "It would be nice to have X" — desire, not a request
- "X would be great" / "X would help" — wishful thinking
- "Really I'd like X in here... but..." — trailing 'but' = they're NOT actually asking
- "I was thinking about getting X" — hypothetical, no ask
- Casual mention of a product in passing conversation

NEGATIVE — isProductRequest=false:
- General status updates or process questions
- Social chat / greetings
- Technical discussions not about ordering
- Meeting scheduling
- Anything without a specific product mentioned

KEY RULE: If the message trails off ("but...", "though...", "maybe...") or uses hedging language without a clear ask, set hasExplicitAsk=false. A real request has someone directing action.
Set confidence < 0.5 for anything ambiguous.

MULTI-ITEM RULE: If the message lists multiple products or SKUs (e.g. "BLM207, BLM209, ALK101, NC104"), set itemDescription to the first/primary one AND populate allItems with EVERY item mentioned as separate entries. Preserve exact SKU codes (like BLM207, S-445) as-is.`,
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
    // FINALE STOCK CONTEXT
    // ──────────────────────────────────────────────────

    /**
     * Query Finale for detailed stock info for a single SKU.
     * Returns structured SkuStockDetail for use in both Slack replies and Telegram.
     * Also resolves the vendor/supplier for PO matching on urgent items.
     */
    private async getDetailedStockContext(sku: string): Promise<SkuStockDetail> {
        const emptyResult: SkuStockDetail = {
            sku, productName: null, onHand: null, onOrder: null, stockoutDays: null,
            incomingPOs: 0, incomingPODetails: [],
            found: false, recommendation: 'Not found in Finale',
            vendorName: null, vendorPartyUrl: null, unitCost: null,
            reorderQty: null, needsReorder: false,
        };

        try {
            const profile = await this.finaleClient.getComponentStockProfile(sku);
            if (!profile.hasFinaleData) return emptyResult;

            const onHand = profile.onHand;
            const onOrder = profile.onOrder;
            const stockoutDays = profile.stockoutDays;
            const incomingPOs = profile.incomingPOs.length;
            const incomingPODetails = profile.incomingPOs.map(po => ({
                orderId: po.orderId,
                quantity: po.quantity,
                supplier: po.supplier,
            }));
            const reorderQty = profile.reorderQuantityToOrder;

            // Resolve vendor + product name from product detail
            // DECISION(2026-03-04): We do the extra REST call because
            // knowing the vendor lets us find existing draft POs to add to.
            // DECISION(2026-03-16): Also capture product name so Telegram
            // digest shows "SKU — Description" instead of raw codes.
            let vendorName: string | null = null;
            let vendorPartyUrl: string | null = null;
            let productName: string | null = null;
            let unitCost: number | null = null;
            try {
                const product = await this.finaleClient.lookupProduct(sku);
                if (product) {
                    productName = product.name || null;
                    if (product.suppliers.length > 0) {
                        const mainSupplier = product.suppliers.find(s => s.role === 'MAIN') || product.suppliers[0];
                        vendorName = mainSupplier.name;
                        vendorPartyUrl = mainSupplier.partyUrl;
                        unitCost = mainSupplier.cost;
                    }
                }
            } catch { /* vendor/name resolution is best-effort */ }

            // Determine if this SKU needs reorder
            const needsReorder = (
                (stockoutDays !== null && stockoutDays <= 30) ||
                (onHand !== null && onHand === 0)
            );

            // Generate intelligent recommendation
            let recommendation: string;
            if (onHand !== null && onHand > 0 && stockoutDays !== null && stockoutDays > 60) {
                recommendation = `We've got ${onHand.toLocaleString()} on hand — that's ${stockoutDays}d of runway. Should be good for a while.`;
            } else if (onHand !== null && onHand > 0 && stockoutDays !== null && stockoutDays > 30) {
                recommendation = `${onHand.toLocaleString()} on hand, ${stockoutDays}d runway. Not urgent but worth keeping an eye on.`;
            } else if (stockoutDays !== null && stockoutDays <= 14) {
                recommendation = `Thanks for the heads up! Only ${stockoutDays}d until stockout — getting on this.`;
            } else if (stockoutDays !== null && stockoutDays <= 30) {
                recommendation = `Good call — ${stockoutDays}d until stockout. Adding to the order list.`;
            } else if (incomingPOs > 0) {
                recommendation = `Already on order — ${incomingPOs} PO${incomingPOs > 1 ? 's' : ''} incoming.`;
            } else if (onHand !== null && onHand === 0) {
                recommendation = `We're out! Getting this ordered ASAP.`;
            } else {
                recommendation = `In Finale — checking on it.`;
            }

            return {
                sku, productName, onHand, onOrder, stockoutDays,
                incomingPOs, incomingPODetails,
                found: true, recommendation,
                vendorName, vendorPartyUrl, unitCost, reorderQty, needsReorder,
            };
        } catch {
            return { ...emptyResult, recommendation: 'Finale lookup error' };
        }
    }

    // DECISION(2026-03-11): composeStockReply and replyInThread removed.
    // Aria no longer posts auto-replies in Slack channels. The bot was producing
    // confusing messages for coworkers (raw user IDs, false "not found" for valid
    // SKUs). Slack channels are for humans — Aria watches silently with 👀 and
    // reports to Will via Telegram digest only.

    /**
     * Query Finale for a concise stock summary of any SKU (legacy one-liner format).
     * Kept for backward compatibility with Telegram digest.
     */
    private async getFinaleStockContext(sku: string): Promise<string | null> {
        const detail = await this.getDetailedStockContext(sku);
        if (!detail.found) return null;

        const parts: string[] = [];
        if (detail.onHand !== null) parts.push(`${detail.onHand.toLocaleString()} on hand`);
        if (detail.onOrder !== null && detail.onOrder > 0) parts.push(`${detail.onOrder} on order`);
        if (detail.stockoutDays !== null) {
            if (detail.stockoutDays <= 14) parts.push(`⚠️ Stockout in ${detail.stockoutDays}d!`);
            else if (detail.stockoutDays <= 30) parts.push(`Stockout in ${detail.stockoutDays}d`);
            else parts.push(`${detail.stockoutDays}d runway`);
        }
        if (detail.incomingPOs > 0) parts.push(`${detail.incomingPOs} PO incoming`);
        return parts.length > 0 ? parts.join(' · ') : `in Finale, no stock data`;
    }

    /**
     * Find open/draft POs from a specific vendor in Finale.
     * DECISION(2026-03-04): Looking for status "Open" (ORDER_CREATED) POs
     * that haven't been committed yet — these are draft POs that we can add to.
     * Uses GraphQL to query by supplier name and filter for Open status.
     *
     * @param vendorName - The vendor/supplier name (e.g., "ULINE")
     * @returns Array of draft POs with orderId, orderDate, and item count
     */
    private async findDraftPOsForVendor(vendorName: string): Promise<Array<{
        orderId: string;
        orderDate: string;
        itemCount: number;
        total: number;
        finaleUrl: string;
    }>> {
        try {
            // Query recent POs and filter for Open status + matching vendor
            const query = {
                query: `{
                    orderViewConnection(
                        first: 20
                        type: ["PURCHASE_ORDER"]
                        sort: [{ field: "orderDate", mode: "desc" }]
                    ) {
                        edges {
                            node {
                                orderId
                                status
                                orderDate
                                supplier { name }
                                total
                                itemList(first: 100) {
                                    edges {
                                        node {
                                            product { productId }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }`
            };

            // Access Finale client internals for API call
            // any: accessing private fields for GraphQL query
            const fc = this.finaleClient as any;
            const res = await fetch(`${fc.apiBase}/${fc.accountPath}/api/graphql`, {
                method: 'POST',
                headers: {
                    Authorization: fc.authHeader,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(query),
            });

            if (!res.ok) return [];
            const result = await res.json();
            if (result.errors) return [];

            const edges = result.data?.orderViewConnection?.edges || [];
            const vendorLower = vendorName.toLowerCase();

            return edges
                .filter((edge: any) =>
                    edge.node.status === 'Open' &&
                    edge.node.supplier?.name?.toLowerCase().includes(vendorLower)
                )
                .map((edge: any) => {
                    const po = edge.node;
                    return {
                        orderId: po.orderId,
                        orderDate: po.orderDate,
                        itemCount: po.itemList?.edges?.length || 0,
                        total: po.total || 0,
                        finaleUrl: `https://app.finaleinventory.com/${fc.accountPath}/purchaseorder?purchaseorderid=${po.orderId}`,
                    };
                });
        } catch (err: any) {
            console.warn(`  ⚠️ Draft PO lookup failed for ${vendorName}:`, err.message);
            return [];
        }
    }

    // ──────────────────────────────────────────────────
    // USER RESOLUTION
    // ──────────────────────────────────────────────────

    private async resolveUserName(userId: string): Promise<string> {
        if (this.userNames.has(userId)) return this.userNames.get(userId)!;

        // Prefer bot token (has users:read scope); fall back to user token
        const lookupClient = this.botClient || this.client;
        try {
            const result = await lookupClient.users.info({ user: userId });
            const name = result.user?.real_name || result.user?.profile?.display_name || result.user?.name || userId;
            this.userNames.set(userId, name);
            return name;
        } catch {
            // DECISION(2026-03-11): Never expose raw user IDs (e.g., "U056HD83BK5").
            // If we can't resolve the name, use a human-readable fallback.
            // The only consumer now is Telegram digest — Slack replies are removed.
            return 'a team member';
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
                ? `✅ Catalog match: \`${req.matchedProduct.sku}\` — ${req.matchedProduct.name}${req.matchedProduct.vendor ? ` (${req.matchedProduct.vendor})` : ""}`
                : `⚠️ No catalog match — see Finale data below`;

            const poLine = req.activePO
                ? `📋 Active PO: #${req.activePO} — ${req.eta}`
                : `📭 No active PO found`;

            // DECISION(2026-03-16): Use pre-resolved SKU descriptions so Will can
            // instantly see what products people are asking for without manual lookup.

            // Show all requested items with descriptions + PO status
            const rawItems = req.analysis.allItems?.length > 1
                ? req.analysis.allItems
                : [req.analysis.itemDescription];

            // Format each item as "SKU — Description | PO status"
            const itemsWithDescriptions = rawItems.map(item => {
                const desc = req.skuDescriptions.get(item.toLowerCase());
                const po = req.skuPOStatus.get(item.toLowerCase()) || '';
                let line = desc ? `\`${item}\` — ${desc}` : `\`${item}\``;
                if (po) line += `\n      ${po}`;
                return line;
            });

            message +=
                `${urgencyEmoji} *${req.userName}* in #${req.channel}\n` +
                `💬 _"${req.originalText.substring(0, 120)}"_\n` +
                `📦 Wants:\n${itemsWithDescriptions.map(i => `  • ${i}`).join('\n')}` +
                `${req.analysis.quantity ? ` (×${req.analysis.quantity})` : ""}\n` +
                `${matchLine}\n` +
                `${poLine}\n`;

            // Add Finale stock context (per-SKU breakdown if multiple)
            if (req.finaleContext) {
                message += `📈 Finale:\n${req.finaleContext}\n`;
            }

            message += `\n`;
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

    /**
     * Sends a Telegram notification for a SKU that needs reorder.
     * DECISION(2026-03-04): Checks for existing draft POs from the vendor
     * and gives Will actionable options: add to existing draft or create new.
     * This is sent to Telegram (not Slack) because it's a decision for Will only.
     */
    private async sendPOActionToTelegram(detail: SkuStockDetail, requesterName: string, channelName: string) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!token || !chatId) return;

        let message = `📦 *Reorder Needed: ${detail.sku}*\n\n`;
        message += `Requested by ${requesterName} in #${channelName}\n`;
        message += `Stock: ${detail.onHand?.toLocaleString() ?? '?'} on hand`;
        if (detail.stockoutDays !== null) message += ` \u00b7 ${detail.stockoutDays}d until stockout`;
        message += `\n`;

        if (detail.vendorName) {
            message += `Vendor: *${detail.vendorName}*\n\n`;

            // Check for existing draft POs from this vendor
            const draftPOs = await this.findDraftPOsForVendor(detail.vendorName);

            if (draftPOs.length > 0) {
                // Sort by most recent date
                draftPOs.sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());
                const newest = draftPOs[0];

                message += `\u2705 *Found draft PO from ${detail.vendorName}:*\n`;
                message += `  PO #${newest.orderId} (${newest.orderDate}) — ${newest.itemCount} items\n`;
                message += `  [Open in Finale](${newest.finaleUrl})\n\n`;
                message += `\u27a1\ufe0f Add *${detail.sku}* to this draft PO?\n`;
                message += `  /addtopo ${newest.orderId} ${detail.sku}\n\n`;

                if (draftPOs.length > 1) {
                    message += `_(${draftPOs.length - 1} more draft PO${draftPOs.length > 2 ? 's' : ''} from ${detail.vendorName})_\n`;
                }
            } else {
                message += `No draft POs from ${detail.vendorName} found.\n`;
                message += `Create new? /createpo ${detail.vendorName} ${detail.sku}\n`;
            }
        } else {
            message += `\n\u26a0\ufe0f Vendor unknown — check Finale for supplier info.\n`;
        }

        try {
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            });
            console.log(`  \ud83d\udce8 Sent PO action for ${detail.sku} to Telegram`);
        } catch (err: any) {
            console.error(`  \u274c PO action Telegram failed for ${detail.sku}:`, err.message);
        }
    }

    /**
     * Sends a Telegram notification when a draft PO is auto-created for review.
     * DECISION(2026-03-16): Aria proactively creates drafts for items with no PO,
     * then notifies Will to review and commit in Finale.
     */
    private async sendDraftPOCreatedToTelegram(
        orderId: string,
        finaleUrl: string,
        vendorName: string,
        items: SkuStockDetail[],
        requesterName: string,
        channelName: string,
    ) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!token || !chatId) return;

        const itemLines = items.map(d => {
            const name = d.productName ? `${d.sku} — ${d.productName}` : d.sku;
            const qty = Math.max(1, d.reorderQty ?? 1);
            const stock = d.onHand !== null ? `${d.onHand.toLocaleString()} on hand` : 'stock unknown';
            const runway = d.stockoutDays !== null ? `${d.stockoutDays}d runway` : '';
            const context = [stock, runway].filter(Boolean).join(' · ');
            return `  • ×${qty} ${name}\n      ${context}`;
        }).join('\n');

        const message =
            `🆕 *Draft PO Created* — PO #${orderId}\n\n` +
            `Vendor: *${vendorName}*\n` +
            `Triggered by: ${requesterName} in #${channelName}\n\n` +
            `Items (qty based on Finale demand):\n${itemLines}\n\n` +
            `🔗 [Open in Finale](${finaleUrl})\n` +
            `⚠️ _Verify quantities and commit when ready_`;

        try {
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            });
            console.log(`  \ud83d\udce8 Sent draft PO #${orderId} notification to Telegram`);
        } catch (err: any) {
            console.error(`  \u274c Draft PO Telegram notification failed:`, err.message);
        }
    }
}
