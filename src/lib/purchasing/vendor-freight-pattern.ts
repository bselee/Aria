/**
 * @file    vendor-freight-pattern.ts
 * @purpose Classify how each vendor handles freight on their POs, based on
 *          historical evidence. Drives the per-vendor eligibility gate for
 *          po-auto-complete: only vendors whose pattern is "high confidence"
 *          (clear dominant pattern, sufficient sample) get auto-completed.
 *
 *          Three terminal patterns:
 *            vendor_freight — vendor includes freight on their invoice and
 *                             we reconcile it to a Finale freight line
 *            bas_freight    — vendor invoice has no freight; we add it
 *                             ourselves (FedEx schedule etc.)
 *            no_freight     — no freight ever changes hands (pickup, drop-
 *                             ship at vendor cost, flat-rate fulfillment)
 *
 *          Plus operational states: mixed (no dominant pattern → manual
 *          handling required) and insufficient_data (<8 sample size).
 *
 *          Will-known overrides take precedence over historical data so
 *          sparse / freshly-introduced vendors get classified correctly.
 *          Overrides apply as a case-insensitive substring match.
 */

export type FreightPattern =
    | "vendor_freight"
    | "bas_freight"
    | "no_freight"
    | "mixed"
    | "insufficient_data";

export interface PatternEvidence {
    poId: string;
    hadFreightOnPO: boolean;          // any FREIGHT adjustment on the PO at completion
    invoiceFreight: number;           // invoice's freight value (0 if none)
    matched: boolean;                 // invoice freight matched (within $0.01) to PO freight
}

export interface VendorFreightPatternResult {
    pattern: FreightPattern;
    sampleSize: number;
    confidence: "high" | "medium" | "low";
    /** Dominance of the winning bucket as a fraction of sampleSize. */
    dominance: number;
    breakdown: {
        vendorFreight: number;
        basFreight: number;
        noFreight: number;
    };
    /** Where the classification came from. */
    source: "override" | "history" | "no_data";
}

// ── Configurable thresholds ────────────────────────────────────────────────

export const VENDOR_PATTERN_CONFIG = {
    /** Minimum samples before we trust a historical classification. */
    MIN_SAMPLE_SIZE: 8,
    /** Sample size for "high" confidence. */
    HIGH_CONFIDENCE_SAMPLE: 15,
    /** Fraction of samples that must agree for a dominant pattern. */
    DOMINANCE_THRESHOLD: 0.7,
    /** Above this dominance + above HIGH_CONFIDENCE_SAMPLE → confidence=high. */
    HIGH_CONFIDENCE_DOMINANCE: 0.8,
};

// ── Will-known overrides ───────────────────────────────────────────────────
// Case-insensitive substring match against the vendor name (e.g., "miles"
// will match "Miles Nursery LLC", "Miles, Inc.", and just "Miles").

export const VENDOR_PATTERN_OVERRIDES: Array<{
    match: string;
    pattern: FreightPattern;
    note: string;
}> = [
    // Confirmed by Will 2026-05-15.
    { match: "miles",          pattern: "no_freight",     note: "Will-confirmed: never has freight" },
    { match: "thrive",         pattern: "no_freight",     note: "Will-confirmed: never has freight" },
    { match: "colorado worm",  pattern: "no_freight",     note: "Will-confirmed: never has freight" },
    { match: "rootwise",       pattern: "bas_freight",    note: "Will-confirmed: we schedule FedEx; vendor invoice has no freight" },
    { match: "uline",          pattern: "bas_freight",    note: "Will-confirmed: we schedule FedEx; vendor invoice has no freight" },
    // Colorful Packaging (China) — DDP shipping included on their invoice as a separate line.
    // Freight value extracted by inline-invoice-handler and reconciled to a FREIGHT adjustment on the PO.
    { match: "colorful",       pattern: "vendor_freight", note: "Will-confirmed: overseas DDP, vendor includes freight on their CC invoice" },
];

function findOverride(vendorName: string): typeof VENDOR_PATTERN_OVERRIDES[number] | null {
    const lc = (vendorName || "").toLowerCase();
    for (const o of VENDOR_PATTERN_OVERRIDES) {
        if (lc.includes(o.match)) return o;
    }
    return null;
}

// ── Pure classifier ────────────────────────────────────────────────────────

/**
 * Classify a vendor's freight pattern from historical PO evidence.
 *
 * For each historical PO we look at:
 *   - hadFreightOnPO: was there a FREIGHT adjustment on the PO at completion?
 *   - invoiceFreight: did the matched invoice (if any) include a freight value?
 *   - matched: did invoice.freight ≈ PO freight (within $0.01)?
 *
 * Bucketing:
 *   - vendor_freight: invoice had freight AND it landed on the PO (matched)
 *   - bas_freight: PO had freight BUT no invoice freight (we added it)
 *   - no_freight: neither PO nor invoice had freight
 *
 * Edge cases (counted toward "mixed"):
 *   - Invoice had freight that did NOT match PO freight — leakage, ambiguous
 *   - PO had freight + invoice had freight + both > 0 but different values
 */
export function classifyVendorFreightPattern(
    vendorName: string,
    evidence: PatternEvidence[],
): VendorFreightPatternResult {
    // Override path: explicit Will-known vendor classifications win.
    const override = findOverride(vendorName);
    if (override) {
        return {
            pattern: override.pattern,
            sampleSize: evidence.length,
            confidence: "high",
            dominance: 1,
            breakdown: { vendorFreight: 0, basFreight: 0, noFreight: 0 },
            source: "override",
        };
    }

    if (evidence.length === 0) {
        return {
            pattern: "insufficient_data",
            sampleSize: 0,
            confidence: "low",
            dominance: 0,
            breakdown: { vendorFreight: 0, basFreight: 0, noFreight: 0 },
            source: "no_data",
        };
    }

    let vendorFreight = 0;
    let basFreight = 0;
    let noFreight = 0;
    let ambiguous = 0;

    for (const ev of evidence) {
        const hadInvFr = ev.invoiceFreight > 0;
        if (hadInvFr && ev.hadFreightOnPO && ev.matched) {
            vendorFreight++;
        } else if (!hadInvFr && ev.hadFreightOnPO) {
            basFreight++;
        } else if (!hadInvFr && !ev.hadFreightOnPO) {
            noFreight++;
        } else {
            // invoice had freight but didn't match PO, or other mismatch.
            ambiguous++;
        }
    }

    const sampleSize = evidence.length;
    const counts = [
        { pattern: "vendor_freight" as const, count: vendorFreight },
        { pattern: "bas_freight" as const, count: basFreight },
        { pattern: "no_freight" as const, count: noFreight },
    ].sort((a, b) => b.count - a.count);

    const winner = counts[0];
    const dominance = winner.count / sampleSize;

    if (sampleSize < VENDOR_PATTERN_CONFIG.MIN_SAMPLE_SIZE) {
        return {
            pattern: "insufficient_data",
            sampleSize,
            confidence: "low",
            dominance,
            breakdown: { vendorFreight, basFreight, noFreight },
            source: "history",
        };
    }

    // Ambiguous-heavy samples (>30%) get classified as mixed regardless of
    // any one bucket's count — the vendor's handling is genuinely
    // inconsistent and shouldn't be auto-completed.
    if (ambiguous / sampleSize > 0.3) {
        return {
            pattern: "mixed",
            sampleSize,
            confidence: "low",
            dominance,
            breakdown: { vendorFreight, basFreight, noFreight },
            source: "history",
        };
    }

    if (dominance < VENDOR_PATTERN_CONFIG.DOMINANCE_THRESHOLD) {
        return {
            pattern: "mixed",
            sampleSize,
            confidence: "low",
            dominance,
            breakdown: { vendorFreight, basFreight, noFreight },
            source: "history",
        };
    }

    const confidence: "high" | "medium" | "low" =
        sampleSize >= VENDOR_PATTERN_CONFIG.HIGH_CONFIDENCE_SAMPLE &&
        dominance >= VENDOR_PATTERN_CONFIG.HIGH_CONFIDENCE_DOMINANCE
            ? "high"
            : "medium";

    return {
        pattern: winner.pattern,
        sampleSize,
        confidence,
        dominance,
        breakdown: { vendorFreight, basFreight, noFreight },
        source: "history",
    };
}
