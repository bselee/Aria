/**
 * @file    src/lib/slack/request-detector.ts
 * @purpose Polls Slack channels for purchasing requests (SKU mentions),
 *          looks up Finale for open POs, posts threaded reply with
 *          PO number + ETA when on order, and records to slack_requests.
 *
 *          Does NOT attempt to impersonate Bill or chat. Just data:
 *            EM5L106 → PO-12345, ETA 6/10
 *
 *          When nothing is on order: silent — 👀 + record only.
 *
 * @author  Hermia
 * @created 2026-06-04
 * @deps    @slack/web-api, @/lib/finale/client, @/lib/supabase
 * @env     SLACK_BOT_TOKEN, SLACK_ACCESS_TOKEN, SLACK_OWNER_USER_ID,
 *          FINALE_BASE_URL, FINALE_ACCOUNT_PATH
 */

import { WebClient } from "@slack/web-api";
import { FinaleClient } from "../finale/client";
import { createClient } from "../supabase";
import { sendTelegramNotify } from "../intelligence/telegram-notify";
import { resolveSkuAlias, expandSkuToken } from "../sku-aliases";

// ── Config ────────────────────────────────────────────────────────────────

/** How often to poll each watched channel (ms). */
const POLL_INTERVAL_MS = 60_000;

/** Channel names to watch for purchasing requests (without # prefix). */
const WATCH_CHANNEL_NAMES = ["purchase-orders", "purchasing"];

/** Minimum message age to avoid reacting to messages still being typed. */
const MIN_AGE_MS = 15_000;

/** How far back to look on each poll (ms). */
const LOOKBACK_MS = 120_000;

/**
 * Heuristic: does Bill's message look like a data request (not just chatter)?
 * 2026-06-09 — used to decide whether to process his Slack messages in
 * #purchasing / #purchase-orders. Default is "skip his messages" so the
 * bot isn't a chat companion; only process if it looks like an actionable
 * data request.
 *
 * Trigger signals (any one is enough):
 *   - Contains "?" anywhere
 *   - Starts with imperative verb: show, list, what, how, check, status,
 *     give, find, count, get, where, when, why, who, can, do, is
 *   - Contains bot mention: @purchase, @aria, @aria-bot
 *   - Starts with "/" (slash command like /buildrisk)
 *   - Contains a SKU-shaped token (handled by extractSKUs; not checked here)
 */
function looksLikeDataRequest(text: string): boolean {
    const t = text.trim();
    if (!t) return false;

    // Slash command
    if (t.startsWith("/")) return true;

    // Any question
    if (t.includes("?")) return true;

    // Bot mention
    if (/@(purchase|aria|aria-bot|bot)\b/i.test(t)) return true;

    // Imperative verb at start
    const lower = t.toLowerCase();
    const imperative = /^(show|list|what|how|check|status|give|find|count|get|where|when|why|who|can|do|is|are)\b/;
    if (imperative.test(lower)) return true;

    return false;
}


function buildFinalePOUrl(orderId: string): string {
    const base = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
    const encoded = Buffer.from(
        `/${accountPath}/api/order/purchase/${orderId}`,
    ).toString("base64");
    return `${base}/${accountPath}/sc2/?order/purchase/order/${encoded}`;
}

/**
 * Format a PO status into the Slack thread label suffix.
 * 2026-06-09 — Bill wants DRAFT and COMMITTED to surface explicitly so
 * he can tell at a glance which POs are still being assembled vs already
 * sent. SENT / OPEN / PARTIAL are normal terminal states and get no
 * label. Unknown statuses get the bare status name in parens for safety.
 *
 * Examples:
 *   "DRAFT"     → " (DRAFT)"
 *   "COMMITTED" → " (COMMITTED)"
 *   "SENT"      → ""
 *   "OPEN"      → ""
 *   "PARTIAL"   → ""
 *   "PENDING"   → " (PENDING)"
 */
function formatPOStateLabel(status: string | undefined | null): string {
    if (!status) return "";
    const upper = status.toUpperCase().trim();
    if (upper === "DRAFT") return " (DRAFT)";
    if (upper === "COMMITTED") return " (COMMITTED)";
    // Normal terminal states — no label
    if (upper === "SENT" || upper === "OPEN" || upper === "PARTIAL" ||
        upper === "RECEIVED" || upper === "CLOSED") return "";
    // Unknown — surface for safety
    return ` (${upper})`;
}

/**
 * Extract potential SKU codes from text.
 * Heuristic: tokens with letter+digit mix (3-15 chars) PLUS digit-first
 * patterns like "0811 BAGS" / "0711 BAGS" where digits are followed by
 * a letter-word. Filters out pure-letter common words.
 *
 * 2026-06-08 update: The earlier "letter AND digit" filter dropped all-letter
 * product codes like `RAWMILLEDGNARBAR` (Parker McMahon's 6/8 message
 * lost 1 of 12 SKUs). Now: pass when (letter AND digit) OR (all-letter
 * AND length >= 12). 12 chars is the floor — common English words
 * (PURCHASING=10, THRESHOLD=9, CALENDAR=8, COMPONENT=9) all get filtered.
 * Real all-letter product codes are usually 12+ chars (RAWMILLEDGNARBAR=16,
 * BAV5LBBAG=10 still needs alias table — see `sku-aliases.ts`).
 * Final 404s on lookups (e.g. `BILL`, `ORDER`) are swallowed silently
 * elsewhere in the pipeline.
 *
 * 2026-06-09 update: Added Pattern 4 (correlation pass). Catches space-split
 * product codes by concatenating adjacent words. E.g. "RAWMILLED GNARBAR"
 * → "RAWMILLEDGNARBAR" (16 chars, all-letter, passes 12-char floor),
 * "KMS 101" → "KMS101" (6 chars, mixed, passes letter+digits filter).
 * Downstream alias resolver / Finale lookup filters false positives.
 */
function extractSKUs(text: string): string[] {
    const upper = text.toUpperCase();

    // Pattern 1: Classic mixed SKUs — starts with letter, 3-15 chars total
    // e.g. CRAFT4L, HAL100, BAV5LBBAG (via alias table), GBB06, ACTV101, FM104
    const mixedMatches = upper.match(/\b[A-Z][A-Z0-9]{2,14}\b/g) || [];

    // Pattern 2: Digit-first SKU labels — digits followed by a letter-word
    // e.g. "0811 BAGS" → 0811BAGS, "0711 BAGS" → 0711BAGS
    const digitFirst = upper.match(/\b\d{3,6}\s[A-Z]{2,8}\b/g) || [];

    // Pattern 3 (NEW): All-letter product codes >= 12 chars
    // e.g. RAWMILLEDGNARBAR. The 12-char floor filters common English words.
    const longAllLetter = upper.match(/\b[A-Z]{12,}\b/g) || [];

    // Pattern 4 (NEW 2026-06-09): Correlation pass — concatenate adjacent
    // words and apply the same pass-criteria as Patterns 1+3. Catches
    // space-split product codes like "RAWMILLED GNARBAR" (people type
    // with spaces), "KMS 101" (mixed letter+digits with separator),
    // "BAV 5LB BAG" (multi-word product code).
    //
    // Restrict to:
    //   - adjacent words (max 3 words concatenated) so we don't glue
    //     "PURCHASING DEPARTMENT" together
    //   - both/all parts ≥ 4 chars (filters out short connectors like
    //     "ON", "TO", "OF", "AND")
    //   - apply the same pass-criteria as the standalone patterns:
    //     (letter AND digit) OR (all-letter AND >= 12 chars)
    //
    // The downstream alias resolver / Finale lookup swallows false
    // positives (e.g. "PURCHASINGDEPARTMENT" gets 404'd quietly).
    const wordSequence = upper.split(/\s+/).filter(w => /^[A-Z0-9]+$/.test(w));
    const correlationCandidates: string[] = [];
    for (let i = 0; i < wordSequence.length - 1; i++) {
        for (let j = i + 1; j <= Math.min(i + 3, wordSequence.length); j++) {
            const parts = wordSequence.slice(i, j);
            // All parts must be ≥ 4 chars to filter short connectors
            if (parts.some(p => p.length < 4)) continue;
            const candidate = parts.join("");
            correlationCandidates.push(candidate);
        }
    }

    const unique = new Set<string>();

    for (const token of mixedMatches) {
        // Letter+digits: any length >=3 is product-like (e.g. GBB06, FM104)
        if (/[A-Z]/.test(token) && /\d/.test(token)) {
            unique.add(token);
        }
    }
    for (const token of digitFirst) {
        unique.add(token.replace(/\s+/g, ""));
    }
    for (const token of longAllLetter) {
        unique.add(token);
    }
    for (const token of correlationCandidates) {
        // Same pass-criteria as Patterns 1+3:
        if (/[A-Z]/.test(token) && /\d/.test(token)) {
            unique.add(token);
        } else if (/^[A-Z]+$/.test(token) && token.length >= 12) {
            unique.add(token);
        }
    }

    return Array.from(unique);
}

// ── Detector ──────────────────────────────────────────────────────────────

export class SlackRequestDetector {
    /** User token (xoxp — Bill's personal) for reading channels Bill is in */
    private reader: WebClient;
    /** Bot token (xoxb) for posting replies and reactions */
    private writer: WebClient;
    private finale: FinaleClient;
    private interval: ReturnType<typeof setInterval> | null = null;
    private channelCache = new Map<string, string>(); // name → id
    private lastPollTs: Record<string, number> = {}; // channelId → timestamp
    private seenCache = new Set<string>(); // "channelId:messageTs"
    private ownerUserId: string | null;
    private startedAt = Date.now();

    constructor(userToken: string, botToken: string) {
        this.reader = new WebClient(userToken);
        this.writer = new WebClient(botToken);
        this.finale = new FinaleClient();
        this.ownerUserId = process.env.SLACK_OWNER_USER_ID || null;
    }

    /**
     * Start polling. Discovers channels first, then polls every 60s.
     * Call once at boot after environment is ready.
     */
    async start(): Promise<void> {
        console.log("[slack-detector] Starting Slack request detector...");

        try {
            await this.discoverChannels();
        } catch (err: any) {
            console.warn(
                `[slack-detector] Channel discovery failed: ${err.message}`,
            );
            console.warn(
                "[slack-detector] Make sure bot is added to #purchase-orders and #purchasing.",
            );
            return;
        }

        if (this.channelCache.size === 0) {
            console.warn(
                "[slack-detector] No watchable channels found. Bot must be added to #purchase-orders and #purchasing.",
            );
            return;
        }

        const channelNames = Array.from(this.channelCache.keys()).join(", ");
        console.log(
            `[slack-detector] Watching ${this.channelCache.size} channel(s): ${channelNames}`,
        );

        // Fire first poll immediately
        await this.pollAll().catch((err) =>
            console.warn(`[slack-detector] First poll failed: ${err.message}`),
        );

        this.interval = setInterval(() => {
            this.pollAll().catch((err) =>
                console.warn(
                    `[slack-detector] Poll failed: ${err.message}`,
                ),
            );
        }, POLL_INTERVAL_MS);

        console.log(
            `[slack-detector] Polling every ${POLL_INTERVAL_MS / 1000}s`,
        );
    }

    /** Stop polling. */
    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        console.log("[slack-detector] Stopped.");
    }

    // ── Channel Discovery ─────────────────────────────────────────────────

    /**
     * Find channel IDs by name using conversations.list.
     * Bot must have channels:read scope and be added to target channels.
     * Tries to auto-join public channels so manual invitation isn't needed.
     */
    private async discoverChannels(): Promise<void> {
        let cursor: string | undefined;
        let pages = 0;

        while (pages < 5) {
            const result = await this.reader.conversations.list({
                types: "public_channel,private_channel",
                limit: 200,
                cursor,
            });

            for (const ch of result.channels || []) {
                if (ch.name && ch.id) {
                    const name = ch.name.toLowerCase();
                    if (WATCH_CHANNEL_NAMES.includes(name)) {
                        this.channelCache.set(name, ch.id);
                        // Try auto-join for public channels
                        if (ch.is_channel && !ch.is_member) {
                            try {
                                await this.reader.conversations.join({ channel: ch.id });
                                console.log(`[slack-detector] Auto-joined #${ch.name}`);
                            } catch {
                                // join failed — bot may not have permission
                            }
                        }
                    }
                }
            }

            cursor =
                (result as any).response_metadata?.next_cursor || undefined;
            if (!cursor) break;
            pages++;
        }
    }

    // ── Polling ──────────────────────────────────────────────────────────

    private async pollAll(): Promise<void> {
        const channelIds = Array.from(this.channelCache.entries());
        const promises = channelIds.map(([name, id]) =>
            this.pollChannel(name, id),
        );
        await Promise.allSettled(promises);
    }

    private async pollChannel(
        channelName: string,
        channelId: string,
    ): Promise<void> {
        try {
            const now = Date.now();
            const oldest = Math.floor((now - LOOKBACK_MS) / 1000);
            const oldestStr = String(oldest);

            const result = await this.reader.conversations.history({
                channel: channelId,
                oldest: oldestStr,
                limit: 20,
            });

            const messages = (result.messages || []) as any[];

            // Filter to new messages since last poll
            const lastPoll =
                this.lastPollTs[channelId] || (now - LOOKBACK_MS);
            const newMessages = messages.filter((m: any) => {
                const mTs = parseFloat(m.ts || "0") * 1000;
                return mTs > lastPoll && mTs > this.startedAt;
            });

            if (newMessages.length === 0) return;

            this.lastPollTs[channelId] = now;

            for (const msg of newMessages) {
                await this.processMessage(channelName, channelId, msg);
            }
        } catch (err: any) {
            // Quiet skip for permanent conditions
            const errCode = err?.data?.error || "";
            if (
                errCode === "ratelimited" ||
                errCode === "not_in_channel" ||
                err?.message?.includes("ratelimit")
            ) {
                return;
            }
            console.warn(
                `[slack-detector] pollChannel #${channelName}: ${err.message}`,
            );
        }
    }

    // ── Message Processing ────────────────────────────────────────────────

    private async processMessage(
        channelName: string,
        channelId: string,
        msg: any,
    ): Promise<void> {
        const ts = msg.ts as string;
        const dedupKey = `${channelId}:${ts}`;

        // Dedup
        if (this.seenCache.has(dedupKey)) return;
        this.seenCache.add(dedupKey);

        // Skip old messages (still being typed)
        const msgAge = Date.now() - parseFloat(ts) * 1000;
        if (msgAge < MIN_AGE_MS) return;

        // Skip bot's own messages
        if (msg.subtype === "bot_message" || msg.bot_id) return;

        const text = (msg.text || "") as string;
        if (!text.trim()) return;

        // Bill's messages: skip by default. Process only if he's asking a
        // question or requesting data. The detector is a SKU listener, not
        // a chat companion — Bill usually posts in #purchasing to ask for
        // POs or request status checks. Anything else is noise.
        //
        // 2026-06-09: Heuristic for "looks like a data request":
        //   - Contains "?" (any question)
        //   - Starts with imperative verbs: show, list, what, how, check,
        //     status, give, find, count, get, where, when, why, who
        //   - Contains a bot mention: @purchase, @aria
        //   - Contains a SKU token (extractSKUs picks it up)
        //   - Starts with "/" (slash command, e.g. /buildrisk)
        //
        // If the message has a SKU token in it, the SKU branch handles
        // it — we don't need a separate check. The first three are
        // for the data-request case where Bill doesn't include a SKU
        // but wants to know something.
        const userId = msg.user as string | undefined;
        if (userId && this.ownerUserId && userId === this.ownerUserId) {
            if (!looksLikeDataRequest(text)) return;
            console.log(`[slack-detector] Processing Bill's message (data request): "${text.slice(0, 80)}"`);
        }

        // Extract SKUs
        const rawTokens = extractSKUs(text);
        if (rawTokens.length === 0) return;

        // Resolve aliases — "0811 BAGS" → SBD21410811, "BAV5LBBAG" → same, etc.
        // Falls back to the raw token when no alias match (Finale will attempt lookup).
        const resolvedSkus: Array<{ displayToken: string; finaleSku: string }> = [];
        for (const token of rawTokens) {
            const expanded = expandSkuToken(token);
            for (const e of expanded) {
                resolvedSkus.push({
                    displayToken: e.aliasName,
                    finaleSku: e.finaleSku ?? token, // use alias Finale SKU, or fall back to raw
                });
            }
        }

        console.log(
            `[slack-detector] #${channelName}: SKUs detected: ${resolvedSkus.map(s => `${s.displayToken}${s.finaleSku !== s.displayToken ? '→' + s.finaleSku : ''}`).join(", ")}`,
        );

        // Check each SKU in Finale FIRST — only respond publicly if we know something
        let hasPO = false;
        let foundInFinale = false;
        for (const { displayToken, finaleSku } of resolvedSkus) {
            try {
                const product = await this.finale.lookupProduct(finaleSku);
                foundInFinale = true;
                const onOrderPOs = (product?.openPOs || []).filter(
                    (po) =>
                        po.status !== "CANCELLED" &&
                        po.status !== "CLOSED",
                );

                if (onOrderPOs.length > 0) {
                    hasPO = true;
                    // 👀 first so people know we saw it
                    await this.addEyesReaction(channelId, ts).catch(() => {});

                    // Post threaded reply with PO info
                    await this.postOrderInfo(
                        channelId,
                        ts,
                        displayToken,
                        onOrderPOs,
                        product?.name,
                    );

                    // Replace 👀 with random ack emoji
                    await this.replaceWithAck(channelId, ts).catch(() => {});
                }
            } catch {
                // SKU not found in Finale — complete silence
            }
        }

        // Record to slack_requests regardless
        await this.recordRequest(
            channelName,
            channelId,
            ts,
            userId,
            text,
            resolvedSkus.map(s => s.finaleSku),
        ).catch(() => {});

        // No open PO found — render per-vendor draft POs in TG DM only.
        // Reads the latest build_risk_snapshot (which already has FG-traceback
        // 30d need, onHand, incomingPOs, vendorName, leadTimeDays populated)
        // so we don't hammer Finale per request. Silent on Slack — per the
        // "no PO → silent Slack, TG DM Bill" convention.
        if (!hasPO && foundInFinale) {
            const slackLink = `https://slack.com/archives/${channelId}/${ts.replace(".", "")}`;

            // Resolve requester name (best-effort)
            let requesterName = "someone";
            if (msg.user) {
                try {
                    const ui = await this.writer.users.info({ user: msg.user });
                    requesterName = ui.user?.real_name || ui.user?.name || "someone";
                } catch { /* fallback */ }
            }

            // Fetch latest snapshot for the 30d coverage math.
            // Single Supabase query — uses the snapshot the morning
            // build-risk cron already populated.
            type SnapEntry = {
                onHand: number | null;
                incomingPOs?: Array<{ quantity?: number; expectedDelivery?: string }>;
                totalRequiredQty?: number;
                leadTimeDays?: number | null;
                vendorName?: string | null;
                productName?: string | null;
                usedIn?: string[];
            };
            let snapComps: Record<string, SnapEntry> = {};
            try {
                const { createClient } = await import("../supabase");
                const db = createClient();
                if (db) {
                    const { data } = await db
                        .from("build_risk_snapshots")
                        .select("components")
                        .order("generated_at", { ascending: false })
                        .limit(1)
                        .single();
                    snapComps = ((data as any)?.components ?? {}) as Record<string, SnapEntry>;
                }
            } catch { /* snapshot unavailable — proceed with empty, fall through to fresh Finale data */ }

            // Build per-SKU lines (canonical SKUs from alias resolution).
            // For each SKU: onHand, incoming, 30d need, gap, vendor, lead time, ETA.
            type LineEntry = {
                displayToken: string;
                finaleSku: string;
                productName: string | null;
                vendor: string;
                onHand: number;
                incoming: number;
                need30: number;
                gap: number;
                leadTimeDays: number;
                eta: string;
                covered: boolean;
            };
            const today = new Date();
            const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
            const lines: LineEntry[] = [];
            for (const { displayToken, finaleSku } of resolvedSkus) {
                // Prefer the snapshot (already FG-traceback'd). Fall back to
                // the openPOs we already fetched from lookupProduct if the
                // snapshot doesn't have this SKU.
                const c = snapComps[finaleSku];
                let onHand: number;
                let incoming: number;
                let need30: number;
                let vendor: string;
                let leadTime: number;
                let productName: string | null;

                if (c) {
                    onHand = c.onHand ?? 0;
                    incoming = (c.incomingPOs ?? []).reduce((s, p) => s + (p.quantity ?? 0), 0);
                    need30 = Math.round(c.totalRequiredQty ?? 0);
                    vendor = c.vendorName ?? "Unknown vendor";
                    leadTime = c.leadTimeDays ?? 14;
                    productName = c.productName ?? null;
                } else {
                    // Fallback: product-level data already in hand from
                    // the hasPO loop above (we called lookupProduct).
                    // Without the snapshot we don't have 30d need — show
                    // what we have and let Bill know the snapshot was
                    // missing.
                    onHand = 0;
                    incoming = 0;
                    need30 = 0;
                    vendor = "Unknown vendor";
                    leadTime = 14;
                    productName = null;
                }
                const totalSupply = onHand + incoming;
                const gap = Math.max(0, need30 - totalSupply);
                const eta = (() => {
                    const etaMs = today.getTime() + leadTime * 86_400_000;
                    return fmtDate(new Date(etaMs));
                })();
                lines.push({
                    displayToken, finaleSku, productName, vendor,
                    onHand: Math.round(onHand), incoming: Math.round(incoming),
                    need30, gap, leadTimeDays: leadTime, eta,
                    covered: gap === 0,
                });
            }

            // Group by vendor for the consolidated draft-PO summary.
            const byVendor = new Map<string, LineEntry[]>();
            for (const l of lines) {
                if (l.covered) continue; // skip already-covered items from PO summary
                const arr = byVendor.get(l.vendor) ?? [];
                arr.push(l);
                byVendor.set(l.vendor, arr);
            }

            // Build the Telegram message.
            const out: string[] = [];
            out.push(`📦 Slack request from *${requesterName}* in #${channelName}`);
            out.push("");
            out.push("Stock check (30d FG build horizon):");
            for (const l of lines) {
                const namePart = l.productName ? ` (${l.productName.slice(0, 38)})` : "";
                out.push(`  \`${l.finaleSku}\`${namePart}`);
                out.push(`    ${l.vendor} · ${l.leadTimeDays}d lead · ETA ${l.eta}`);
                out.push(`    on hand ${l.onHand}  ·  incoming ${l.incoming}  ·  30d need ${l.need30}  ·  gap ${l.gap}`);
                if (l.covered) out.push("    ✅ already covered");
                else out.push(`    → order ${l.gap} units`);
            }
            out.push("");
            if (byVendor.size === 0) {
                out.push("All items already covered by current stock + incoming POs — no order needed.");
            } else {
                out.push("📋 Draft POs (consolidated by vendor):");
                let n = 1;
                for (const [vendor, items] of byVendor) {
                    const totalQty = items.reduce((s, i) => s + i.gap, 0);
                    out.push(`  ${n}. ${vendor} — ${totalQty} units, ETA ${items[0]?.eta}`);
                    for (const i of items) {
                        out.push(`     • ${i.finaleSku} × ${i.gap}  (${i.leadTimeDays}d lead)`);
                    }
                    n++;
                }
            }
            out.push("");
            out.push("Quiet — no public Slack post.");
            out.push(`[Slack →](${slackLink})`);

            await sendTelegramNotify(out.join("\n")).catch(() => {});
            console.log(`[request-detector] TG DM sent: ${lines.length} SKU(s), ${byVendor.size} vendor(s) need POs`);
        }
        // If !foundInFinale: complete silence, no trace in Slack
    }

    // ── Actions ───────────────────────────────────────────────────────────

    /** Three ack emojis picked from randomly to vary the response */
    private readonly ACK_EMOJIS = ["+1", "white_check_mark", "ok_hand"];

    private async addEyesReaction(
        channelId: string,
        ts: string,
    ): Promise<void> {
        try {
            await this.writer.reactions.add({
                channel: channelId,
                timestamp: ts,
                name: "eyes",
            });
        } catch (err: any) {
            // already_reacted is fine
            if (err?.data?.error !== "already_reacted") {
                console.warn(
                    `[slack-detector] 👀 reaction failed: ${err.message}`,
                );
            }
        }
    }

    /**
     * Remove 👀 and add a random ack emoji from the set.
     * Varies the response so it doesn't look automated.
     */
    private async replaceWithAck(
        channelId: string,
        ts: string,
    ): Promise<void> {
        // Remove 👀 (best-effort)
        try {
            await this.writer.reactions.remove({
                channel: channelId,
                timestamp: ts,
                name: "eyes",
            });
        } catch {
            // not always possible to remove — move on
        }

        // Add a random ack emoji
        const pick = this.ACK_EMOJIS[Math.floor(Math.random() * this.ACK_EMOJIS.length)];
        try {
            await this.writer.reactions.add({
                channel: channelId,
                timestamp: ts,
                name: pick,
            });
        } catch {
            // reaction may already exist — fine
        }
    }

    /**
     * Post a threaded reply with PO info.
     *
     * Bill's voice — short, direct, no fluff:
     *   EM108 → PO-124849, ETA TBD
     *   EM108 → PO-124849 (ETA 6/10) + PO-124850 (ETA 6/15)
     */
    private async postOrderInfo(
        channelId: string,
        threadTs: string,
        sku: string,
        pos: any[],
        productName?: string,
    ): Promise<void> {
        // 2026-06-09: Reformatted per Bill's spec — "sounds like purchase
        // sensei bill, not Ai generated". One line per PO. BOLD via Slack
        // mrkdwn (`*text*`). Format: `*SKU - <url|PO#XXXXXX> - ETA (date)*`.
        // Cap at 3 POs to keep the thread tight; if more, the first 3 are
        // enough to confirm "we have orders" — a separate escalation can
        // handle the rare multi-PO SKU.
        //
        // 2026-06-09 (cont.): state labels — DRAFT and COMMITTED get
        // explicit `(STATE)` markers so Bill can tell at a glance which
        // POs are still being assembled vs already sent. SENT / OPEN /
        // PARTIAL are normal states and get no label.
        const maxPOs = Math.min(pos.length, 3);
        const lines: string[] = [];

        for (let i = 0; i < maxPOs; i++) {
            const po = pos[i];
            const eta = po.expectedDelivery
                ? new Date(po.expectedDelivery).toLocaleDateString("en-US", {
                      month: "numeric",
                      day: "numeric",
                      timeZone: "UTC",
                  })
                : "TBD";
            const url = buildFinalePOUrl(po.orderId);
            const stateLabel = formatPOStateLabel(po.status);
            const line = `*${sku} - <${url}|${po.orderId}> - ETA (${eta})${stateLabel}*`;
            lines.push(line);
        }

        const text = lines.join("\n");

        try {
            await this.reader.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text,
                mrkdwn: true,
                unfurl_links: false,
                unfurl_media: false,
            });

            console.log(
                `[slack-detector] Thread reply: ${sku} → ${pos.length} PO(s)`,
            );
        } catch (err: any) {
            console.warn(
                `[slack-detector] Thread reply failed: ${err.message}`,
            );
        }
    }

    // ── Persistence ──────────────────────────────────────────────────────

    private async recordRequest(
        channelName: string,
        channelId: string,
        messageTs: string,
        userId: string | undefined,
        text: string,
        skus: string[],
    ): Promise<void> {
        const db = createClient();
        if (!db) return;

        // Look up user name (best-effort)
        let userName = "someone";
        if (userId) {
            try {
                const userInfo = await this.writer.users.info({
                    user: userId,
                });
                userName =
                    userInfo.user?.real_name ||
                    userInfo.user?.name ||
                    "someone";
            } catch {
                // fallback
            }
        }

        await db
            .from("slack_requests")
            .insert({
                channel_id: channelId,
                channel_name: channelName,
                message_ts: messageTs,
                requester_user_id: userId || null,
                requester_name: userName,
                original_text: text.slice(0, 500),
                items_requested: skus,
                status: "pending",
                created_at: new Date().toISOString(),
            })
            .then(() => {
                console.log(
                    `[slack-detector] Recorded from ${userName} in #${channelName}: ${skus.join(", ")}`,
                );
            })
            .catch((err: any) => {
                console.warn(
                    `[slack-detector] Failed to record request: ${err.message}`,
                );
            });
    }
}

// ── Singleton Lifetime ────────────────────────────────────────────────────

let _instance: SlackRequestDetector | null = null;

/**
 * Start the Slack request detector as part of the bot boot sequence.
 * Call once from start-bot.ts. Uses SLACK_BOT_TOKEN from env.
 * Returns immediately if token missing.
 */
export async function startSlackRequestDetector(): Promise<void> {
    if (_instance) {
        console.log("[slack-detector] Already running.");
        return;
    }

    const botToken = process.env.SLACK_BOT_TOKEN;
    const userToken = process.env.SLACK_ACCESS_TOKEN;
    if (!botToken || !userToken) {
        console.log("[slack-detector] SLACK_BOT_TOKEN or SLACK_ACCESS_TOKEN not set -- disabled.");
        return;
    }

    _instance = new SlackRequestDetector(userToken, botToken);
    await _instance.start();
}

/**
 * Stop the running detector. Called during shutdown.
 */
export async function stopSlackRequestDetector(): Promise<void> {
    _instance?.stop();
    _instance = null;
}