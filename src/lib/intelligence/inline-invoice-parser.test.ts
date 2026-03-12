import { describe, it, expect } from 'vitest';
import { detectInlineInvoice } from './inline-invoice-parser';

describe('detectInlineInvoice', () => {
    it('should detect an email with dollar amounts and cost breakdown', () => {
        const body = `Hi Bill,
        55 - 1# bags of 15-1-1
        Product cost: $1045.00
        Shipping: $95.77 UPS Ground
        Total: $1140.77`;
        expect(detectInlineInvoice(body, false)).toBe(true);
    });

    it('should NOT detect when a PDF is already attached', () => {
        const body = 'Here is your invoice for $500.00. Total: $500.00.';
        expect(detectInlineInvoice(body, true)).toBe(false);
    });

    it('should NOT detect casual price mentions without total/cost pattern', () => {
        const body = 'The product normally costs $20 per unit. Let me know if interested.';
        expect(detectInlineInvoice(body, false)).toBe(false);
    });

    it('should detect "total" + dollar amount pattern', () => {
        const body = `Invoice for PO #124462
        Subtotal: $500.00
        Freight: $50.00
        Total: $550.00`;
        expect(detectInlineInvoice(body, false)).toBe(true);
    });

    it('should detect "amount due" pattern', () => {
        const body = 'Amount due: $1,234.56. Shipping cost: $50.00. Please remit payment.';
        expect(detectInlineInvoice(body, false)).toBe(true);
    });
});
