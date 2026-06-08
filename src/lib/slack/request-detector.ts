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
 * Build a Finale PO URL for Slack link unfurling.
 */
function buildFinalePOUrl(orderId: string): string {
    const base = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
    const encoded = Buffer.from(
        `/${accountPath}/api/order/purchase/${orderId}`,
    ).toString("base64");
    return `${base}/${accountPath}/sc2/?order/purchase/order/${encoded}`;
}

/**
 * Extract potential SKU codes from text.
 * Heuristic: tokens with letter+digit mix (3-15 chars) PLUS digit-first
 * patterns like "0811 BAGS" / "0711 BAGS" where digits are followed by
 * a letter-word. Filters out pure-letter common words.
 */
function extractSKUs(text: string): string[] {
    const upper = text.toUpperCase();

    // Pattern 1: Classic mixed SKUs — starts with letter, has digit
    // e.g. CRAFT4L, HAL100, BAV5LBBAG, GBB06, ACTV101, FM104
    const mixedMatches = upper.match(/\b[A-Z][A-Z0-9]{2,14}\b/g) || [];

    // Pattern 2: Digit-first SKU labels — digits followed by a letter-word
    // e.g. "0811 BAGS" → 0811BAGS, "0711 BAGS" → 0711BAGS
    const digitFirst = upper.match(/\b\d{3,6}\s[A-Z]{2,8}\b/g) || [];

    const unique = new Set<string>();

    for (const token of mixedMatches) {
        // Must have at least one digit AND one letter
        if (/[A-Z]/.test(token) && /\d/.test(token)) {
            unique.add(token);
        }
    }

    for (const token of digitFirst) {
        // Strip whitespace → "0811BAGS", "0711BAGS"
        unique.add(token.replace(/\s+/g, ""));
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

        // Skip messages from Bill
        const userId = msg.user as string | undefined;
        if (userId && this.ownerUserId && userId === this.ownerUserId) return;

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

        // No open PO found — notify Bill via Telegram so he can act on the request
        if (!hasPO && foundInFinale) {
            const slackLink = `https://slack.com/archives/${channelId}/${ts.replace(".", "")}`;
            const skuLine = resolvedSkus.map(s => s.displayToken).join(", ");

            // Resolve requester name (best-effort)
            let requesterName = "someone";
            if (msg.user) {
                try {
                    const ui = await this.writer.users.info({ user: msg.user });
                    requesterName = ui.user?.real_name || ui.user?.name || "someone";
                } catch { /* fallback */ }
            }

            const tgMsg = [
                `📥 Slack purchase request from *${requesterName}* in #${channelName}`,
                ``,
                `*SKUs:* ${skuLine}`,
                ``,
                `"${(msg.text || "").slice(0, 120)}${(msg.text || "").length > 120 ? "…" : ""}"`,
                ``,
                `Not on order. [Slack →](${slackLink})`,
            ].join("\n");

            await sendTelegramNotify(tgMsg).catch(() => {});
            console.log('[request-detector] Telegram alert sent for Slack purchase request');
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
        const pieces: string[] = [];
        const maxPOs = Math.min(pos.length, 3);

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
            const qty = po.quantityOnOrder ?? "?";
            pieces.push(`<${url}|${po.orderId}> (ETA ${eta}, ${qty} units)`);
        }

        const text = `${sku} → ${pieces.join(" + ")}`;

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