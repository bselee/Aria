/**
 * @file    invoice-po-correlate.ts
 * @purpose Correlate a vendor invoice (which prints our PO number and its own
 *          goods amount) to a purchase order.
 *
 *          The printed PO number is a hint, not proof: a vendor can print the
 *          wrong PO (Stock Bag Depot printed 125273 on the 751.50 invoice for
 *          125303). So a stated PO only wins when the PO's goods total matches
 *          the invoice's sales amount; otherwise fall back to an amount + date
 *          scan and refuse to guess between equally good candidates.
 *
 * @author  Hermia
 * @created 2026-10-07
 * @deps    none (pure)
 * @env     none
 */

/** Minimal PO shape the correlator needs (from the local purchase_orders mirror). */
export interface PoRef {
    poNumber: string;
    vendorName: string;
    /** PO goods total (`total_amount`). */
    totalAmount: number;
    /** PO issue date, `YYYY-MM-DD` or ISO. */
    issueDate: string | null;
    status: string | null;
}

/** How the invoice was correlated to the PO. */
export type CorrelateReason =
    | "stated_po_amount_confirmed"
    | "unique_amount_date"
    | "nearest_amount_date"
    | "stated_po_amount_mismatch"
    | "ambiguous_amount_date"
    | "no_candidate";

export interface CorrelateResult {
    match: PoRef | null;
    reason: CorrelateReason;
    /** Human-readable detail for the CLI report. */
    detail: string;
}

/** Default tolerance between the invoice sales amount and the PO goods total. */
export const AMOUNT_TOLERANCE = 0.5;
/** How far before the invoice a PO may have been issued. */
export const LOOKBACK_DAYS = 400;
/** Days the invoice may predate the PO (labels often run slightly ahead). */
export const LOOKAHEAD_DAYS = 7;

function days(a: string | null, b: string | null): number | null {
    if (!a || !b) return null;
    const da = Date.parse(a.slice(0, 10));
    const db = Date.parse(b.slice(0, 10));
    if (Number.isNaN(da) || Number.isNaN(db)) return null;
    return Math.round((db - da) / 86_400_000);
}

/**
 * Correlate one invoice to a PO among the vendor's POs.
 *
 * @param input.statedPo    PO number printed on the invoice, if any.
 * @param input.salesAmount Invoice goods amount ("Sales Amount").
 * @param input.invoiceDate Invoice date, `YYYY-MM-DD` or ISO.
 * @param pos               The vendor's POs to search.
 * @param tolerance         Amount tolerance in dollars (default {@link AMOUNT_TOLERANCE}).
 * @returns                 The matched PO and why, or a no/ambiguous reason.
 */
export function correlateInvoiceToPo(
    input: { statedPo: string | null; salesAmount: number; invoiceDate: string | null },
    pos: PoRef[],
    tolerance: number = AMOUNT_TOLERANCE,
): CorrelateResult {
    const withinAmount = (p: PoRef) => Math.abs(p.totalAmount - input.salesAmount) <= tolerance;

    // 1. Stated PO number, confirmed by amount.
    if (input.statedPo) {
        const stated = pos.find((p) => p.poNumber === input.statedPo);
        if (stated && withinAmount(stated)) {
            return {
                match: stated,
                reason: "stated_po_amount_confirmed",
                detail: `printed PO ${stated.poNumber} = $${stated.totalAmount.toFixed(2)} matches sales`,
            };
        }
        if (stated) {
            // Printed PO exists but the money disagrees; fall through to the amount scan.
            const fallback = amountScan(pos, withinAmount, input.invoiceDate);
            if (fallback.match) {
                return {
                    ...fallback,
                    reason: "stated_po_amount_mismatch",
                    detail: `printed PO ${stated.poNumber} is $${stated.totalAmount.toFixed(2)} (≠ sales $${input.salesAmount.toFixed(
                        2,
                    )}); ${fallback.detail}`,
                };
            }
            return {
                match: null,
                reason: "stated_po_amount_mismatch",
                detail: `printed PO ${stated.poNumber} is $${stated.totalAmount.toFixed(2)}, sales is $${input.salesAmount.toFixed(2)}`,
            };
        }
    }

    // 2. Amount + date scan.
    return amountScan(pos, withinAmount, input.invoiceDate);
}

function amountScan(
    pos: PoRef[],
    withinAmount: (p: PoRef) => boolean,
    invoiceDate: string | null,
): CorrelateResult {
    const candidates = pos
        .filter(withinAmount)
        .map((p) => ({ p, gap: days(p.issueDate, invoiceDate) }))
        .filter((c) => c.gap == null || (c.gap >= -LOOKAHEAD_DAYS && c.gap <= LOOKBACK_DAYS))
        .sort((a, b) => Math.abs(a.gap ?? 0) - Math.abs(b.gap ?? 0));

    if (candidates.length === 0) {
        return { match: null, reason: "no_candidate", detail: "no PO with a matching goods total in the window" };
    }
    if (candidates.length === 1) {
        return {
            match: candidates[0].p,
            reason: "unique_amount_date",
            detail: `only PO ${candidates[0].p.poNumber} at $${candidates[0].p.totalAmount.toFixed(2)}`,
        };
    }
    const [first, second] = candidates;
    const gapFirst = Math.abs(first.gap ?? 0);
    const gapSecond = Math.abs(second.gap ?? 0);
    // Demand a clear winner: the nearest PO must be at least twice as close.
    if (gapSecond >= 2 * Math.max(gapFirst, 1)) {
        return {
            match: first.p,
            reason: "nearest_amount_date",
            detail: `PO ${first.p.poNumber} is ${gapFirst}d from the invoice vs ${gapSecond}d for ${second.p.poNumber}`,
        };
    }
    return {
        match: null,
        reason: "ambiguous_amount_date",
        detail: `${candidates.length} POs share $${first.p.totalAmount.toFixed(2)} within the window (${candidates
            .map((c) => c.p.poNumber)
            .join(", ")})`,
    };
}
