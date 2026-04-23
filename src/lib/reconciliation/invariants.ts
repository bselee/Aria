import { RECONCILIATION_CONFIG } from '@/config/reconciliation';

export class InvariantViolationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvariantViolationError';
    }
}

export function assertSubtotalMatch(opts: {
    vendorInvoiceSubtotal: number;
    finalePoSubtotalAfter: number;
    toleranceDollars?: number;
    context: { vendor: string; invoiceNumber: string; poId: string };
}): void | never {
    const tolerance = opts.toleranceDollars ?? RECONCILIATION_CONFIG.subtotalToleranceDollars;
    const diff = Math.abs(opts.vendorInvoiceSubtotal - opts.finalePoSubtotalAfter);
    if (diff > tolerance) {
        throw new InvariantViolationError(
            `[${opts.context.vendor}] Subtotal mismatch for invoice ${opts.context.invoiceNumber} on PO ${opts.context.poId}: ` +
            `vendor=${opts.vendorInvoiceSubtotal}, finale=${opts.finalePoSubtotalAfter}, diff=${diff}, tolerance=${tolerance}`
        );
    }
}

export function assertPriceReasonable(opts: {
    sku: string;
    oldPrice: number;
    newPrice: number;
    context: { vendor: string; invoiceNumber: string };
}): void | never {
    const { maxMultiplier, minMultiplier, absolutePriceCeilingForSmallPrices } = RECONCILIATION_CONFIG.priceReasonable;

    if (opts.newPrice > opts.oldPrice * maxMultiplier) {
        throw new InvariantViolationError(
            `[${opts.context.vendor}] Price spike for SKU ${opts.sku} on invoice ${opts.context.invoiceNumber}: ` +
            `old=${opts.oldPrice}, new=${opts.newPrice}, multiplier=${(opts.newPrice / opts.oldPrice).toFixed(1)}x ` +
            `(max allowed: ${maxMultiplier}x) — possible UOM error`
        );
    }

    if (opts.newPrice < opts.oldPrice * minMultiplier) {
        throw new InvariantViolationError(
            `[${opts.context.vendor}] Price drop for SKU ${opts.sku} on invoice ${opts.context.invoiceNumber}: ` +
            `old=${opts.oldPrice}, new=${opts.newPrice}, multiplier=${(opts.newPrice / opts.oldPrice).toFixed(1)}x ` +
            `(min allowed: ${minMultiplier}x) — possible UOM error`
        );
    }

    const { price: ceilingPrice, ceiling: smallOldPrice } = absolutePriceCeilingForSmallPrices;
    if (opts.newPrice > ceilingPrice && opts.oldPrice < smallOldPrice) {
        throw new InvariantViolationError(
            `[${opts.context.vendor}] Classic decimal-shift detected for SKU ${opts.sku} on invoice ${opts.context.invoiceNumber}: ` +
            `old=${opts.oldPrice}, new=${opts.newPrice} — new price >$${ceilingPrice} but old price <$${smallOldPrice}`
        );
    }
}
