/**
 * @file    src/lib/tracking/bol-ocr.ts
 * @purpose Thin wrapper around extractPDF (src/lib/pdf/extractor.ts) that decides
 *          WHEN the email-tracking ingest should spend vision OCR on a PDF
 *          attachment. Digital/dense PDFs stay on pdf-parse (free, fast); only
 *          sparse PDFs that look like LTL/FTL BOLs (BOL-like filename, LTL
 *          carrier in the email context, or shipping keywords) escalate to
 *          vision via the existing extractPDF fallthrough.
 *
 *          Workstream 1 — Scanned BOL vision OCR
 *          (docs/plans/2026-08-05-po-tracking-invoice-correlation.md).
 *          The caller (email-tracking-ingest) enforces the "max 1 vision OCR
 *          per email" cap; this module caps pages per PDF.
 * @created 2026-08-05
 */

import { extractPDF } from "../pdf/extractor";
import { detectLTLCarrier } from "../carriers/tracking-service";

/**
 * Filenames that mark a PDF as a bill of lading / LTL PRO / freight document.
 * Tolerant superset of the plan's /\b(bol|b.?l|bill.?of.?lading|pro\b|ltl|ftl)\b/i
 * — also catches "bill-of-lading.pdf", "B/L 71473626.pdf", "ltl_estes.pdf".
 */
export const BOL_FILENAME_PATTERN = /\b(bol|b[\s.\-\/]*l|bill[\s.\-]*of[\s.\-]*lading|pro\b|ltl|ftl)\b/i;

/**
 * Sparse threshold: pdf-parse text with fewer non-whitespace chars than this
 * is treated as a scanned-PDF candidate (plan: "< 40 non-ws chars").
 */
export const SPARSE_TEXT_CHAR_THRESHOLD = 40;

/** Vision cost bound — never send PDFs over this many pages to vision. */
export const MAX_VISION_PAGES = 3;

/** Shipping/freight keywords that make a sparse PDF worth a vision attempt. */
const SHIPPING_KEYWORDS_PATTERN =
    /\b(shipping|freight|carrier|tracking|track\b|pro\b|bol\b|bill of lading|waybill|pallet|ltl|ftl|deliver|pickup|picked up|ship date|consignee|shipper|trailer)\b/i;

export type BolVisionReason = "bol_filename" | "ltl_carrier" | "sparse_shipping_keywords";

export interface BolVisionDecision {
    run: boolean;
    reason: BolVisionReason | null;
}

export interface BolOcrResult {
    /** Best available text: pdf-parse result, or vision OCR when it ran. */
    text: string;
    /** True when vision OCR produced the text (source tag email_ingest_bol_vision). */
    visionUsed: boolean;
    source: "pdf-parse" | "email_ingest_bol_vision";
    decision: BolVisionDecision;
}

/** True when the attachment filename looks like a BOL / LTL / FTL doc. */
export function isBOLFilename(filename: string | null | undefined): boolean {
    if (!filename) return false;
    // Underscores are word chars in \b — normalize so "ltl_estes.pdf" matches.
    return BOL_FILENAME_PATTERN.test(String(filename).replace(/_/g, " "));
}

/**
 * Decide whether a sparse pdf-parse result warrants a vision OCR attempt.
 * Pure function. Dense text (>= SPARSE_TEXT_CHAR_THRESHOLD non-ws chars)
 * NEVER triggers vision — digital PDFs stay on pdf-parse at zero vision cost.
 */
export function shouldUseVisionForBol(args: {
    pdfParseText: string;
    pageCount?: number | null;
    filename?: string | null;
    emailContext?: string;
}): BolVisionDecision {
    const nonWs = String(args.pdfParseText || "").replace(/\s/g, "").length;
    if (nonWs >= SPARSE_TEXT_CHAR_THRESHOLD) {
        return { run: false, reason: null }; // digital dense PDF — pdf-parse only
    }

    const pages = Number(args.pageCount) || 1;
    if (pages > MAX_VISION_PAGES) {
        return { run: false, reason: null }; // page-count cost bound
    }

    if (isBOLFilename(args.filename)) {
        return { run: true, reason: "bol_filename" };
    }

    const ctx = String(args.emailContext || "");
    if (detectLTLCarrier(ctx)) {
        return { run: true, reason: "ltl_carrier" };
    }

    if (SHIPPING_KEYWORDS_PATTERN.test(ctx)) {
        return { run: true, reason: "sparse_shipping_keywords" };
    }

    return { run: false, reason: null };
}

/**
 * Extract text from a (possibly scanned) BOL PDF attachment.
 *
 * - pdf-parse fast path always runs first (or reuses caller-provided text so
 *   the ingest doesn't parse the same buffer twice).
 * - vision (extractPDF → Gemini/tesseract fallthrough) is only called when the
 *   pdf-parse result is sparse AND the PDF/email looks BOL-like.
 * - Never throws: vision failures fall back to whatever pdf-parse produced.
 */
export async function extractBolText(args: {
    buffer: Buffer;
    filename?: string | null;
    emailContext?: string;
    /** Pre-parsed pdf-parse text — avoids double-parsing when the caller already ran pdf-parse. */
    pdfParseText?: string;
    /** Pre-parsed page count (from the same pdf-parse run as pdfParseText). */
    pageCount?: number | null;
}): Promise<BolOcrResult> {
    let text = args.pdfParseText ?? "";
    let pageCount = args.pageCount ?? null;

    if (args.pdfParseText === undefined) {
        try {
            const parsed = await runPdfParse(args.buffer);
            text = (parsed?.text || "").toString();
            pageCount = parsed?.numpages ?? null;
        } catch {
            text = "";
        }
    }

    const decision = shouldUseVisionForBol({
        pdfParseText: text,
        pageCount,
        filename: args.filename,
        emailContext: args.emailContext,
    });

    if (!decision.run) {
        return { text: text.trim(), visionUsed: false, source: "pdf-parse", decision };
    }

    try {
        const result = await extractPDF(args.buffer);
        const visionUsed = result.ocrStrategy !== "pdf-parse";
        return {
            // Prefer vision text; fall back to the sparse pdf-parse text if empty.
            text: result.rawText || text.trim(),
            visionUsed,
            source: visionUsed ? "email_ingest_bol_vision" : "pdf-parse",
            decision,
        };
    } catch (err: any) {
        // extractPDF throws when every vision strategy fails — keep the sparse
        // pdf-parse text rather than crashing the whole email ingest.
        console.warn(`[bol-ocr] Vision OCR failed (${args.filename || "?"}): ${err.message}`);
        return { text: text.trim(), visionUsed: false, source: "pdf-parse", decision };
    }
}

/** pdf-parse with the same dynamic-import dance as email-tracking-ingest. */
async function runPdfParse(buffer: Buffer): Promise<any> {
    let pdfParse: any;
    try {
         
        const mod: any = await import("pdf-parse");
        pdfParse = mod.default || mod;
    } catch {
        return { text: "", numpages: 1 };
    }
    return await pdfParse(buffer, { max: 0 });
}
