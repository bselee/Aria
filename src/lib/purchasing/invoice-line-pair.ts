/**
 * @file    invoice-line-pair.ts
 * @purpose Pair an invoice line to a PO line without treating the vendor part as our SKU.
 *          After a unique pair, the caller writes the invoice price and stores their part
 *          on Supplier 1. A quantity difference is a vendor contact, not a rewrite.
 * @author  Hermia
 * @created 2026-09-23
 * @deps    none
 * @env     none
 */

export interface InvoiceLineForPair {
    vendorPart: string | null;
    quantity: number;
    unitPrice: number;
}

export interface PoLineForPair {
    productId: string;
    quantity: number;
    unitPrice: number;
}

export interface PairedInvoiceLine {
    status: "paired";
    productId: string;
    vendorPart: string | null;
    invoiceQty: number;
    invoiceUnitPrice: number;
    poQty: number;
    poUnitPrice: number;
    /** True when billed quantity is not the ordered quantity. Contact the vendor. Do not rewrite. */
    qtyDiffers: boolean;
}

export interface HeldInvoiceLine {
    status: "hold";
    vendorPart: string | null;
    reason: string;
}

export type InvoiceLinePair = PairedInvoiceLine | HeldInvoiceLine;

function sameId(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function moneyClose(a: number, b: number): boolean {
    return Math.abs(a - b) <= 0.01;
}

/**
 * Pair invoice lines to PO lines.
 *
 * Exact productId equality is allowed (Uline item numbers usually are our SKU).
 * A vendor part that merely contains or is contained by our SKU is not a match.
 * One remaining line on each side is a pair. Shared quantity pairs only when one
 * PO line has that quantity, or the unit price picks exactly one.
 *
 * @param invoiceLines Goods lines from the invoice. Zero qty or zero price are skipped.
 * @param poLines Goods lines on the already-identified purchase order.
 * @returns One result per invoice goods line, in input order.
 */
export function pairInvoiceLines(
    invoiceLines: InvoiceLineForPair[],
    poLines: PoLineForPair[],
): InvoiceLinePair[] {
    const goods = invoiceLines.filter((l) => l.quantity > 0 && l.unitPrice > 0);
    const open = poLines.filter((l) => l.quantity > 0);
    const used = new Set<string>();

    const take = (productId: string): void => {
        used.add(productId);
    };
    const free = (): PoLineForPair[] => open.filter((l) => !used.has(l.productId));

    return goods.map((inv): InvoiceLinePair => {
        const exact = free().find(
            (po) => inv.vendorPart != null && inv.vendorPart !== "" && sameId(inv.vendorPart, po.productId),
        );
        if (exact) {
            take(exact.productId);
            return paired(inv, exact);
        }

        const remaining = free();
        if (goods.length === 1 && open.length === 1 && remaining.length === 1) {
            take(remaining[0].productId);
            return paired(inv, remaining[0]);
        }

        const sameQty = remaining.filter((po) => po.quantity === inv.quantity);
        if (sameQty.length === 1) {
            take(sameQty[0].productId);
            return paired(inv, sameQty[0]);
        }
        const pricePick = sameQty.filter((po) => moneyClose(po.unitPrice, inv.unitPrice));
        if (pricePick.length === 1) {
            take(pricePick[0].productId);
            return paired(inv, pricePick[0]);
        }

        return {
            status: "hold",
            vendorPart: inv.vendorPart,
            reason: "line does not uniquely pair to a PO line by quantity and price",
        };
    });
}

function paired(inv: InvoiceLineForPair, po: PoLineForPair): PairedInvoiceLine {
    return {
        status: "paired",
        productId: po.productId,
        vendorPart: inv.vendorPart,
        invoiceQty: inv.quantity,
        invoiceUnitPrice: inv.unitPrice,
        poQty: po.quantity,
        poUnitPrice: po.unitPrice,
        qtyDiffers: inv.quantity !== po.quantity,
    };
}

export interface SupplierPriceDecision {
    write: boolean;
    reason: string;
}

function cleanPackMultiple(candidate: number, existing: number): boolean {
    if (candidate <= 0 || existing <= 0) return false;
    const ratio = Math.max(candidate, existing) / Math.min(candidate, existing);
    const nearest = Math.round(ratio);
    return nearest >= 2 && Math.abs(ratio - nearest) / nearest < 0.12;
}

/**
 * Decide whether the invoice price may be written to Supplier 1.
 *
 * Within 2% of the current Supplier 1 price, write. A clean integer multiple of
 * every prior price is a case-versus-each miss and does not write. One prior
 * price has no span: anything that is not a multiple writes. Two or more distinct
 * priors write when the move is no larger than that SKU's own largest step.
 *
 * @param input Current Supplier 1 price, the invoice unit price, and prior PO prices.
 * @returns Whether to write, and why.
 */
export function decideSupplierPriceWrite(input: {
    currentSupplierPrice: number;
    invoicePrice: number;
    priorPrices: number[];
}): SupplierPriceDecision {
    const invoice = input.invoicePrice;
    const current = input.currentSupplierPrice;
    if (!(invoice > 0)) {
        return { write: false, reason: "invoice price is not a number" };
    }

    if (current > 0 && Math.abs(invoice - current) / current <= 0.02) {
        return { write: true, reason: "within 2% of Supplier 1" };
    }

    const priors = [...new Set(
        [current, ...input.priorPrices].filter((p) => p > 0).map((p) => Math.round(p * 10000) / 10000),
    )];

    if (priors.length > 0 && priors.every((p) => cleanPackMultiple(invoice, p))) {
        return { write: false, reason: "clean pack multiple of every prior price" };
    }

    if (priors.length < 2) {
        return { write: true, reason: "one prior price and not a pack multiple" };
    }

    const sorted = [...priors].sort((a, b) => a - b);
    let maxStep = 0;
    for (let i = 1; i < sorted.length; i++) {
        maxStep = Math.max(maxStep, (sorted[i] - sorted[i - 1]) / sorted[i - 1]);
    }
    const nearest = sorted.reduce((best, p) =>
        Math.abs(p - invoice) < Math.abs(best - invoice) ? p : best,
    );
    const move = Math.abs(invoice - nearest) / nearest;
    if (move <= Math.max(maxStep, 0.02)) {
        return { write: true, reason: "inside how this SKU has moved" };
    }
    return { write: false, reason: "move is larger than this SKU's own price span" };
}
