/**
 * @file    src/lib/tracking/email-tracking-ingest.ts
 * @purpose Scans Gmail (both main + AP inbox) for vendor shipping confirmations,
 *          extracts tracking numbers + PO numbers, detects carrier, and upserts
 *          to the shipments table so the dashboard and carrier-poll can
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
import { matchTrackingToPo } from "./tracking-po-match";
import { learnVendorCarrierCounts } from "./vendor-carrier";
import { leadTimeService } from "@/lib/builds/lead-time-service";
import { extractBolText } from "./bol-ocr";
import { createClient } from "@/lib/db";
import { sendTelegramNotify } from "@/lib/intelligence/telegram-notify";

// ── Config ────────────────────────────────────────────────────────────────

/** Gmail search query for shipping/tracking emails + BOLs + invoice-embedded tracking. */
const SHIPPING_SEARCH_QUERY = [
    "newer_than:2d",
    "-from:buildasoil.com",
    "-from:finaleinventory.com",
    "(",
    "shipped OR \"picked up\" OR tracking OR freight OR pallet OR PRO OR \"bill of lading\" OR BOL",
    " OR \"tracking number\" OR \"ship date\" OR \"ship today\" OR \"pro number\" OR \"pro #\"",
    " OR \"trk#\" OR \"track your shipment\" OR waybill",
    // Invoice-embedded tracking (AutoPot, Uline ship confirms, LTL invoices)
    " OR (invoice AND (tracking OR ups OR fedex OR usps OR pro OR bol OR freight))",
    ")",
].join(" ");

/** Max PDF attachments to OCR per email (cost/latency bound). */
const MAX_PDFS_PER_EMAIL = 3;
/** Skip PDFs larger than this for tracking OCR. */
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const PDF_OCR_TIMEOUT_MS = 20_000;
/**
 * Timeout for the scanned-BOL vision OCR path (extractPDF can chain multiple
 * vision models + tesseract). One long-running email must not stall the run.
 */
const VISION_OCR_TIMEOUT_MS = 90_000;

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
    // Carrier billing invoices — these contain tracking numbers for OUTBOUND
    // shipments (BAS → customer), not inbound vendor shipments. The tracking
    // numbers are FedEx/UPS's own billing line items, not vendor POs.
    // HERMIA(2026-08-26): 947 unlinked FedEx shipments traced to a single
    // FedEx Billing Online invoice email (noreply@fedex.com). These pollute
    // the tracking board with outbound data that has no PO to match.
    "noreply@fedex.com",
    "fedex.com",
    "billing@fedex.com",
    "noreply@ups.com",
    "ups.com",
    "billing@ups.com",
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

    // DECISION(2026-08-05): Also OCR PDF attachments (BOLs, invoices with embedded
    // tracking). Biggest miss class: tracking lives in the PDF, not the email body.
    // WS1 (2026-08-05): sparse scanned BOLs escalate to vision OCR via bol-ocr.ts,
    // capped at 1 vision call per email; visionUsed tags source email_ingest_bol_vision.
    const pdfResult = await extractPdfAttachmentText(
        gmail,
        msg.data.payload,
        messageId,
        `${subject}\n${from}\n${body}`,
    );
    const pdfText = pdfResult.text;

    // Combine subject + body + PDF text for extraction
    const fullText = `${subject}\n${body}\n${pdfText}`;

    // --- PO number extraction ---
    const poNumbers = extractPONumbersFromText(fullText);

    // --- Tracking number extraction (canonical patterns, ranked) ---
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

    if (extracted.length === 0) {
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

    // --- PO number inference fallback ---
    let inferredPO: string | null = null;
    if (poNumbers.length === 0) {
        try {
            const db = createClient();
            if (db) {
                const recentCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
                const { data: recentPOs } = await db
                    .from("purchase_orders")
                    .select("po_number, vendor_name, created_at, lifecycle_state")
                    .gte("created_at", recentCutoff)
                    .limit(200);

                // Fallback 1: tracking number already in vendor_invoices or purchase_orders.
                // This is the strongest signal — if an invoice/PO already has this tracking
                // number, it belongs to that PO. Checks the normalized number (strips carrier prefix).
                for (const hit of extracted) {
                    if (inferredPO) break;
                    const rawNum = hit.trackingNumber;
                    const normalized = rawNum.includes(":::") ? rawNum.split(":::")[1].trim() : rawNum;
                    if (!normalized || normalized.length < 8) continue;

                    // Check vendor_invoices
                    try {
                        const { data: invMatch } = await db
                            .from("vendor_invoices")
                            .select("po_number")
                            .not("po_number", "is", null)
                            .or(`tracking_numbers.cs.{${normalized}},tracking_numbers.cs.{"${normalized}"}`)
                            .limit(1);
                        if (invMatch && invMatch.length > 0 && invMatch[0].po_number) {
                            inferredPO = invMatch[0].po_number;
                            console.log(`[email-tracking-ingest] Matched tracking ${normalized} → PO ${inferredPO} via vendor_invoices`);
                            break;
                        }
                    } catch { /* non-fatal */ }

                    // Check purchase_orders
                    try {
                        const { data: poMatch } = await db
                            .from("purchase_orders")
                            .select("po_number")
                            .or(`tracking_numbers.cs.{${normalized}},tracking_numbers.cs.{"${normalized}"}`)
                            .limit(1);
                        if (poMatch && poMatch.length > 0 && poMatch[0].po_number) {
                            inferredPO = poMatch[0].po_number;
                            console.log(`[email-tracking-ingest] Matched tracking ${normalized} → PO ${inferredPO} via purchase_orders`);
                            break;
                        }
                    } catch { /* non-fatal */ }
                }

                // Fallback 2: exact numeric PO hint (highest precision).
                if (!inferredPO) {
                    inferredPO = inferPONumberFromRecentPOs(
                        { subject, bodySnippet: body, fromEmail },
                        (recentPOs || []) as RecentPurchaseOrder[],
                    );
                }

                // Fallback 3: vendor + carrier + open-PO matching. Carrier-aware
                // (Rootwise ships FedEx ⇒ Oak Harbor can't be Rootwise), open-only,
                // and date-window disambiguated by vendor lead time — replaces the
                // old vendor-token guessing that piled 567 shipments onto PO 125178.
                if (!inferredPO) {
                    const shipmentCarrier =
                        textCarrier ||
                        (extracted.length > 0
                            ? detectCarrier(extracted[0].trackingNumber)
                            : null);

                    // Learned vendor→carrier map (self-improving, from PO tracking).
                    const vendorCarriers = await learnVendorCarrierCounts(db);

                    // Vendor lead times for date-window disambiguation.
                    let leadTimeDays: Map<string, number> | null = null;
                    try {
                        await leadTimeService.warmCache();
                        leadTimeDays = new Map();
                        for (const po of (recentPOs || [])) {
                            if (!po.vendor_name) continue;
                            const key = po.vendor_name.trim().toLowerCase();
                            if (leadTimeDays.has(key)) continue;
                            const lt = await leadTimeService.getForVendor(po.vendor_name);
                            leadTimeDays.set(key, lt.days);
                        }
                    } catch (err: any) {
                        console.warn(`[email-tracking-ingest] lead-time warm failed: ${err.message}`);
                        leadTimeDays = null;
                    }

                    inferredPO = matchTrackingToPo({
                        text: `${fullText}\n${from}\n${fromEmail}`,
                        carrier: shipmentCarrier,
                        recentPOs: (recentPOs || []) as Array<{
                            po_number: string;
                            vendor_name?: string | null;
                            created_at?: string | null;
                            lifecycle_state?: string | null;
                        }>,
                        learnedCarriers: vendorCarriers,
                        leadTimeDays,
                    });
                }

                if (inferredPO) {
                    // Per-PO cap: don't let a single PO accumulate a magnet
                    // of inferred-only shipments. After 10 inferred links,
                    // store tracking numbers unlinked so they don't poison
                    // the PO's shipment count. (P0 fix: PO 125178 / 567 rows)
                    const { data: capData } = await db
                        .from("shipments")
                        .select("id")
                        .overlap("po_numbers", [inferredPO])
                        .eq("last_source", "email_ingest_inferred");
                    const inferredCount = (capData || []).length;

                    if (inferredCount >= 10) {
                        console.log(
                            `[email-tracking-ingest] Skipping inferred PO #${inferredPO} — ` +
                            `already has ${inferredCount} inferred shipments (cap=10)`,
                        );
                        inferredPO = null;
                    }
                }

                if (inferredPO) {
                    console.log(
                        `[email-tracking-ingest] Inferred PO #${inferredPO} for tracking ` +
                        `(no explicit PO in email/PDF text)`,
                    );
                }
            }
        } catch (err: any) {
            console.warn(`[email-tracking-ingest] PO inference failed: ${err.message}`);
        }
    }

    const upsertPOs: Array<{ po: string | null; inferred: boolean }> = [];
    if (poNumbers.length > 0) {
        upsertPOs.push(...poNumbers.map((p) => ({ po: p, inferred: false })));
    } else if (inferredPO) {
        upsertPOs.push({ po: inferredPO, inferred: true });
    } else {
        upsertPOs.push({ po: null, inferred: false });
    }

    // Upsert EVERY high-confidence tracking hit (multi-package shipments)
    let anyUpserted = false;
    let primaryUrl: string | null = null;
    let primaryCarrier: string | null = textCarrier;

    for (const hit of extracted) {
        const formatCarrier = detectCarrier(hit.trackingNumber);
        const finalCarrier = textCarrier || formatCarrier || hit.carrier;
        const trackingNum = hit.trackingNumber;
        const encodedTracking = finalCarrier
            ? `${finalCarrier}:::${trackingNum}`
            : trackingNum;
        const trackingUrl = carrierUrl(encodedTracking);
        if (!primaryUrl) {
            primaryUrl = trackingUrl;
            primaryCarrier = finalCarrier;
        }

        for (const { po: poNum, inferred } of upsertPOs) {
            try {
                await shipmentIntelligence.upsertShipmentEvidence({
                    trackingNumber: encodedTracking,
                    poNumber: poNum,
                    vendorName: null,
                    source: inferred
                        ? "email_ingest_inferred"
                        : pdfResult.visionUsed
                            ? "email_ingest_bol_vision"
                            : pdfText
                                ? "email_ingest_pdf"
                                : "email_ingest",
                    sourceRef: `gmail:${accountId}:${messageId}`,
                    confidence: inferred ? 0.60 : (poNum ? 0.90 : 0.80),
                    statusCategory: "in_transit",
                    statusDisplay: inferred
                        ? "Tracking from email/PDF (PO inferred)"
                        : pdfResult.visionUsed
                            ? "Tracking from scanned BOL (vision OCR)"
                            : poNum
                                ? (pdfText ? "Tracking from email/PDF attachment" : "Tracking extracted from email")
                                : "Tracking extracted (no PO found)",
                    publicTrackingUrl: trackingUrl,
                    active: true,
                });
                anyUpserted = true;
            } catch (err: any) {
                console.warn(
                    `[email-tracking-ingest] Upsert failed for ${trackingNum} PO ${poNum}: ${err.message}`,
                );
            }
        }
    }

    return {
        messageId, subject, from,
        poNumbers: inferredPO && poNumbers.length === 0 ? [inferredPO] : poNumbers,
        trackingNumbers: extracted.map(e => ({ carrier: e.carrier, number: e.trackingNumber })),
        detectedCarrier: textCarrier,
        finalCarrier: primaryCarrier,
        trackingUrl: primaryUrl,
        action: anyUpserted ? "upserted" : "error",
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Download PDF attachments and extract text via pdf-parse (fast path).
 * Used so BOL / invoice PDFs contribute tracking numbers, not just body text.
 *
 * WS1 (2026-08-05): when pdf-parse returns sparse text (< 40 non-ws chars)
 * and the attachment/email looks BOL-like (BOL filename, LTL carrier in the
 * email context, or shipping keywords), escalate to vision OCR via bol-ocr.ts
 * (extractPDF). Capped at 1 vision call per email. Returns { text, visionUsed }
 * so the caller can tag shipments as email_ingest_bol_vision.
 */
async function extractPdfAttachmentText(
    gmail: ReturnType<typeof GmailApi>,
    payload: any,
    messageId: string,
    emailContext: string,
): Promise<{ text: string; visionUsed: boolean }> {
    const parts: Array<{ filename: string; attachmentId: string; inlineData?: string }> = [];

    const walk = (part: any) => {
        if (!part) return;
        const mime = part.mimeType || "";
        const filename = part.filename || "";
        const isPdf = mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
        if (isPdf && filename) {
            if (part.body?.attachmentId) {
                parts.push({ filename, attachmentId: part.body.attachmentId });
            } else if (part.body?.data) {
                parts.push({ filename, attachmentId: "", inlineData: part.body.data });
            }
        }
        if (part.parts) for (const p of part.parts) walk(p);
    };
    walk(payload);

    if (parts.length === 0) return { text: "", visionUsed: false };

    let pdfParse: any;
    try {
         
        pdfParse = (await import("pdf-parse")).default || (await import("pdf-parse"));
    } catch {
        console.warn("[email-tracking-ingest] pdf-parse unavailable — skipping PDF OCR");
        return { text: "", visionUsed: false };
    }

    const texts: string[] = [];
    let visionUsed = false;
    for (const part of parts.slice(0, MAX_PDFS_PER_EMAIL)) {
        try {
            let buf: Buffer;
            if (part.inlineData) {
                buf = Buffer.from(part.inlineData, "base64url");
            } else {
                const att = await gmail.users.messages.attachments.get({
                    userId: "me",
                    messageId,
                    id: part.attachmentId,
                });
                const data = att.data?.data;
                if (!data) continue;
                buf = Buffer.from(data, "base64url");
            }
            if (buf.length === 0 || buf.length > MAX_PDF_BYTES) continue;

            const parsed = await Promise.race([
                pdfParse(buf, { max: 0 }),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("pdf OCR timeout")), PDF_OCR_TIMEOUT_MS),
                ),
            ]);
            const t = (parsed?.text || "").toString().trim();
            if (t.length >= 20) {
                texts.push(`\n--- PDF: ${part.filename} ---\n${t}`);
                console.log(
                    `[email-tracking-ingest] PDF OCR ${part.filename}: ${t.length} chars`,
                );
            }

            // Scanned BOL fallback (WS1): sparse pdf-parse text + BOL-like signals
            // → vision OCR via bol-ocr.ts. Max 1 vision call per email (cost bound).
            if (!visionUsed) {
                const bol = await Promise.race([
                    extractBolText({
                        buffer: buf,
                        filename: part.filename,
                        emailContext,
                        pdfParseText: t,
                        pageCount: parsed?.numpages ?? null,
                    }),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error("BOL vision OCR timeout")), VISION_OCR_TIMEOUT_MS),
                    ),
                ]);
                if (bol.visionUsed) {
                    visionUsed = true;
                    texts.push(`\n--- PDF: ${part.filename} (vision OCR) ---\n${bol.text}`);
                    console.log(
                        `[email-tracking-ingest] BOL vision OCR ${part.filename}: ${bol.text.length} chars`,
                    );
                }
            }
        } catch (err: any) {
            console.warn(
                `[email-tracking-ingest] PDF OCR failed (${part.filename}): ${err.message}`,
            );
        }
    }
    return { text: texts.join("\n"), visionUsed };
}

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
 * po-correlator. Handles:
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

// ── PO Inference Helpers ──
//
// These functions implement a fallback-correlation algorithm for linking
// carrier auto-notification emails (FedEx/UPS/USPS) to purchase orders when
// the email text contains no explicit PO number reference. The algorithm
// matches a numeric hint in the email against known PO numbers (exact match
// only — vendor-name token scoring was removed due to the PO 125178 magnet).

type RecentPurchaseOrder = {
    po_number: string;
    vendor_name?: string | null;
    created_at?: string | null;
};

function extractNumericHints(text: string): string[] {
    return Array.from(new Set((text.match(/\b\d{6,}\b/g) || []).map((value) => value.trim())));
}

/**
 * Attempt to infer the PO number for a carrier notification email by matching
 * a numeric hint in the email against known PO numbers. Returns the PO number
 * only when a numeric hint EXACTLY matches exactly one PO number.
 *
 * DECISION(2026-08-25): Vendor-name token-overlap scoring was REMOVED. It
 * produced the PO 125178 magnet — vendor "Rootwise Soil Dynamics" contains the
 * token "soil", and nearly every BuildASoil carrier email (ship-to address,
 * signature, product lines) contains "soil"/"BuildASoil", so 567 shipments
 * across FedEx/UPS/Oak Harbor/pro were all guessed onto that one PO. A single
 * PO cannot ship hundreds of times across six carriers. Guessing from
 * vendor-name tokens is net-negative; only exact numeric PO matches are kept.
 *
 * @exportedForTesting — exported so unit tests can exercise the pure
 * inference logic without mocking Gmail/Postgres.
 */
export function inferPONumberFromRecentPOs(
    message: { subject?: string | null; bodySnippet?: string | null; fromEmail?: string | null },
    recentPOs: RecentPurchaseOrder[],
): string | null {
    if (!recentPOs.length) return null;

    const subject = String(message.subject || "");
    const bodySnippet = String(message.bodySnippet || "");
    const fromEmail = String(message.fromEmail || "");
    const combinedText = `${subject}\n${bodySnippet}\n${fromEmail}`;
    const numericHints = extractNumericHints(combinedText);

    // DECISION(2026-08-25): Vendor-name token-overlap inference is REMOVED.
    // It produced the PO 125178 magnet — 567 tracking links across FedEx/UPS/
    // Oak Harbor/pro all guessed onto a single Rootwise PO (impossible: one PO
    // can't ship hundreds of times across six carriers). Guessing a PO from
    // vendor-name tokens was net-negative (wrong links ≫ useful links).
    //
    // Now: only infer when the email contains a number that EXACTLY matches a
    // known PO number AND exactly one such PO exists. Explicit-PO extraction
    // (the primary path) is unaffected; this fallback just stops guessing.
    const exactMatches = recentPOs.filter((po) =>
        numericHints.some(
            (hint) => String(po.po_number || "").toLowerCase() === hint.toLowerCase(),
        ),
    );
    if (exactMatches.length === 1) {
        return exactMatches[0].po_number;
    }

    return null;
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
