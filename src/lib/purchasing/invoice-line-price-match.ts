/**
 * @file    invoice-line-price-match.ts
 * @purpose Prove which PO an invoice belongs to by UNIT PRICE, not by vendor
 *          name + date + amount. A vendor can hold several open POs at once
 *          (Colorado Worm: 125467 COWOCO2 @ $20, 125450 COWOCO1 @ $10,
 *          125441 COWOCO3 @ $40). An invoice that prints `100 x $20` belongs
 *          to the PO whose line is $20 — the price is the goods' identity
 *          when the invoice carries no SKU and no printed PO number.
 *
 *          Pure functions only — no I/O, no DB. The caller (invoice-po-matcher)
 *          supplies vendor-matched PO rows and owns any auto-apply decision.
 *
 * @author  Hermia
 * @created 2026-11-04
 */

/**
 * A priced goods line pulled from an invoice (freight/tax lines have no price
 * or a zero price and are dropped).
 */
export interface PricedInvoiceLine {
    unitPrice: number;
    qty: number;
}

/** A priced line pulled from a PO's `line_items` (Finale shape). */
export interface PricedPoLine {
    unitPrice: number;
    /**
     * Remaining units on the PO line. `null` = unknown (neither `remainingQty`
     * nor `quantity` present), `0` = explicitly fully received (covers nothing),
     * `> 0` = known remaining units still owed.
     */
    remainingQty: number | null;
}

/** A purchase_orders row carrying `line_items`, as the matcher fetches it. */
export interface UnitPricePoRow {
    po_number?: string | null;
    vendor_name?: string | null;
    issue_date?: string | null;
    total_amount?: number | string | null;
    total?: number | string | null;
    status?: string | null;
    line_items?: unknown;
}

/** One PO that shares at least one unit price with the invoice. */
export interface UnitPriceHit {
    poNumber: string;
    vendorName: string;
    orderDate: string;
    total: number;
    status: string;
    /** Invoice unit prices this PO matched (deduped). */
    matchedUnitPrices: number[];
    /** True when the PO matched every priced goods line on the invoice. */
    matchedAllLines: boolean;
}

/**
 * Two unit prices are "the same" to the cent. Rounding to cents is float-noise
 * safe: $19.999999 and $20.000001 both round to $20.00 and match.
 */
export function pricesMatch(a: number, b: number): boolean {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.round(a * 100) === Math.round(b * 100);
}

/** Coerce a `line_items` value (JSONB array or JSON string) to an array. */
function coerceToArray(lineItems: unknown): unknown[] {
    if (Array.isArray(lineItems)) return lineItems;
    if (typeof lineItems === "string") {
        try {
            const parsed: unknown = JSON.parse(lineItems);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

/**
 * Pull the priced goods lines out of an invoice's line items. Reads either the
 * camelCase `unitPrice` (InvoiceToMatch shape) or the snake_case `unit_price`
 * (vendor_invoices.line_items column) so either caller works.
 */
export function pricedInvoiceLines(lineItems: unknown): PricedInvoiceLine[] {
    const out: PricedInvoiceLine[] = [];
    for (const raw of coerceToArray(lineItems)) {
        const li = (raw ?? {}) as Record<string, unknown>;
        const unitPrice = Number(li.unitPrice ?? li.unit_price ?? 0);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;
        const qty = Number(li.qty ?? li.quantity ?? 0);
        out.push({ unitPrice, qty: Number.isFinite(qty) ? qty : 0 });
    }
    return out;
}

/**
 * Pull `{unitPrice, remainingQty}` out of a PO's `line_items` (Finale shape:
 * `{ productId, quantity, unitPrice, remainingQty }`). `quantity` may be a
 * string; `remainingQty` is the source of truth for what is still owed.
 *
 * `remainingQty` is three-state: `null` when neither `remainingQty` nor
 * `quantity` is present (unknown — the price is the only signal), `0` when
 * `remainingQty` is explicitly zero (fully received, covers nothing), and the
 * positive count otherwise.
 */
export function pricedPoLines(lineItems: unknown): PricedPoLine[] {
    const out: PricedPoLine[] = [];
    for (const raw of coerceToArray(lineItems)) {
        const li = (raw ?? {}) as Record<string, unknown>;
        const unitPrice = Number(li.unitPrice ?? 0);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;

        const hasRemaining = li.remainingQty !== undefined && li.remainingQty !== null;
        let remainingQty: number | null = null;
        if (hasRemaining) {
            const r = Number(li.remainingQty);
            remainingQty = Number.isFinite(r) ? r : null;
        }
        // No `quantity` fallback: an ABSENT remainingQty means an old PO that
        // predates remaining tracking (received), not "quantity still owed".
        out.push({ unitPrice, remainingQty });
    }
    return out;
}

/**
 * Score PO rows by unit-price overlap with the invoice's priced goods lines.
 *
 * A PO "covers" an invoice line when a PO line shares its unit price AND the
 * PO line still has enough remaining quantity to cover the invoice line's
 * quantity (an unknown quantity on either side skips that check). A PO that
 * matches every priced goods line is `matchedAllLines` — the conclusive
 * signal the caller may auto-apply on.
 *
 * @param invoiceLines the invoice's line items (array or JSON string, camel or
 *                     snake unit price).
 * @param poRows       vendor-matched purchase_orders rows carrying `line_items`.
 * @returns            hits with >= 1 matching unit price, conclusive first.
 */
export function scoreUnitPriceProof(
    invoiceLines: unknown,
    poRows: UnitPricePoRow[],
): UnitPriceHit[] {
    const priced = pricedInvoiceLines(invoiceLines);
    if (priced.length === 0) return [];

    const hits: UnitPriceHit[] = [];
    for (const po of poRows ?? []) {
        const poNumber = String(po?.po_number ?? "").trim();
        if (!poNumber || /DropshipPO$/i.test(poNumber)) continue;

        const poLines = pricedPoLines(po.line_items);
        const matched: number[] = [];
        for (const inv of priced) {
            const covered = poLines.some((pl) => {
                if (!pricesMatch(pl.unitPrice, inv.unitPrice)) return false;
                // Only an OPEN line covers: remainingQty must be present and > 0.
                // An absent (null) or zero remainingQty is a received PO — not cover.
                if (pl.remainingQty === null || pl.remainingQty <= 0) return false;
                if (inv.qty > 0) return pl.remainingQty >= inv.qty;
                return true;
            });
            if (covered && !matched.includes(inv.unitPrice)) matched.push(inv.unitPrice);
        }
        if (matched.length === 0) continue;

        hits.push({
            poNumber,
            vendorName: po.vendor_name || "",
            orderDate: String(po.issue_date || ""),
            total: Number(po.total_amount || po.total || 0),
            status: String(po.status || "unknown"),
            matchedUnitPrices: matched,
            matchedAllLines: matched.length === priced.length,
        });
    }

    hits.sort((a, b) => {
        if (a.matchedAllLines !== b.matchedAllLines) return a.matchedAllLines ? -1 : 1;
        return b.matchedUnitPrices.length - a.matchedUnitPrices.length;
    });
    return hits;
}
