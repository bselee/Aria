/**
 * @file    src/lib/tracking/email-tracking-ingest.ts
 * @purpose Scans Gmail (both main + AP inbox) for vendor shipping confirmations,
 *          extracts tracking numbers + PO numbers, detects carrier, and upserts
 *          to the shipments table so the dashboard, carrier-poll, and Slack
 *          detector can all surface tracking status.
 *
 *          Solves the "manual tracking insert" workflow: vendor emails a tracking
 *          number, Bill previously had to Google the carrier, paste it into the
 *          tracking URL, and mentally link it to a PO. Now automated.
 *
 * @author  Hermia
 * @created 2026-06-09
 * @deps    @googleapis/gmail, @/lib/carriers/tracking-service,
 *          @/lib/tracking/shipment-intelligence, @/lib/gmail/auth,
 *          @/lib/intelligence/po-correlator (extractPONumber reuse)
 * @env     Gmail OAuth tokens for 'default' and 'ap' accounts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import {
    detectLTLCarrier,
    detectCarrier,
    carrierUrl,
    TRACKING_PATTERNS,
    extractTrackingNumbers,
} from "@/lib/carriers/tracking-service";
import * as shipmentIntelligence from '@/lib/tracking/shipment-intelligence';
import { sendTelegramNotify } from "@/lib/intelligence/telegram-notify";

// ── Config ────────────────────────────────────────────────────────────────

/** Gmail search query for shipping/tracking emails. */
const SHIPPING_SEARCH_QUERY = [
    "newer_than:2d",
    "-from:buildasoil.com",
    "-from:finaleinventory.com",
    "(shipped OR \"picked up\" OR tracking OR freight OR pallet OR PRO OR \"bill of lading\" OR BOL OR \"tracking number\"",
    " OR \"ship date\" OR \"ship today\")"
].join(" ");

/**
 * Sender domains that send emails with shipping/tracking keywords but are
 * NOT actual shipping notifications. We skip these to avoid false positives.
 * - plutonian.io: Stockie inventory OOS alerts
 * - info.printful.com: Printful store digest
 * - dlwholesale.com: marketing newsletters
 * - notification.intuit.com: QuickBooks invoices (carrier detection handled separately)
 */
const SKIP_SENDER_DOMAINS: Set<string> = new Set([
    "plutonian.io",
    "info.printful.com",
    "dlwholesale.com",
]);

/** Max emails to process per account per run. */
const MAX_EMAILS_PER_ACCOUNT = 25;

/** Gmail accounts to scan. */
const GMAIL_ACCOUNTS: Array<{ id: string; label: string }> = [
    { id: "default", label: "bill.selee" },
    { id: "ap",      label: "ap inbox" },
];

/** Max seen-message-IDs to retain (LRU eviction). */
const SEEN_CACHE_MAX = 1000;

/** Sleep between API calls to respect rate limits. */
const API_SLEEP_MS = 200;

// ── Types ─────────────────────────────────────────────────────────────────

interface IngestResult {
    account: string;
    scanned: number;
    newEmails: number;
    trackingFound: number;
    poFound: number;
    upserted: number;
    errors: number;
    details: IngestDetail[];
}

interface IngestDetail {
    messageId: string;
    subject: string;
    from: string;
    poNumbers: string[];
    trackingNumbers: Array<{ carrier: string; number: string }>;
    detectedCarrier: string | null;
    finalCarrier: string | null;
    trackingUrl: string | null;
    action: "upserted" | "skipped_no_tracking" | "error";
}

// ── Seen-ID Cache ────────────────────────────────────────────────────────

const seenCacheDir = join(
    homedir(),
    "AppData",
    "Local",
    "hermes",
    "cache",
    "email-tracking-ingest",
);
const seenCacheFile = join(seenCacheDir, "seen-message-ids.json");

function loadSeenIds(): Set<string> {
    try {
        if (existsSync(seenCacheFile)) {
            const raw = readFileSync(seenCacheFile, "utf-8");
            const arr: string[] = JSON.parse(raw);
            return new Set(arr);
        }
    } catch { /* first run */ }
    return new Set();
}

function saveSeenIds(ids: Set<string>): void {
    mkdirSync(seenCacheDir, { recursive: true });
    // Evict oldest entries when over limit (array order = insertion order)
    let arr = Array.from(ids);
    if (arr.length > SEEN_CACHE_MAX) {
        arr = arr.slice(arr.length - SEEN_CACHE_MAX);
    }
    writeFileSync(seenCacheFile, JSON.stringify(arr));
}

// ── Main Entry ────────────────────────────────────────────────────────────

/**
 * Main cron entry point. Scans both Gmail accounts for shipping emails,
 * extracts tracking + PO info, upserts to shipments table.
 */
export async function runEmailTrackingIngest(): Promise<IngestResult[]> {
    const seenIds = loadSeenIds();
    const results: IngestResult[] = [];

    for (const account of GMAIL_ACCOUNTS) {
        try {
            const r = await ingestAccount(account.id, account.label, seenIds);
            results.push(r);
        } catch (err: any) {
            console.warn(`[email-tracking-ingest] Account ${account.id} failed: ${err.message}`);
            results.push({
                account: account.id, scanned: 0, newEmails: 0,
                trackingFound: 0, poFound: 0, upserted: 0, errors: 1,
                details: [],
            });
        }
    }

    saveSeenIds(seenIds);

    const totalUpserted = results.reduce((s, r) => s + r.upserted, 0);
    const totalTracking = results.reduce((s, r) => s + r.trackingFound, 0);
    const totalScanned = results.reduce((s, r) => s + r.newEmails, 0);

    console.log(
        `[email-tracking-ingest] Done: ${totalScanned} new emails, ${totalTracking} w/ tracking, ${totalUpserted} upserted`,
    );

    // Alert on TG if something was found
    if (totalTracking > 0) {
        await sendTgSummary(results).catch(() => {});
    }

    return results;
}

// ── Per-Account Ingest ────────────────────────────────────────────────────

async function ingestAccount(
    accountId: string,
    accountLabel: string,
    seenIds: Set<string>,
): Promise<IngestResult> {
    const auth = await getAuthenticatedClient(accountId);
    const gmail = GmailApi({ version: "v1", auth });

    const details: IngestDetail[] = [];
    let scanned = 0;
    let newEmails = 0;
    let trackingFound = 0;
    let poFound = 0;
    let upserted = 0;
    let errors = 0;

    try {
        const res = await gmail.users.messages.list({
            userId: "me",
            q: SHIPPING_SEARCH_QUERY,
            maxResults: MAX_EMAILS_PER_ACCOUNT,
        });

        const messages = res.data.messages || [];
        scanned = messages.length;

        for (const msg of messages) {
            if (!msg.id) continue;

            // Skip already-seen
            if (seenIds.has(msg.id)) continue;
            seenIds.add(msg.id);
            newEmails++;

            try {
                const detail = await processMessage(gmail, msg.id, accountId, accountLabel, seenIds);
                details.push(detail);

                if (detail.trackingNumbers.length > 0) trackingFound++;
                if (detail.poNumbers.length > 0) poFound++;
                if (detail.action === "upserted") upserted++;

                // Rate limiting
                await sleep(API_SLEEP_MS);
            } catch (err: any) {
                console.warn(`[email-tracking-ingest] Message ${msg.id} error: ${err.message}`);
                errors++;
                details.push({
                    messageId: msg.id,
                    subject: "?", from: "?", poNumbers: [],
                    trackingNumbers: [], detectedCarrier: null,
                    finalCarrier: null, trackingUrl: null,
                    action: "error",
                });
            }
        }
    } catch (err: any) {
        // Gmail auth or query failure — don't crash the runner
        if (err?.data?.error !== "ratelimited") {
            console.warn(`[email-tracking-ingest] ${accountLabel}: ${err.message}`);
        }
        errors++;
    }

    return {
        account: accountId, scanned, newEmails,
        trackingFound, poFound, upserted, errors,
        details,
    };
}

// ── Per-Message Processing ────────────────────────────────────────────────

async function processMessage(
    gmail: ReturnType<typeof GmailApi>,
    messageId: string,
    accountId: string,
    accountLabel: string,
    seenIds: Set<string>,
): Promise<IngestDetail> {

    // Get full message (not just metadata — we need body text)
    const msg = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
    });

    const headers = msg.data.payload?.headers || [];
    const subject =
        headers.find((h: any) => h.name?.toLowerCase() === "subject")?.value || "";
    const from =
        headers.find((h: any) => h.name?.toLowerCase() === "from")?.value || "";

    // Skip known non-shipping senders (OOS reports, newsletters, marketing)
    const fromEmail = (from.match(/<([^>]+)>/) || [])[1] || from;
    const fromDomain = fromEmail.split("@")[1]?.toLowerCase() || "";
    if (SKIP_SENDER_DOMAINS.has(fromDomain)) {
        return {
            messageId, subject, from,
            poNumbers: [],
            trackingNumbers: [],
            detectedCarrier: null,
            finalCarrier: null,
            trackingUrl: null,
            action: "skipped_no_tracking",
        };
    }

    // Extract plain text body
    const body = extractPlainText(msg.data.payload);

    // Combine subject + body for extraction
    const fullText = `${subject}\n${body}`;

    // --- PO number extraction ---
    const poNumbers = extractPONumbersFromText(fullText);

    // --- Tracking number extraction (canonical patterns) ---
    const extracted = extractTrackingNumbers(fullText);

    // Also try the LTL PRO suffix pattern (catches "AAA Cooper-71473626-1")
    const ltlProMatches = Array.from(fullText.matchAll(
        new RegExp(TRACKING_PATTERNS.ltlPro, "gi"),
    ));
    for (const match of ltlProMatches) {
        const num = match[1] || match[0];
        if (num && !extracted.some(e => e.trackingNumber === num)) {
            extracted.push({ carrier: "ltl_pro_suffix", trackingNumber: num });
        }
    }

    // --- Carrier detection ---
    // Priority: text context (detectLTLCarrier) wins for LTL names.
    // Then detectCarrier from number format (UPS, FedEx, etc.).
    const textCarrier = detectLTLCarrier(fullText);
    const formatCarrier = extracted.length > 0
        ? detectCarrier(extracted[0].trackingNumber)
        : null;
    const finalCarrier = textCarrier || formatCarrier;

    // --- Build final tracking number (with carrier encoding for URLs) ---
    const primaryTracking = extracted.length > 0
        ? extracted[0]
        : null;
    const trackingNum = primaryTracking?.trackingNumber;

    if (!trackingNum) {
        return {
            messageId, subject, from,
            poNumbers,
            trackingNumbers: [],
            detectedCarrier: textCarrier,
            finalCarrier: null,
            trackingUrl: null,
            action: "skipped_no_tracking",
        };
    }

    // Encode for URL generation: "CarrierName:::TrackingNumber" format enables
    // carrierUrl() to find the right LTL link.
    const encodedTracking = finalCarrier
        ? `${finalCarrier}:::${trackingNum}`
        : trackingNum;
    const trackingUrl = carrierUrl(encodedTracking);

    // --- Upsert to shipments table ---
    for (const poNum of poNumbers.length > 0 ? poNumbers : [null]) {
        try {
          await shipmentIntelligence.upsertShipmentEvidence({
                trackingNumber: encodedTracking,
                poNumber: poNum,
                vendorName: null, // Will be resolved by carrier-poll or manual
                source: "email_ingest",
                sourceRef: `gmail:${accountId}:${messageId}`,
                confidence: 0.90,
                statusCategory: "in_transit",
                statusDisplay: "Tracking extracted from email",
                publicTrackingUrl: trackingUrl,
                active: true,
            });
        } catch (err: any) {
            console.warn(
                `[email-tracking-ingest] Upsert failed for ${trackingNum} PO ${poNum}: ${err.message}`,
            );
        }
    }

    // If no PO number in email, still record the tracking with no PO link
    if (poNumbers.length === 0) {
        try {
          await shipmentIntelligence.upsertShipmentEvidence({
                trackingNumber: encodedTracking,
                poNumber: null,
                vendorName: null,
                source: "email_ingest",
                sourceRef: `gmail:${accountId}:${messageId}`,
                confidence: 0.80, // lower confidence when no PO link
                statusCategory: "in_transit",
                statusDisplay: "Tracking extracted from email (no PO found)",
                publicTrackingUrl: trackingUrl,
                active: true,
            });
        } catch { /* best-effort */ }
    }

    return {
        messageId, subject, from,
        poNumbers,
        trackingNumbers: extracted.map(e => ({ carrier: e.carrier, number: e.trackingNumber })),
        detectedCarrier: textCarrier,
        finalCarrier,
        trackingUrl,
        action: "upserted",
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract plain text from a Gmail message payload.
 * Recursively walks MIME parts, collecting text/plain content.
 */
function extractPlainText(payload: any): string {
    if (!payload) return "";

    // Leaf node with body
    if (payload.body?.data) {
        const decoded = Buffer.from(payload.body.data, "base64url").toString("utf-8");
        if (payload.mimeType === "text/plain") return decoded;
        if (payload.mimeType === "text/html") return htmlToPlainText(decoded);
    }

    // Multipart — recurse into parts
    if (payload.parts) {
        const texts: string[] = [];
        for (const part of payload.parts) {
            const t = extractPlainText(part);
            if (t) texts.push(t);
        }

        // Prefer text/plain over text/html
        const plainParts = payload.parts
            .filter((p: any) => p.mimeType === "text/plain")
            .map((p: any) => extractPlainText(p))
            .filter(Boolean);
        if (plainParts.length > 0) return plainParts.join("\n");

        return texts.join("\n");
    }

    return "";
}

/** Strip HTML tags for rough text extraction. */
function htmlToPlainText(html: string): string {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/?[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n\s*\n\s*\n/g, "\n\n")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Extract PO numbers from text. Reuses the same patterns as
 * po-correlator / Slack request-detector. Handles:
 *   "PO #124833", "PO-124833", "PO 124833", "order 124833",
 *   "71473626-1124833" (Finale vendor-ref format)
 */
function extractPONumbersFromText(text: string): string[] {
    const seen = new Set<string>();

    // Standard PO references
    const poRefMatches = text.match(/(?:PO|#)\s*[-#:]*\s*(\d{5,7})\b/gi) || [];
    for (const m of poRefMatches) {
        const num = m.replace(/\D/g, "");
        if (num.length >= 5 && num.length <= 7) seen.add(num);
    }
    // "order 124833"
    const orderMatches = text.match(/\border\s+[-#:]*(\d{5,7})\b/gi) || [];
    for (const m of orderMatches) {
        const num = m.replace(/\D/g, "");
        if (num.length >= 5 && num.length <= 7) seen.add(num);
    }
    // Finale vendor-ref format: "71473626-1124833" → PO 124833
    // The last 6 digits after the dash are the PO number
    const vendorRefMatches = text.match(/\b\d{7,10}-(\d{6})\b/g) || [];
    for (const m of vendorRefMatches) {
        const parts = m.split("-");
        if (parts.length === 2) {
            const poNum = parts[1]; // last 6 digits = PO number
            seen.add(poNum);
        }
    }

    return Array.from(seen);
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// ── Telegram Summary ──────────────────────────────────────────────────────

async function sendTgSummary(results: IngestResult[]): Promise<void> {
    const upsertedItems = results.flatMap(r =>
        r.details.filter(d => d.action === "upserted"),
    );
    if (upsertedItems.length === 0) return;

    const lines = [`📦 Tracking extracted from email:`];

    for (const item of upsertedItems.slice(0, 8)) {
        const carrier = item.finalCarrier || "Unknown carrier";
        const pos = item.poNumbers.length > 0 ? ` → PO ${item.poNumbers.join(", ")}` : " (no PO link)";
        const nums = item.trackingNumbers.map(t => t.number).join(", ");
        lines.push(`• ${carrier}: ${nums}${pos}`);
        if (item.trackingUrl) {
            lines.push(`  ${item.trackingUrl}`);
        }
    }

    if (upsertedItems.length > 8) {
        lines.push(`… +${upsertedItems.length - 8} more`);
    }

    await sendTelegramNotify(lines.join("\n"));
}
