import { describe, it, expect } from 'vitest';
import { assertSubtotalMatch, assertPriceReasonable, InvariantViolationError } from './invariants';

describe('assertSubtotalMatch', () => {
    it('passes when vendor and finale are within tolerance', () => {
        expect(() => assertSubtotalMatch({
            vendorInvoiceSubtotal: 100.00,
            finalePoSubtotalAfter: 100.05,
            toleranceDollars: 10,
            context: { vendor: 'Test', invoiceNumber: 'INV1', poId: 'PO1' },
        })).not.toThrow();
    });

    it('passes exactly at tolerance boundary', () => {
        expect(() => assertSubtotalMatch({
            vendorInvoiceSubtotal: 100.00,
            finalePoSubtotalAfter: 110.00,
            toleranceDollars: 10,
            context: { vendor: 'Test', invoiceNumber: 'INV1', poId: 'PO1' },
        })).not.toThrow();
    });

    it('throws when diff exceeds tolerance', () => {
        expect(() => assertSubtotalMatch({
            vendorInvoiceSubtotal: 100.00,
            finalePoSubtotalAfter: 115.00,
            toleranceDollars: 10,
            context: { vendor: 'Test', invoiceNumber: 'INV1', poId: 'PO1' },
        })).toThrow(InvariantViolationError);
    });

    it('uses default tolerance of $10 when not specified', () => {
        expect(() => assertSubtotalMatch({
            vendorInvoiceSubtotal: 100.00,
            finalePoSubtotalAfter: 111.00,
            context: { vendor: 'Test', invoiceNumber: 'INV1', poId: 'PO1' },
        })).toThrow(InvariantViolationError);
    });

    it('handles zero values', () => {
        expect(() => assertSubtotalMatch({
            vendorInvoiceSubtotal: 0,
            finalePoSubtotalAfter: 0,
            toleranceDollars: 10,
            context: { vendor: 'Test', invoiceNumber: 'INV1', poId: 'PO1' },
        })).not.toThrow();
    });

    it('handles negative diff (vendor less than finale)', () => {
        expect(() => assertSubtotalMatch({
            vendorInvoiceSubtotal: 95.00,
            finalePoSubtotalAfter: 110.00,
            toleranceDollars: 10,
            context: { vendor: 'Test', invoiceNumber: 'INV1', poId: 'PO1' },
        })).toThrow(InvariantViolationError);
    });
});

describe('assertPriceReasonable', () => {
    it('passes for a normal price increase within 100x', () => {
        expect(() => assertPriceReasonable({
            sku: 'SKU001',
            oldPrice: 10.00,
            newPrice: 50.00,
            context: { vendor: 'Test', invoiceNumber: 'INV1' },
        })).not.toThrow();
    });

    it('throws when newPrice > 100 * oldPrice', () => {
        expect(() => assertPriceReasonable({
            sku: 'SKU001',
            oldPrice: 10.00,
            newPrice: 1001.00,
            context: { vendor: 'Test', invoiceNumber: 'INV1' },
        })).toThrow(InvariantViolationError);
    });

    it('throws when newPrice < oldPrice / 100', () => {
        expect(() => assertPriceReasonable({
            sku: 'SKU001',
            oldPrice: 1000.00,
            newPrice: 5.00,
            context: { vendor: 'Test', invoiceNumber: 'INV1' },
        })).toThrow(InvariantViolationError);
    });

    it('throws decimal-shift case: new > $10000 and old < $100', () => {
        expect(() => assertPriceReasonable({
            sku: 'SKU001',
            oldPrice: 50.00,
            newPrice: 15000.00,
            context: { vendor: 'Test', invoiceNumber: 'INV1' },
        })).toThrow(InvariantViolationError);
    });

    it('passes decimal-shift safe case: new > $10000 but old >= $100', () => {
        expect(() => assertPriceReasonable({
            sku: 'SKU001',
            oldPrice: 100.00,
            newPrice: 5000.00,
            context: { vendor: 'Test', invoiceNumber: 'INV1' },
        })).not.toThrow();
    });

    it('passes when newPrice < $10000 regardless of oldPrice', () => {
        expect(() => assertPriceReasonable({
            sku: 'SKU001',
            oldPrice: 20.00,
            newPrice: 999.00,
            context: { vendor: 'Test', invoiceNumber: 'INV1' },
        })).not.toThrow();
    });

    it('passes for exact same price', () => {
        expect(() => assertPriceReasonable({
            sku: 'SKU001',
            oldPrice: 25.00,
            newPrice: 25.00,
            context: { vendor: 'Test', invoiceNumber: 'INV1' },
        })).not.toThrow();
    });
});
