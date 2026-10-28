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
    isRatingEstimateRef,
} from "@/lib/carriers/tracking-service";
import * as shipmentIntelligence from '@/lib/tracking/shipment-intelligence';
import { extractBolText } from "./bol-ocr";
import { createClient } from "@/lib/db";
import { resolveExtractedPOs } from "@/lib/purchasing/po-ref-validator";
import { notify } from "@/lib/intelligence/notify";

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

    // --- Documentary delivery reconciliation (Guard 11) ---
    // A POD/BOL delivery status or a vendor "delivered on" email proves delivery
    // even when the carrier poll never saw it. Delivery documents supply ZERO PO
    // refs — the PO link must come from the shipped/invoice path, never a POD.
    const docDelivery = detectDocumentaryDelivery(fullText);

    // --- PO number extraction ---
    // Terminal delivery documents (POD/BOL) never re-attach a PO from their
    // body text — SKU#/PRO/SO# lines live there. Their PO must come only from
    // the label-bounded subject/body ("PO # 125333"). Non-terminal signals
    // (vendor email, no delivery) extract from the full text as before.
    const rawPoNumbers = docDelivery?.terminal
        ? extractPONumbersFromText(`${subject}\n${body}`)
        : extractPONumbersFromText(fullText);

    // Gate 8-digit dropship candidates on existence: a bare 235xxxxxxx with no
    // purchase_orders row (cancelled sales order) is dropped, and a real one is
    // rewritten to the DB spelling ("23578097A" -> "23578097A-DropshipPO") so
    // the write joins. Standard 5-7 digit refs pass through untouched.
    const poNumbers = await resolveExtractedPOs(rawPoNumbers);

    // --- Tracking number extraction (canonical patterns, ranked) ---
    const extracted = extractTrackingNumbers(fullText);

    // Also try the LTL PRO suffix pattern (catches "AAA Cooper-71473626-1")
    const ltlProMatches = Array.from(fullText.matchAll(
        new RegExp(TRACKING_PATTERNS.ltlPro, "gi"),
    ));
    for (const match of ltlProMatches) {
        const num = match[1] || match[0];
        // Reject rating-estimate refs (9 digits + "-1") here too: the canonical
        // extractor drops them, and this suffix pass must not re-add what it
        // deliberately removed.
        if (num && !isRatingEstimateRef(num) && !extracted.some(e => e.trackingNumber === num)) {
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

    // --- Sender → vendor resolution (Guard 10) ---
    // Resolve the sender to a canonical vendor before inference, so inference
    // scopes to that vendor's POs and unlinked rows still carry the vendor name.
    let resolvedVendor: string | null = null;
    try {
        resolvedVendor = await resolveSenderVendor(fromEmail);
    } catch (err: any) {
        console.warn(`[email-tracking-ingest] Sender→vendor resolution failed: ${err.message}`);
    }

    // --- PO number inference fallback ---
    let inferredPO: string | null = null;
    if (poNumbers.length === 0 && !docDelivery) {
        try {
            const db = createClient();
            if (db) {
                const recentCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
                const { data: recentPOs } = await db
                    .from("purchase_orders")
                    .select("po_number, vendor_name, created_at")
                    .gte("created_at", recentCutoff)
                    .limit(200);

                inferredPO = inferPONumberFromRecentPOs(
                    { subject, bodySnippet: body, fromEmail },
                    (recentPOs || []) as RecentPurchaseOrder[],
                    resolvedVendor,
                );

                if (inferredPO) {
                    console.log(
                        `[email-tracking-ingest] Inferred PO #${inferredPO} for tracking ` +
                        `(no explicit PO in email/PDF text)`,
                    );
                } else if (resolvedVendor) {
                    console.log(
                        `[email-tracking-ingest] No PO inferred for ${fromEmail} ` +
                        `(vendor=${resolvedVendor}) — leaving unlinked`,
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
        // No PO anywhere — record vendor provenance only (unlinked row).
        upsertPOs.push({ po: null, inferred: false });
    }

    // ── Guard 12 (magnet containment, 2026-09-30) ──────────────────────────
    // The loop below is a CARTESIAN PRODUCT: every tracking number in the
    // email/PDF is attached to EVERY PO number extracted from the same
    // document. A carrier manifest listing 678 FedEx numbers alongside four
    // PO references therefore wrote 678×4 rows — each PO reported the full
    // manifest as its own tracking set (125213 ∩ 670549 = 678), every PO
    // looked fully tracked, and nothing distinguished the real PO from the
    // three wrong ones. There is no per-line PO mapping in these documents,
    // so the honest outcome is UNLINKED: record the numbers, refuse to
    // attribute them. Better a PO with no tracking than a PO with someone
    // else's manifest.
    //
    // The decision itself lives in applyManifestContainment() so the boundary
    // (>50 vs exactly 50) is unit-tested rather than implied by a ternary.
    const containment = applyManifestContainment(extracted.length, upsertPOs);
    if (containment.refused) {
        console.warn(
            `[email-tracking-ingest] ${extracted.length} trackings in one message ` +
            `(>${MAX_TRACKINGS_PER_INGEST}) — manifest-sized; refusing PO attribution ` +
            `(would have attached to ${containment.refusedPOs.length || 0} PO(s): ${containment.refusedPOs.slice(0, 8).join(", ") || "none"}). ` +
            `Recording ${extracted.length} tracking(s) UNLINKED.`,
        );
        upsertPOs.length = 0;
        upsertPOs.push(...containment.poUpserts);
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

        // Resolve the shipment's already-recorded vendor names once per hit, for
        // both the delivery-annotation gate (Guard 11 #5) and vendor-name hygiene
        // (Guard 11 #6) below.
        let existingVendors: string[] = [];
        if (resolvedVendor || (docDelivery && !docDelivery.terminal)) {
            const vendorDb = createClient();
            const norm = shipmentIntelligence.normalizeTrackingIdentity(encodedTracking);
            if (vendorDb) {
                try {
                    const { data: existingRow } = await vendorDb
                        .from("shipments")
                        .select("vendor_names")
                        .eq("tracking_key", norm.trackingKey)
                        .maybeSingle();
                    if (Array.isArray(existingRow?.vendor_names)) {
                        existingVendors = existingRow.vendor_names;
                    }
                } catch (err: any) {
                    console.warn(`[email-tracking-ingest] existing vendor lookup failed: ${err.message}`);
                }
            }
        }

        // Guard 11 #5 (sender→vendor gate): the vendor "delivered on" email is
        // the weakest signal in the detector. Its annotation only lands when the
        // sender resolves to a known vendor, and — for an existing row — when
        // that vendor matches a recorded vendor name. Terminal POD/BOL docs and
        // normal emails are unaffected.
        const deliveryDocForHit: DocumentaryDelivery | null =
            docDelivery && !docDelivery.terminal
                ? (vendorDeliveryAnnotationAllowed(resolvedVendor, existingVendors) ? docDelivery : null)
                : docDelivery;

        for (const { po: poNum, inferred } of upsertPOs) {
            try {
                await shipmentIntelligence.upsertShipmentEvidence({
                    trackingNumber: encodedTracking,
                    poNumber: poNum,
                    vendorName: vendorNameForUpsert(poNum, resolvedVendor, existingVendors),
                    source: deliveryDocForHit
                        ? (deliveryDocForHit.terminal ? "documentary_delivery" : "vendor_delivered_email")
                        : inferred
                            ? "email_ingest_inferred"
                            : pdfResult.visionUsed
                                ? "email_ingest_bol_vision"
                                : pdfText
                                    ? "email_ingest_pdf"
                                    : "email_ingest",
                    sourceRef: `gmail:${accountId}:${messageId}`,
                    confidence: deliveryDocForHit
                        ? (deliveryDocForHit.terminal ? 0.95 : 0.70)
                        : (inferred ? 0.60 : (poNum ? 0.90 : 0.80)),
                    statusCategory: deliveryDocForHit && deliveryDocForHit.terminal ? "delivered" : "in_transit",
                    statusDisplay: deliveryDocForHit
                        ? deliveryDocForHit.note
                        : inferred
                            ? "Tracking from email/PDF (PO inferred)"
                            : pdfResult.visionUsed
                                ? "Tracking from scanned BOL (vision OCR)"
                                : poNum
                                    ? (pdfText ? "Tracking from email/PDF attachment" : "Tracking extracted from email")
                                    : "Tracking extracted (no PO found)",
                    deliveredAt: deliveryDocForHit && deliveryDocForHit.terminal ? deliveryDocForHit.deliveredAt : undefined,
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
        // eslint-disable-next-line @typescript-eslint/no-require-imports
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
 * Guard 12 — manifest containment (ingest side). The PO-attribution loop is a
 * cartesian product: every extracted tracking is attached to every PO found in the
 * same document. A carrier manifest (678 FedEx numbers beside four PO refs) therefore
 * poisoned all four POs with the full manifest, and nothing distinguished the real PO.
 * These documents carry no per-line PO mapping, so above the threshold the honest
 * outcome is UNLINKED: record the trackings, attribute none of them.
 *
 * The failure modes are asymmetric, which is why the default is unlink rather than
 * best-guess: an unlinked parcel is visible and repairable; a wrongly attributed one
 * is indistinguishable from a correct link once written.
 *
 * @exportedForTesting
 */
export const MAX_TRACKINGS_PER_INGEST = 50;

/**
 * Decide whether a message is manifest-sized and, if so, replace its PO attribution
 * with a single unlinked entry. Pure: returns the caller's array untouched when the
 * message is under the threshold, so a normal shipment keeps its attribution exactly.
 *
 * @exportedForTesting
 */
export function applyManifestContainment<T extends { po: string | null; inferred: boolean }>(
    trackingCount: number,
    poUpserts: T[],
    max: number = MAX_TRACKINGS_PER_INGEST,
): { poUpserts: T[]; refused: boolean; refusedPOs: string[] } {
    if (trackingCount <= max) {
        return { poUpserts, refused: false, refusedPOs: [] };
    }
    const refusedPOs = poUpserts.map((u) => u.po).filter((p): p is string => Boolean(p));
    return {
        poUpserts: [{ po: null, inferred: false } as T],
        refused: true,
        refusedPOs,
    };
}

/**
 * Extract PO numbers from text using label-bounded matching (Guard 9).
 *
 * A number is a PO candidate ONLY when an explicit PO / P.O. / Purchase Order
 * label introduces it. Numbers introduced by any other label — SKU# / SO# /
 * Sales Order / Order # / Cust. Ref. / ESTIMATE / BOL / invoice / PRO — are the
 * counterparty's own numbering (SKU, sales order, customer reference, freight
 * estimate) and must NEVER become a PO. The earlier bare `#` and `order <n>`
 * branches were removed: they promoted SKU# 154250, SO# 80720, Order # 21909
 * and invoice #130648 to PO refs (the phantom/dangling-ref defect family).
 *
 * Handles:
 *   "PO #124833", "PO-124833", "PO 124833", "P.O.#: 125213",
 *   "Purchase Order # 125376", "71473626-1124833" (Finale vendor-ref format),
 *   "P.O. Number 23578097A" (8-digit dropship + letter), and the bare
 *   AutoPot form "View and pay 23581487" (8-digit dropship, no label).
 *
 * 8-digit dropship candidates (label-bounded or bare) are emitted as raw refs
 * and gated on existence downstream by resolveExtractedPOs() — shape alone
 * cannot decide, so a bare 235xxxxxxx that resolves to no purchase_orders row
 * stays rejected.
 *
 * @exportedForTesting
 */
export function extractPONumbersFromText(text: string): string[] {
    const seen = new Set<string>();

    // PO label forms: "PO", "P.O.", "purchase order" (+ optional "number"/"no").
    // Separator between the label and the digits is any run of spaces/#/:/. /-.
    // The bare `#` and `order <n>` branches are intentionally gone.
    // 8-digit dropship first (else \d{5,7} eats the 7-digit prefix), then 5-7.
    const poLabel = "(?:P\\.O\\.|\\bPO\\b|\\bpurchase\\s+order\\b)";
    const poPattern = new RegExp(
        `${poLabel}[\\s#:.\\-]*(?:number|no\\.?)?[\\s#:.\\-]*(\\d{8}[A-Z]?|\\d{5,7})\\b`,
        "gi",
    );
    for (const m of text.matchAll(poPattern)) {
        seen.add(m[1]);
    }

    // Bare 8-digit dropship refs ("View and pay 23578097A", "23581487 UPS")
    // carry no PO label. Captured as candidates and gated on existence by
    // resolveExtractedPOs(); a bare 235xxxxxxx that resolves to nothing stays
    // rejected (class 11 — carrier P.O. box / Finale SALES_ORDER). Restricted
    // to the 2-prefixed family so AAA Cooper PROs / B.L. digit-runs never even
    // become candidates.
    const bareDropshipMatches = text.match(/\b(2\d{7}[A-Z]?)\b/g) || [];
    for (const m of bareDropshipMatches) {
        seen.add(m);
    }

    // Finale vendor-ref format: "71473626-1124833" → PO 124833
    // The last 6 digits after the dash are the PO number
    const vendorRefMatches = text.match(/\b\d{7,10}-(\d{6})\b/g) || [];
    for (const m of vendorRefMatches) {
        const parts = m.split("-");
        if (parts.length === 2) {
            seen.add(parts[1]); // last 6 digits = PO number
        }
    }

    return Array.from(seen);
}

// ── Documentary delivery reconciliation (Guard 11) ─────────────────────────
//
// A carrier POD / BOL ("DELIVERY STATUS: Good Order", signature lines) or a
// vendor "delivered on <date>" email can prove a shipment was delivered even
// when the carrier poll never saw the delivery — the Certis POD case: the PDF
// printed "Good Order" + a 9/25 date but the row sat at in_transit for weeks.
//
// Hard-earned constraints (aria-purchasing review, 2026-10-21):
//   1. NEVER read future-shipping language as a delivery. "will be delivered
//      on 10/23" / "scheduled to be delivered" / "estimated delivery" is the
//      opposite of delivered and appears in every carrier ETA notice.
//   2. Delivered is terminal in the write path, so a false "delivered" here is
//      permanent. Only strong document-class signals (POD status / BOL
//      signature) may write terminal `delivered`; a vendor "delivered on"
//      email is ANNOTATION-ONLY (reduced confidence, no terminal write).
//   3. Vetoes are LOCAL (per-claim), never whole-document — a real POD that
//      also prints "returns to be shipped via RMA" must still be accepted.

export interface DocumentaryDelivery {
    deliveredAt: string; // ISO timestamp (12:00 UTC on the delivery date)
    signal: string;      // "pod_delivery_status" | "bol_signature" | "vendor_delivered_email"
    note: string;        // provenance note appended to status_display
    terminal: boolean;   // false for vendor_delivered_email (annotation-only)
}

// Terms that negate a nearby "delivered on" claim — the carrier-ETA vocabulary.
const FUTURE_NEGATION_TERMS_RE =
    /\b(will|scheduled|estimated|expected|likely|attempt|attempted|due|to\s+be|not\s+yet|should)\b/i;

const POD_DELIVERY_STATUS_RE =
    /\bdelivery\s+status\s*:?\s*(good\s+order|delivered|complete|received)\b/i;

// Carrier receipt-of-goods phrases ONLY. Bare "received by" is dropped: it
// matches ordinary inbound language ("your order was received by our team").
const BOL_SIGNATURE_RE =
    /\b(received\s+in\s+(?:good\s+order|full)|signed\s+for\s+by|signature\s+on\s+file)\b/i;

const DELIVERED_ON_RE = /\bdelivered\s+on\b/gi;

// Labels that introduce a delivery date. We only trust a date in one of these
// contexts — never a bare "ship date" that also happens to appear on the page.
const DELIVERY_DATE_CONTEXT_RE =
    /\b(delivered\s+on|delivery\s+date|date\s+of\s+delivery|date\s+delivered|delivered|received\s+on|date\s+received|received\s+by|received|signed\s+on|signature\s+date|signed|pod\s+date)\b/gi;

const MONTH_INDEX: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function dateAtNoonUtc(year: number, month: number, day: number): string {
    return new Date(Date.UTC(year, month, day, 12, 0, 0)).toISOString();
}

/** Parse the first plausible delivery date in `str`, or null. */
function parseFirstDate(str: string): string | null {
    // ISO: 2026-09-25
    let m = str.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) return dateAtNoonUtc(+m[1], +m[2] - 1, +m[3]);

    // US slash: 09/25/2026 or 9/25/26
    m = str.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (m) {
        const year = +m[3] < 100 ? 2000 + +m[3] : +m[3];
        return dateAtNoonUtc(year, +m[1] - 1, +m[2]);
    }

    // Named month (US order): Sep 25, 2026 / September 25 2026
    m = str.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
    if (m) {
        const month = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
        if (month != null) return dateAtNoonUtc(+m[3], month, +m[2]);
    }

    // Named month (UK order): 25 Sep 2026
    m = str.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/);
    if (m) {
        const month = MONTH_INDEX[m[2].slice(0, 3).toLowerCase()];
        if (month != null) return dateAtNoonUtc(+m[3], month, +m[1]);
    }

    return null;
}

/** Parse a date anchored at the START of `s` (no scanning ahead). */
function parseLeadingDate(s: string): string | null {
    // ISO: 2026-09-25
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) return dateAtNoonUtc(+m[1], +m[2] - 1, +m[3]);

    // US slash: 09/25/2026 or 9/25/26
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (m) {
        const year = +m[3] < 100 ? 2000 + +m[3] : +m[3];
        return dateAtNoonUtc(year, +m[1] - 1, +m[2]);
    }

    // Named month (US order): Sep 25, 2026 / September 25 2026
    m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
    if (m) {
        const month = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
        if (month != null) return dateAtNoonUtc(+m[3], month, +m[2]);
    }

    // Named month (UK order): 25 Sep 2026
    m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
    if (m) {
        const month = MONTH_INDEX[m[2].slice(0, 3).toLowerCase()];
        if (month != null) return dateAtNoonUtc(+m[3], month, +m[1]);
    }

    return null;
}

/** True when `iso` is a future delivery date (tomorrow or later, UTC). */
function isFutureDeliveryDate(iso: string, now: Date): boolean {
    const d = new Date(iso).getTime();
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const tomorrowStart = todayStart + 24 * 3600 * 1000;
    return d >= tomorrowStart;
}

/** Find a delivery date in a delivery-context window at/after `fromIndex`. */
function findDeliveryDateFrom(text: string, fromIndex: number): string | null {
    const re = new RegExp(DELIVERY_DATE_CONTEXT_RE.source, "gi");
    for (const match of text.matchAll(re)) {
        const idx = match.index ?? 0;
        if (idx < fromIndex) continue;
        const window = text.slice(idx, idx + 120);
        const parsed = parseFirstDate(window);
        if (parsed) return parsed;
    }
    return null;
}

/**
 * Validate a vendor "delivered on <date>" claim.
 *
 * Rejects when a future/ETA term sits within ~40 chars before "delivered on"
 * ("will be delivered", "scheduled to be delivered"), and requires the date to
 * IMMEDIATELY follow "delivered on" (rejecting "Delivered on time, every time"
 * and "delivered on the second attempt").
 */
function findVendorDeliveryClaim(text: string): string | null {
    for (const m of text.matchAll(DELIVERED_ON_RE)) {
        const idx = m.index ?? 0;

        const before = text.slice(Math.max(0, idx - 40), idx);
        if (FUTURE_NEGATION_TERMS_RE.test(before)) continue;

        const after = text.slice(idx + m[0].length, idx + m[0].length + 60);
        let s = after.replace(/^\s+/, "");
        s = s.replace(/^the\s+/i, "");
        s = s.replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, "");
        const dateIso = parseLeadingDate(s);
        if (!dateIso) continue;

        return dateIso;
    }
    return null;
}

function buildDelivery(
    deliveredAt: string,
    signal: string,
    terminal: boolean,
): DocumentaryDelivery {
    const dateLabel = new Date(deliveredAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
    });
    const note = `Delivered ${dateLabel} (${signal.replace(/_/g, " ")})`;
    return { deliveredAt, signal, note, terminal };
}

/**
 * Detect documentary proof of delivery and return its date + signal.
 *
 * Strong signals (POD status, BOL signature) are terminal; the vendor
 * "delivered on" email is annotation-only (`terminal: false`).
 *
 * @exportedForTesting
 */
export function detectDocumentaryDelivery(text: string): DocumentaryDelivery | null {
    if (!text) return null;

    const now = new Date();

    // Evidence precedence: POD status > BOL signature > vendor email.
    const pod = text.match(POD_DELIVERY_STATUS_RE);
    if (pod && pod.index != null) {
        const deliveredAt = findDeliveryDateFrom(text, pod.index);
        if (deliveredAt && !isFutureDeliveryDate(deliveredAt, now)) {
            return buildDelivery(deliveredAt, "pod_delivery_status", true);
        }
    }

    const bol = text.match(BOL_SIGNATURE_RE);
    if (bol && bol.index != null) {
        const deliveredAt = findDeliveryDateFrom(text, bol.index);
        if (deliveredAt && !isFutureDeliveryDate(deliveredAt, now)) {
            return buildDelivery(deliveredAt, "bol_signature", true);
        }
    }

    const vendorDate = findVendorDeliveryClaim(text);
    if (vendorDate && !isFutureDeliveryDate(vendorDate, now)) {
        return buildDelivery(vendorDate, "vendor_delivered_email", false);
    }

    return null;
}

// ── PO Inference Helpers (ported from src/lib/intelligence/tracking-agent.ts) ──
//
// These functions implement a fallback-correlation algorithm for linking
// carrier auto-notification emails (FedEx/UPS/USPS) to purchase orders when
// the email text contains no explicit PO number reference. The algorithm scores
// candidate POs by (a) direct numeric-hint substring match, (b) vendor-name
// token overlap between the email text and each PO's vendor_name, and
// (c) tie-breaking by excluding dropship POs when there are multiple matches
// at the same score.
//
// Ported from inferPONumberFromRecentPOs() in tracking-agent.ts — that file's
// TrackingAgent class is dead code (instantiated in ops-manager.ts but never
// invoked); this fallback logic was working and unused, so it's ported here
// into the live ingestion path rather than reinvented. See
// docs/dashboard-design-audit.md section "P0-4" for the full diagnosis
// (55% of shipment rows were orphaned from any PO before this fix) and
// backlog item 24/25 for follow-up (dead TrackingAgent cleanup).

type RecentPurchaseOrder = {
    po_number: string;
    vendor_name?: string | null;
    created_at?: string | null;
};

const VENDOR_NAME_STOP_WORDS = new Set([
    "inc", "llc", "ltd", "co", "company", "corp", "corporation",
    "usa", "the", "and",
]);

function normalizeComparisonText(value: string | null | undefined): string {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function vendorNameTokens(vendorName: string | null | undefined): string[] {
    return normalizeComparisonText(vendorName)
        .split(" ")
        .filter((token) => token.length >= 3 && !VENDOR_NAME_STOP_WORDS.has(token));
}

/**
 * Guard 10 helper: do two vendor-name strings refer to the same vendor?
 * Normalized token-overlap match — ignores case/punctuation and stop words so
 * "New Moon Development Co" matches "New Moon Development Company" but
 * "Green Earth Organics" does not match "Earth Box".
 */
function sameVendor(a: string | null | undefined, b: string | null | undefined): boolean {
    const na = normalizeComparisonText(a);
    const nb = normalizeComparisonText(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const ta = vendorNameTokens(a);
    const tb = vendorNameTokens(b);
    if (!ta.length || !tb.length) return false;
    const shared = ta.filter((token) => tb.includes(token)).length;
    return shared >= Math.min(ta.length, tb.length);
}

/**
 * Guard 11 #5 (sender→vendor gate): decide whether a vendor "delivered on"
 * email annotation may land on a shipment row.
 *
 * The vendor email is the weakest signal in the detector — any marketing or
 * 3PL body with "delivered on <date>" trips it. The annotation only lands when
 * the sender resolves to a KNOWN vendor, and — for an existing row — when that
 * vendor matches a vendor name already recorded on the shipment. A brand-new
 * row (no recorded vendor) accepts any resolved vendor.
 *
 * @exportedForTesting
 */
export function vendorDeliveryAnnotationAllowed(
    resolvedVendor: string | null | undefined,
    existingVendorNames: string[],
): boolean {
    if (!resolvedVendor) return false;
    if (existingVendorNames.length === 0) return true;
    return existingVendorNames.some((v) => sameVendor(v, resolvedVendor));
}

/**
 * Guard 11 #6 (vendor-name hygiene): what vendor name should a shipment upsert
 * record for this hit?
 *
 * A mismatched sender must not append its vendor name onto a row that already
 * records a vendor — that is how a parcel ends up credited to the wrong vendor.
 * Rules:
 *   - PO-attributed rows derive their vendor from the PO, so return null.
 *   - No resolved vendor → null.
 *   - Brand-new row (no recorded vendor) → keep resolvedVendor as provenance.
 *   - Existing row → keep resolvedVendor only if it matches a recorded name,
 *     otherwise null (do not append the mismatched vendor).
 *
 * @exportedForTesting
 */
export function vendorNameForUpsert(
    poNum: string | null,
    resolvedVendor: string | null,
    existingVendorNames: string[],
): string | null {
    if (poNum) return null;
    if (!resolvedVendor) return null;
    if (existingVendorNames.length === 0) return resolvedVendor;
    return existingVendorNames.some((v) => sameVendor(v, resolvedVendor)) ? resolvedVendor : null;
}

/**
 * Generic shipping-platform / 3PL senders whose notices name no vendor. Their
 * text carries only the destination (our own "Build A Soil") which weakly
 * cross-matches unrelated vendors — so a full vendor-name match is required
 * before a PO is inferred from one of these senders.
 */
const GENERIC_3PL_SENDER_DOMAINS = new Set([
    "pirateship.com",
    "shipstation.com",
    "shopify.com",
    "easypost.com",
    "shippo.com",
    "goshippo.com",
    "shipbob.com",
    "stamps.com",
    "endicia.com",
    "parcel2go.com",
    "sendcloud.com",
]);

function extractNumericHints(text: string): string[] {
    return Array.from(new Set((text.match(/\b\d{6,}\b/g) || []).map((value) => value.trim())));
}

/**
 * Guard 10: resolve a sender email to a canonical vendor name via vendor_profiles.
 * Matches the exact address against orders_email / vendor_emails[], then the
 * sender's domain against vendor_domains[]. Returns null when no deterministic
 * match exists — the caller then leaves the shipment unlinked rather than
 * guessing across vendors (never a 0.6 inference against an unrelated vendor).
 */
async function resolveSenderVendor(fromEmail: string): Promise<string | null> {
    const email = String(fromEmail || "").toLowerCase().trim();
    if (!email || !email.includes("@")) return null;
    const domain = email.split("@")[1] || "";

    const db = createClient();
    if (!db) return null;

    try {
        // 1. Trusted orders_email match (normalized lowercase on write).
        const { data: byOrdersEmail } = await db
            .from("vendor_profiles")
            .select("vendor_name")
            .eq("orders_email", email)
            .limit(1);
        if (Array.isArray(byOrdersEmail) && byOrdersEmail.length > 0 && byOrdersEmail[0]?.vendor_name) {
            return byOrdersEmail[0].vendor_name;
        }

        // 2. vendor_emails[] contains the address. `.overlaps`, not `.contains`:
        //    supabase-js serialises a JS array as JSON and 400s on a PostgREST
        //    text[] column (22P02 "malformed array literal").
        const { data: byVendorEmail } = await db
            .from("vendor_profiles")
            .select("vendor_name")
            .overlaps("vendor_emails", [email])
            .limit(1);
        if (Array.isArray(byVendorEmail) && byVendorEmail.length > 0 && byVendorEmail[0]?.vendor_name) {
            return byVendorEmail[0].vendor_name;
        }

        // 3. vendor_domains[] contains the sender's domain.
        if (domain) {
            const { data: byDomain } = await db
                .from("vendor_profiles")
                .select("vendor_name")
                .overlaps("vendor_domains", [domain])
                .limit(1);
            if (Array.isArray(byDomain) && byDomain.length > 0 && byDomain[0]?.vendor_name) {
                return byDomain[0].vendor_name;
            }
        }
    } catch (err: any) {
        console.warn(`[email-tracking-ingest] vendor_profiles sender lookup failed: ${err.message}`);
    }

    return null;
}

/**
 * Attempt to infer the PO number for a carrier notification email by scoring
 * recent purchase orders against the email's subject, body, and sender address.
 * Returns the best-matching PO number or null if no confident match exists.
 *
 * Guard 10 — vendor-scoped inference: when `senderVendorName` is resolved (from
 * the sender address via `resolveSenderVendor`), only that vendor's POs are
 * candidates — an unrelated vendor's PO is never reachable. A generic 3PL
 * sender (PirateShip / ShipStation / Shopify) names no vendor, so a full
 * vendor-name match is required before a PO is inferred from it (its text
 * carries only destination text like "Build A Soil", which weakly cross-matches
 * unrelated vendors such as "Rootwise Soil Dynamics").
 *
 * Scoring logic:
 * 1. Direct numeric-hint match against po_number (returns immediately if
 *    exactly one candidate matches).
 * 2. Vendor-name token overlap: full vendor name substring match scores +10,
 *    individual token matches score +1 each.
 * 3. Tie-breaking: excludes dropship POs when there is ambiguity.
 *
 * @exportedForTesting — exported so unit tests can exercise the pure
 * inference logic without mocking Gmail/Postgres.
 */
export function inferPONumberFromRecentPOs(
    message: { subject?: string | null; bodySnippet?: string | null; fromEmail?: string | null },
    recentPOs: RecentPurchaseOrder[],
    senderVendorName?: string | null,
): string | null {
    if (!recentPOs.length) return null;

    const subject = String(message.subject || "");
    const bodySnippet = String(message.bodySnippet || "");
    const fromEmail = String(message.fromEmail || "");
    const combinedText = `${subject}\n${bodySnippet}\n${fromEmail}`;
    const normalizedCombined = normalizeComparisonText(combinedText);
    const numericHints = extractNumericHints(combinedText);

    // Guard 10: scope candidates to the resolved sender vendor. If the sender
    // resolves to a vendor that has no open PO, stop — never cross-match.
    let candidates = recentPOs;
    if (senderVendorName) {
        candidates = recentPOs.filter((po) => sameVendor(po.vendor_name, senderVendorName));
        if (!candidates.length) return null;

        // A single open PO for the resolved vendor is unambiguous (the vendor's
        // only outstanding order) — infer it directly without requiring the
        // vendor name to also appear in the email text.
        if (candidates.length === 1) {
            return candidates[0].po_number;
        }
    }

    // Step 1: Direct numeric-hint match against po_number
    const directOrderMatch = candidates.filter((po) =>
        numericHints.some((hint) => String(po.po_number || "").toLowerCase().startsWith(hint.toLowerCase()))
    );
    if (directOrderMatch.length === 1) {
        return directOrderMatch[0].po_number;
    }

    // Step 2: Vendor-name token overlap scoring
    const scored = candidates
        .map((po) => {
            const tokens = vendorNameTokens(po.vendor_name);
            if (!tokens.length) return { po, score: 0 };

            const fullVendor = normalizeComparisonText(po.vendor_name);
            const fullMatch = fullVendor.length >= 5 && normalizedCombined.includes(fullVendor);
            const tokenMatches = tokens.filter((token) => normalizedCombined.includes(token)).length;
            return { po, score: (fullMatch ? 10 : 0) + tokenMatches };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

    if (!scored.length) return null;

    // Guard 10 (unresolved generic 3PL sender): require a full vendor-name match.
    const senderDomain = fromEmail.includes("@") ? fromEmail.split("@")[1].toLowerCase() : "";
    const isGeneric3PL = GENERIC_3PL_SENDER_DOMAINS.has(senderDomain);
    if (isGeneric3PL && !senderVendorName && scored[0].score < 10) {
        return null;
    }

    // Step 3: Tie-breaking — prefer non-dropship POs
    const topScore = scored[0].score;
    const topMatches = scored.filter((entry) => entry.score === topScore).map((entry) => entry.po);
    const nonDropship = topMatches.filter((po) => !/dropship/i.test(String(po.po_number || "")));

    if (nonDropship.length === 1) {
        return nonDropship[0].po_number;
    }

    if (topMatches.length === 1 && numericHints.length === 0) {
        return topMatches[0].po_number;
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

    await notify(lines.join("\n"));
}
