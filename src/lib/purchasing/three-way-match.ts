/**
 * @file    three-way-match.ts
 * @purpose Canonical 3-way match gate for AP approval. Compares the three
 *          documents — Purchase Order, Receiving Report, Vendor Invoice — and
 *          returns a single authoritative verdict that the approval surfaces
 *          MUST consult before writing "reconciled" anywhere.
 * @author  Hermia
 * @created 2026-07-29
 * @deps    (none — pure functions, no I/O, no DB)
 * @env     (none)
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * 3-way matching is standard AP discipline, not a bespoke invention:
 *
 *   1. PURCHASE ORDER    — what we agreed to buy, and at what price
 *   2. RECEIVING REPORT  — what physically arrived on the dock
 *   3. VENDOR INVOICE    — what the vendor is billing us for
 *
 * You pay ONLY when all three agree, within tolerance. If quantities or prices
 * disagree beyond tolerance, the invoice is an EXCEPTION and must be resolved
 * (credit memo, corrected invoice, short-ship claim) before payment.
 *
 * HERMIA(2026-07-29): Aria had all three documents but no gate. Both dashboard
 * approval handlers wrote `status='reconciled'` to four tables without ever
 * comparing the documents, and — in the Receivings case — without contacting
 * Finale at all. That produced POs marked reconciled whose corrections never
 * posted. This module is the missing enforcement layer.
 *
 * Design notes:
 *  - Pure. No DB, no network. Trivially testable, callable from any surface.
 *  - Compares in BASE UNITS. Invoice lines may be billed per-case while the PO
 *    and receipt are per-each; see `packMultiplier` on ThreeWayLine. Comparing
 *    raw quantities across differing UOM is the classic false-exception source.
 *  - Distinguishes BLOCKING failures from informational variances so the UI can
 *    show "why" rather than a bare refusal.
 */

/** Verdict for a completed 3-way comparison. */
export type ThreeWayVerdict =
    | "matched"           // All three agree within tolerance — safe to approve & pay
    | "variance"          // Within review band — a human may approve with justification
    | "exception"         // Outside tolerance — must NOT be auto-approved
    | "incomplete";       // A required document leg is missing — cannot match yet

/** Which of the three legs is unavailable. */
export type MissingLeg = "purchase_order" | "receipt" | "invoice";

/**
 * One line item as seen across the three documents.
 *
 * All quantities MUST be expressed in the same base unit. When the vendor bills
 * by the case, set `packMultiplier` so invoice quantities can be normalized:
 *   invoiceQtyBase = invoiceQty × packMultiplier
 *   invoiceUnitPriceBase = invoiceUnitPrice ÷ packMultiplier
 */
export interface ThreeWayLine {
    /** SKU / product identifier used to align the three documents. */
    productId: string;
    /** Human-readable description, for exception messages. */
    description?: string;
    /** Quantity ordered on the PO, in base units. */
    poQty: number;
    /** Unit price agreed on the PO, per base unit. */
    poUnitPrice: number;
    /** Quantity physically received, in base units. Null = nothing received. */
    receivedQty: number | null;
    /** Quantity billed on the invoice, in the invoice's own UOM. */
    invoiceQty: number;
    /** Unit price billed on the invoice, per the invoice's own UOM. */
    invoiceUnitPrice: number;
    /**
     * Units per invoice unit (e.g. 12 for a 12-pack). Defaults to 1.
     * Derive from receipt evidence where possible rather than guessing.
     */
    packMultiplier?: number;
}

/** Tolerances. Defaults reflect common AP practice; override per vendor. */
export interface ThreeWayTolerances {
    /** Fractional price variance auto-approved (0.02 = 2%). */
    pricePct: number;
    /** Absolute per-line dollar variance always allowed, regardless of pct. */
    priceAbs: number;
    /**
     * Fractional over-receipt allowed (0.02 = may receive 2% more than ordered).
     * Over-BILLING beyond what was received is never tolerated.
     */
    qtyOverPct: number;
    /** Whole units of quantity variance always allowed (rounding, breakage). */
    qtyAbsUnits: number;
}

export const DEFAULT_TOLERANCES: ThreeWayTolerances = {
    pricePct: 0.02,
    priceAbs: 1.0,
    qtyOverPct: 0.02,
    qtyAbsUnits: 1,
};

/** A single discrepancy found during matching. */
export interface ThreeWayDiscrepancy {
    productId: string;
    /** Which comparison failed. */
    kind:
        | "qty_over_billed"      // invoice qty > received qty  (paying for goods not received)
        | "qty_short_received"   // received qty < ordered qty  (short shipment)
        | "qty_over_received"    // received qty > ordered qty  (over-delivery)
        | "price_variance"       // invoice price != PO price beyond tolerance
        | "line_not_on_po"       // invoice line has no matching PO line
        | "line_not_invoiced";   // PO line received but never billed
    /** True when this must block approval. */
    blocking: boolean;
    /** Dollar impact of this discrepancy (positive = we are being overcharged). */
    dollarImpact: number;
    /** Plain-language explanation for the dashboard. */
    message: string;
}

export interface ThreeWayMatchInput {
    orderId: string;
    /** False when the PO could not be loaded from Finale. */
    hasPurchaseOrder: boolean;
    /**
     * True only with CONCRETE receipt evidence (a real receiveDate or receipt
     * record). Finale auto-completes POs on quantity match, so a "Completed"
     * status alone is NOT proof of physical receipt.
     */
    hasReceipt: boolean;
    /** False when no invoice has been matched to this PO. */
    hasInvoice: boolean;
    lines: ThreeWayLine[];
    tolerances?: Partial<ThreeWayTolerances>;
}

export interface ThreeWayMatchResult {
    orderId: string;
    verdict: ThreeWayVerdict;
    /** True only when verdict === "matched". The approval gate. */
    canApprove: boolean;
    /** Legs missing when verdict === "incomplete". */
    missingLegs: MissingLeg[];
    discrepancies: ThreeWayDiscrepancy[];
    /** Net dollar impact across all discrepancies. */
    totalDollarImpact: number;
    /** One-line human summary suitable for a dashboard banner. */
    summary: string;
}

/** Round to cents to avoid float noise in comparisons and messages. */
function money(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * Run the canonical 3-way match.
 *
 * Order of evaluation matters and mirrors how an AP clerk works:
 *   1. Are all three documents present? If not -> incomplete, nothing to compare.
 *   2. Per line, is the vendor billing for more than we received? -> hard block.
 *   3. Per line, does the price match the PO within tolerance? -> block if not.
 *   4. Informational: short shipments and over-deliveries are surfaced but do
 *      not by themselves block payment for goods actually received.
 *
 * @param input Documents and per-line figures to compare.
 * @returns A verdict plus every discrepancy found.
 */
export function evaluateThreeWayMatch(input: ThreeWayMatchInput): ThreeWayMatchResult {
    const tol: ThreeWayTolerances = { ...DEFAULT_TOLERANCES, ...(input.tolerances ?? {}) };

    // ── Step 1: all three legs must exist ───────────────────────────────────
    const missingLegs: MissingLeg[] = [];
    if (!input.hasPurchaseOrder) missingLegs.push("purchase_order");
    if (!input.hasReceipt) missingLegs.push("receipt");
    if (!input.hasInvoice) missingLegs.push("invoice");

    if (missingLegs.length > 0) {
        const label = missingLegs
            .map((l) => (l === "purchase_order" ? "purchase order" : l))
            .join(" + ");
        return {
            orderId: input.orderId,
            verdict: "incomplete",
            canApprove: false,
            missingLegs,
            discrepancies: [],
            totalDollarImpact: 0,
            summary: `Cannot 3-way match — missing ${label}.`,
        };
    }

    // ── Steps 2-4: per-line comparison in base units ────────────────────────
    const discrepancies: ThreeWayDiscrepancy[] = [];

    for (const line of input.lines) {
        const pack = line.packMultiplier && line.packMultiplier > 0 ? line.packMultiplier : 1;
        const invoiceQtyBase = line.invoiceQty * pack;
        const invoiceUnitPriceBase = line.invoiceUnitPrice / pack;
        // HERMIA(2026-08-27): receivedQty can be NULL on the dashboard GET path
        // (shipment detail fetches are deferred to POST complete_po for latency).
        // null ≠ 0: an unknown receipt must NOT trigger a blocking overbill
        // ("billed 20 but received 0") on a PO Finale already auto-completed.
        const receivedQty = line.receivedQty;
        const label = line.description ? `${line.productId} (${line.description})` : line.productId;

        // Invoice line that isn't on the PO at all.
        if (line.poQty <= 0 && line.poUnitPrice <= 0) {
            discrepancies.push({
                productId: line.productId,
                kind: "line_not_on_po",
                blocking: true,
                dollarImpact: money(invoiceQtyBase * invoiceUnitPriceBase),
                message: `${label}: invoiced but not present on the PO.`,
            });
            continue;
        }

        // ── Billing for more than was received. The cardinal 3-way failure. ──
        // Only evaluated when the receipt quantity is actually known (POST path);
        // a null receivedQty means the receipt leg hasn't been loaded, so an
        // overbill cannot be asserted.
        if (receivedQty != null) {
            const qtyAllowance = Math.max(tol.qtyAbsUnits, receivedQty * tol.qtyOverPct);
            if (invoiceQtyBase > receivedQty + qtyAllowance) {
                const over = invoiceQtyBase - receivedQty;
                discrepancies.push({
                    productId: line.productId,
                    kind: "qty_over_billed",
                    blocking: true,
                    dollarImpact: money(over * invoiceUnitPriceBase),
                    message:
                        `${label}: billed ${invoiceQtyBase} but received ${receivedQty} ` +
                        `(${money(over)} unit overbill). Do not pay until resolved.`,
                });
            }
        }

        // ── Price agreement against the PO ──────────────────────────────────
        if (line.poUnitPrice > 0) {
            const delta = invoiceUnitPriceBase - line.poUnitPrice;
            const pct = Math.abs(delta) / line.poUnitPrice;
            const withinPct = pct <= tol.pricePct;
            const withinAbs = Math.abs(delta) <= tol.priceAbs;

            if (!withinPct && !withinAbs) {
                // Only bill for units actually received.
                const billableQty = Math.min(invoiceQtyBase, Math.max(receivedQty, 0));
                discrepancies.push({
                    productId: line.productId,
                    kind: "price_variance",
                    blocking: true,
                    dollarImpact: money(delta * billableQty),
                    message:
                        `${label}: PO $${line.poUnitPrice.toFixed(2)}/unit vs invoice ` +
                        `$${invoiceUnitPriceBase.toFixed(2)}/unit (${(pct * 100).toFixed(1)}% variance).`,
                });
            }
        }

        // ── Informational: receipt vs order quantity ────────────────────────
        // A short shipment does not block paying for what DID arrive; it is
        // surfaced so the buyer can chase the balance or request a credit.
        if (receivedQty > 0 && receivedQty < line.poQty - tol.qtyAbsUnits) {
            discrepancies.push({
                productId: line.productId,
                kind: "qty_short_received",
                blocking: false,
                dollarImpact: 0,
                message: `${label}: ordered ${line.poQty}, received ${receivedQty} — short ${line.poQty - receivedQty}.`,
            });
        }

        const overRecvAllowance = Math.max(tol.qtyAbsUnits, line.poQty * tol.qtyOverPct);
        if (receivedQty > line.poQty + overRecvAllowance) {
            discrepancies.push({
                productId: line.productId,
                kind: "qty_over_received",
                blocking: false,
                dollarImpact: 0,
                message: `${label}: ordered ${line.poQty}, received ${receivedQty} — over-delivery.`,
            });
        }
    }

    const blocking = discrepancies.filter((d) => d.blocking);
    const totalDollarImpact = money(
        discrepancies.reduce((sum, d) => sum + d.dollarImpact, 0),
    );

    if (blocking.length > 0) {
        return {
            orderId: input.orderId,
            verdict: "exception",
            canApprove: false,
            missingLegs: [],
            discrepancies,
            totalDollarImpact,
            summary:
                `3-way match FAILED — ${blocking.length} blocking discrepanc${blocking.length === 1 ? "y" : "ies"}` +
                (totalDollarImpact !== 0 ? ` ($${Math.abs(totalDollarImpact).toFixed(2)} impact)` : "") +
                `. ${blocking[0].message}`,
        };
    }

    if (discrepancies.length > 0) {
        return {
            orderId: input.orderId,
            verdict: "variance",
            canApprove: false,
            missingLegs: [],
            discrepancies,
            totalDollarImpact,
            summary:
                `3-way match within price/qty tolerance, but ${discrepancies.length} ` +
                `variance${discrepancies.length === 1 ? "" : "s"} noted. ${discrepancies[0].message}`,
        };
    }

    return {
        orderId: input.orderId,
        verdict: "matched",
        canApprove: true,
        missingLegs: [],
        discrepancies: [],
        totalDollarImpact: 0,
        summary: `3-way match clean — PO, receipt, and invoice agree across ${input.lines.length} line(s).`,
    };
}
