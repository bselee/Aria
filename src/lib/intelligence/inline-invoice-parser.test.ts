import { describe, it, expect } from 'vitest';
import { detectInlineInvoice, detectPaidInvoice } from './inline-invoice-parser';

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

// ──────────────────────────────────────────────────
// PAID INVOICE DETECTION TESTS
// ──────────────────────────────────────────────────

describe('detectPaidInvoice', () => {
    // --- STRONG SIGNAL: Pattern 1 — "Invoice ___ paid" ---

    it('should detect AxiomPrint-style "Invoice INV122172 paid $148.76 successfully"', () => {
        const subject = 'Invoice INV122172 paid $148.76 successfully';
        const body = `AxiomPrint, Inc. Balance $0.00`;
        expect(detectPaidInvoice(subject, body)).toBe(true);
    });

    it('should detect "Invoice #12345 paid" in subject', () => {
        const subject = 'Invoice #12345 paid';
        const body = 'Your payment has been processed.';
        expect(detectPaidInvoice(subject, body)).toBe(true);
    });

    it('should detect "Invoice ABC-99 paid" with alphanumeric invoice number', () => {
        const subject = 'Invoice ABC-99 paid via ACH';
        const body = '';
        expect(detectPaidInvoice(subject, body)).toBe(true);
    });

    // --- STRONG SIGNAL: Pattern 3 — "payment.*successful" ---

    it('should detect "Your payment was successful" with dollar amount', () => {
        const subject = 'Your payment was successful';
        const body = 'Payment of $500.00 has been confirmed for invoice #887.';
        expect(detectPaidInvoice(subject, body)).toBe(true);
    });

    it('should detect "Payment successful" in body with amount', () => {
        const subject = 'Order Confirmation';
        const body = 'Your payment was processed successfully. Amount: $245.50';
        expect(detectPaidInvoice(subject, body)).toBe(true);
    });

    it('should detect "successfully paid" pattern', () => {
        const subject = 'Invoice successfully paid';
        const body = 'Amount: $100.00';
        expect(detectPaidInvoice(subject, body)).toBe(true);
    });

    // --- MEDIUM SIGNALS (need 2+) ---

    it('should detect "Balance $0.00" + "invoice" + "paid" combo', () => {
        const subject = 'Invoice #9999';
        const body = 'This invoice has been paid. Balance $0.00. Thank you for your payment.';
        expect(detectPaidInvoice(subject, body)).toBe(true);
    });

    it('should detect "paid $___" + "receipt" + "payment" combo', () => {
        const subject = 'Payment Receipt';
        const body = 'You paid $325.00 for your recent order. This is your payment receipt.';
        expect(detectPaidInvoice(subject, body)).toBe(true);
    });

    it('should detect "transaction complete" + "paid" pattern', () => {
        const subject = 'Transaction complete - Invoice 456';
        const body = 'Your invoice has been paid. Transaction complete.';
        expect(detectPaidInvoice(subject, body)).toBe(true);
    });

    // --- FALSE POSITIVE PREVENTION ---

    it('should NOT detect when the email has a PDF attachment (goes to normal AP pipeline)', () => {
        const subject = 'Invoice INV999 paid $500.00 successfully';
        const body = 'See attached PDF.';
        expect(detectPaidInvoice(subject, body, true)).toBe(false);
    });

    it('should NOT detect casual mention of payment without strong signals', () => {
        const subject = 'Re: Order Status';
        const body = 'We haven\'t received your payment yet. Please send invoice for the items.';
        expect(detectPaidInvoice(subject, body)).toBe(false);
    });

    it('should NOT detect advertisements mentioning payment', () => {
        const subject = 'New features for easy payment processing!';
        const body = 'Try our new payment tool. Accept invoices and get paid faster.';
        expect(detectPaidInvoice(subject, body)).toBe(false);
    });

    it('should NOT detect shipping confirmation without payment language', () => {
        const subject = 'Your order has shipped';
        const body = 'Tracking: 1Z999999999. Order total was $150.00.';
        expect(detectPaidInvoice(subject, body)).toBe(false);
    });

    it('should NOT detect vendor question about unpaid invoice', () => {
        const subject = 'Unpaid Invoice #4567';
        const body = 'This invoice remains unpaid. Balance due: $800.00. Please remit.';
        expect(detectPaidInvoice(subject, body)).toBe(false);
    });
});
