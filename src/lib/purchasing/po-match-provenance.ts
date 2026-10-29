/**
 * @file    po-match-provenance.ts
 * @purpose Record HOW an invoice→PO link was made, so the dashboard can show
 *          "exact PO" vs "Aria's best guess — verify" instead of a bare
 *          "matched". Provenance only: nothing here scores or re-ranks.
 *
 *          The scoring tiers live in invoice-po-matcher.ts (findPOCandidates)
 *          and are NOT changed by this module. Each tier tags the candidate it
 *          produces with a {@link PoMatchMethod} at the point the candidate is
 *          chosen.
 *
 *          This file is pure (no DB, no Finale) so the route can also tag a
 *          row that was linked on an earlier run, using only data it already
 *          holds (the printed PO and the human-confirmed vendor→PO table).
 *
 * @created 2026-10-29
 */

import { sanitizeOcrPoCandidate } from "./ocr-po-sanitize";

/**
 * How a candidate/link was produced.
 *
 * - `exact_po`    — the PO number printed on the document IS the PO (no guess).
 * - `sku_exact`   — Uline bill with no usable printed PO; matched by exact SKU
 *                   overlap against the PO's line items (still deterministic).
 * - `confirmed`   — a human previously confirmed this vendor→PO pair
 *                   (confirmed_po_matches), which boosts the candidate.
 * - `vendor_date` — scored on vendor name + date proximity (a guess: verify).
 * - `fast_path`   — the single-open-PO-for-this-vendor shortcut (a guess).
 * - `unknown`     — provenance not recorded for this row.
 */
export type PoMatchMethod =
    | "exact_po"
    | "sku_exact"
    | "confirmed"
    | "vendor_date"
    | "fast_path"
    | "unknown";

/** Deterministic methods a human can trust without re-checking. */
const SOLID_METHODS = new Set<PoMatchMethod>(["exact_po", "sku_exact", "confirmed"]);

/** Short chip label + hover text for each method. */
export const PO_MATCH_METHOD_LABELS: Record<PoMatchMethod, { label: string; title: string }> = {
    exact_po: {
        label: "exact PO",
        title: "PO number printed on the invoice — deterministic match",
    },
    sku_exact: {
        label: "exact SKU",
        title: "Matched by exact SKU overlap on the PO lines — deterministic match",
    },
    confirmed: {
        label: "confirmed",
        title: "This vendor→PO pair was confirmed by a human previously",
    },
    vendor_date: {
        label: "vendor+date",
        title: "Guessed from vendor name and date proximity — verify before paying",
    },
    fast_path: {
        label: "fast path",
        title: "Guessed: this vendor's only open PO in the date window — verify before paying",
    },
    unknown: {
        label: "unverified",
        title: "Match method not recorded for this invoice — verify before paying",
    },
};

/** True when the method is deterministic (no guessing). */
export function isSolidMatchMethod(method: PoMatchMethod | null | undefined): boolean {
    return !!method && SOLID_METHODS.has(method);
}

/** Stable key for a human-confirmed vendor→PO pair. */
export function confirmedPairKey(vendorName: string | null | undefined, poNumber: string | null | undefined): string {
    const vendor = String(vendorName || "").toLowerCase().trim();
    const po = String(poNumber || "").trim();
    return vendor && po ? `${vendor}::${po}` : "";
}

/**
 * Provenance for a link that ALREADY exists on the row (e.g. matched_unreconciled),
 * derived from data the invoice queue already has — no matcher call, no scoring.
 *
 * Only claims what the data supports:
 *  - the document's printed PO equals the linked PO → `exact_po`
 *  - the vendor→PO pair is in confirmed_po_matches     → `confirmed`
 *  - otherwise                                        → `unknown` (verify)
 *
 * It deliberately does NOT guess "vendor+date": re-running the tiers here would
 * be a second scorer, and the tier used at link time is not stored.
 */
export function inferLinkedPoMatchMethod(input: {
    poNumber: string | null | undefined;
    vendorName?: string | null;
    ocrPoCandidate?: string | null;
    ocrOrderCandidate?: string | null;
    /** Output of {@link confirmedPairKey} for every confirmed pair. */
    confirmedPairs?: Set<string> | null;
}): PoMatchMethod {
    const po = String(input.poNumber || "").trim();
    if (!po) return "unknown";

    const printed =
        sanitizeOcrPoCandidate(input.ocrPoCandidate) ||
        sanitizeOcrPoCandidate(input.ocrOrderCandidate);
    if (printed && printed.toUpperCase() === po.toUpperCase()) return "exact_po";

    const key = confirmedPairKey(input.vendorName, po);
    if (key && input.confirmedPairs?.has(key)) return "confirmed";

    return "unknown";
}
