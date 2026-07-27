/**
 * @file    ocr-po-sanitize.ts
 * @purpose Sanitize raw OCR-extracted PO number candidates into clean PO strings
 *          suitable for exact-match lookup against purchase_orders.po_number.
 *          Pure functions — no DB or side effects.
 *
 *          OCR noise patterns handled:
 *            "PO124813" or "P.O.124813" or "#124813" → "124813"
 *            "71486681-1124705" → "124705" (embedded PO w/ extra leading digit)
 *            "NEED PO 03/20/26" → null (garbage)
 *            "SEE BELOW" → null (garbage)
 *            "BUILMOCO" → null (pure letters / not a PO)
 *
 * @author  Hermia
 * @created 2026-07-27
 */

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Regex patterns to strip prefixes that commonly precede a PO number
 * in OCR output (e.g. "PO124813", "P.O.# 124813", "#124813").
 */
const PO_PREFIX_RE = /^(?:PO|P\.?O\.?|PONUMBER|REF|REFERENCE)\s*[#:\-]?\s*/i;

/**
 * Garbage strings that are clearly not PO numbers — typically OCR misreads
 * of shipping instructions or form field labels.
 */
const GARBAGE_RAW = new Set([
    "SEE BELOW",
    "SEE BELOW.",
    "NEED PO",
    "N/A",
    "NA",
    "NONE",
    "UNKNOWN",
    "TBD",
    "ASAP",
]);

/**
 * Company/product names that sometimes get OCR'd into the PO field.
 */
const KNOWN_NON_PO_WORDS = new Set([
    "BUILMOCO",
    "BUILDASOIL",
    "FEDEX",
    "UPS",
    "USPS",
    "AMAZON",
    "ULINE",
    "GRANGER",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check if a token looks like a plausible Finale PO number.
 * Finale POs are typically 5-8 digit numeric strings, with 6-digit 12xxxx
 * being the predominant BAS internal pattern. Also allows suffixes like
 * "-DropshipPO" or "-S-DropshipPO".
 */
function isPlausiblePoToken(s: string): boolean {
    if (!s || s.length < 3) return false;

    // Pure numeric: 5-8 digits (e.g. "124813", "23324007")
    if (/^\d{5,8}$/.test(s)) return true;

    // Numeric with known suffix (e.g. "23497897-DropshipPO")
    if (/^\d{5,8}-(?:[SD]-)?DropshipPO$/.test(s)) return true;

    return false;
}

/**
 * Try to extract a PO candidate from a compound dash-delimited string like
 * "71486681-1124705" or "889250515621-646135168".
 *
 * Strategy:
 *   1. Check each side of the dash for a direct plausible PO (5-8 digit pure numeric).
 *   2. For 7-digit values starting with "11" (common OCR dup-digit prefix),
 *      try dropping one leading "1" to get a 6-digit 12xxxx pattern.
 *   3. Return the best non-null candidate, preferring 6-digit 12xxxx patterns.
 */
function extractFromCompound(raw: string): string | null {
    const parts = raw.split("-").map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;

    const candidates: string[] = [];

    for (const part of parts) {
        // Direct plausible PO
        if (isPlausiblePoToken(part)) {
            candidates.push(part);
        }

        // 7-digit starting with "11" — try dropping one leading digit
        // e.g. "1124705" → try "124705" (6-digit 12xxxx pattern)
        if (/^11\d{5}$/.test(part)) {
            const stripped = part.replace(/^1/, ""); // "1124705" → "124705"
            if (isPlausiblePoToken(stripped)) {
                candidates.push(stripped);
            }
        }
    }

    // Prefer 6-digit starting with "12" (BAS internal PO pattern)
    const twelvePrefixed = candidates.filter(c => /^12\d{4}$/.test(c));
    if (twelvePrefixed.length > 0) return twelvePrefixed[0];

    // Fall back to longest plausible candidate
    if (candidates.length > 0) {
        candidates.sort((a, b) => b.length - a.length);
        return candidates[0];
    }

    return null;
}

/**
 * Check if a string is recognizably not a PO number — dates, instructions,
 * company names, or other OCR artifacts.
 */
function isGarbageToken(s: string): boolean {
    const upper = s.toUpperCase();

    // Direct garbage matches
    for (const g of GARBAGE_RAW) {
        if (upper.startsWith(g)) return true;
    }

    // Known non-PO words
    for (const w of KNOWN_NON_PO_WORDS) {
        if (upper === w || upper.startsWith(w + " ")) return true;
    }

    // Looks like a date (contains month/day pattern like "03/20" or "MAR")
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) return true;
    if (/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i.test(upper)) return true;

    // Pure letters only (no digits at all)
    if (/^[A-Z\s.,\-']+$/i.test(s) && !/\d/.test(s)) return true;

    // Too short to be a PO (1-3 chars of non-numeric)
    if (s.length < 4 && /\D/.test(s)) return true;

    return false;
}

// ── Main export ─────────────────────────────────────────────────────────────

/**
 * Sanitize a raw OCR-extracted PO number candidate into a clean string
 * suitable for exact-match lookup against purchase_orders.po_number.
 *
 * Cleaning pipeline:
 *   1. Trim and uppercase
 *   2. Strip common prefixes ("PO", "P.O.", "#", "REF", etc.)
 *   3. Reject clearly-garbage tokens (dates, company names, instructions)
 *   4. If already a plausible PO token, return as-is
 *   5. If dash-delimited compound, attempt embedded-PO extraction
 *   6. Return null if no plausible PO can be extracted
 *
 * @param raw  Raw OCR string from invoice data (poNumber, orderRef, etc.)
 *             May be null, undefined, or any string.
 * @returns    Cleaned PO string, or null if no plausible PO found.
 *
 * @example
 *   sanitizeOcrPoCandidate("PO124813")           → "124813"
 *   sanitizeOcrPoCandidate("P.O.# 124813")        → "124813"
 *   sanitizeOcrPoCandidate("71486681-1124705")     → "124705"
 *   sanitizeOcrPoCandidate("NEED PO 03/20/26")     → null
 *   sanitizeOcrPoCandidate("SEE BELOW")            → null
 *   sanitizeOcrPoCandidate("BUILMOCO")             → null
 *   sanitizeOcrPoCandidate(null)                   → null
 */
export function sanitizeOcrPoCandidate(raw: string | null | undefined): string | null {
    if (!raw) return null;

    // Step 1: Trim and uppercase
    let s = raw.trim().toUpperCase();
    if (!s) return null;

    // Step 2: Strip common prefixes like "PO", "P.O.", "#", "REF", etc.
    s = s.replace(PO_PREFIX_RE, "").trim();
    if (!s) return null;

    // Step 3: Strip leading "#" or trailing punctuation
    s = s.replace(/^#\s*/, "").replace(/[.,;:]+$/, "").trim();
    if (!s) return null;

    // Step 4: Reject clearly-garbage tokens
    if (isGarbageToken(s)) return null;

    // Step 5: Check for dash-delimited compound (embedded PO)
    if (s.includes("-")) {
        // Quick check: if the whole thing with dashes is already a known PO format
        // (e.g. "23497897-DropshipPO"), accept it
        if (isPlausiblePoToken(s.replace(/-/g, "")) || isPlausiblePoToken(s)) {
            return s;
        }

        // FedEx/tracking ref pattern: "NUMBER-NUMBER" where both sides are long
        // digits (9+ chars) — not a PO
        const sides = s.split("-").filter(Boolean);
        const allLongNumeric = sides.every(p => /^\d{8,}$/.test(p));
        if (allLongNumeric && sides.length >= 2) {
            return null; // FedEx-style tracking reference, not a PO
        }

        const embedded = extractFromCompound(s);
        if (embedded) return embedded;

        // If after splitting we get one clean numeric part, try that
        for (const part of sides) {
            if (isPlausiblePoToken(part)) return part;
        }

        return null;
    }

    // Step 6: Final plausibility check
    if (isPlausiblePoToken(s)) return s;

    // Step 7: If entirely numeric already (after prefix strip), accept anything
    // 5-8 digits the isPlausiblePoToken check should have caught this, but
    // also handle plain numeric without length restriction
    if (/^\d+$/.test(s) && s.length >= 4 && s.length <= 10) return s;

    return null;
}
