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

    // Regression: PO #124462 — Ed Zybura's casual inline invoice
    // This exact email body was missed because the original heuristic
    // only matched formal terms like "freight" and "subtotal".
    it('should detect casual vendor cost breakdown (PO #124462 regression)', () => {
        const body = `BILL, I SENT IT OUT TUESDAY 55-1# BAGS TOTAL $1140.77 BREAKDOWN IS $1145.00 PLUS ONE BOX UPS GROUND $95.77 TOTAL IS $1140.77`;
        expect(detectInlineInvoice(body, false)).toBe(true);
    });

    it('should detect casual vendor cost breakdown with PO-thread context', () => {
        const body = `BILL, I SENT IT OUT TUESDAY 55-1# BAGS TOTAL $1140.77 BREAKDOWN IS $1145.00 PLUS ONE BOX UPS GROUND $95.77 TOTAL IS $1140.77`;
        const subject = 'BuildASoil PO # 124462 - Organic AG Products - 3/10/2026';
        // With PO-thread context, threshold is lowered to 1
        expect(detectInlineInvoice(body, false, subject)).toBe(true);
    });

    it('should detect when PO-thread context lowers threshold (single keyword + dollar)', () => {
        // Only "total" keyword, but in a PO thread → threshold is 1
        const body = 'Total for your order is $500.00. Shipped today.';
        const subject = 'Re: BuildASoil PO #99999 - Test Vendor - 3/10/2026';
        expect(detectInlineInvoice(body, false, subject)).toBe(true);
    });

    it('should NOT detect with zero keywords even in PO thread context', () => {
        // Dollar amount present but no invoice keywords at all
        const body = 'Hey Bill, confirmed we got your order for $500.00 worth of stuff. Will ship soon!';
        const subject = 'Re: BuildASoil PO #99999 - Test Vendor';
        // "total" does NOT appear, "breakdown" does NOT appear, etc.
        // But... "shipped" is now a keyword. Let me adjust.
        // Actually this body has NO matching keywords. $500.00 is present but no keywords.
        expect(detectInlineInvoice(body, false, subject)).toBe(false);
    });
});
