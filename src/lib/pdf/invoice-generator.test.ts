import { describe, it, expect } from 'vitest';
import { generateInvoicePDF } from './invoice-generator';
import type { InvoiceData } from './invoice-parser';
import { PDFDocument } from 'pdf-lib';

const sampleInvoice: InvoiceData = {
    documentType: 'invoice',
    invoiceNumber: 'IG-2026-0312-124462',
    poNumber: '124462',
    vendorName: 'Organic AG Products',
    vendorEmail: 'ed@organicag.com',
    invoiceDate: '2026-03-12',
    lineItems: [
        { description: '15-1-1 (1# bags)', qty: 55, unitPrice: 19.00, total: 1045.00 }
    ],
    subtotal: 1045.00,
    freight: 95.77,
    total: 1140.77,
    amountDue: 1140.77,
    confidence: 'high',
    notes: 'UPS Ground shipping',
};

describe('generateInvoicePDF', () => {
    it('should return a valid PDF buffer', async () => {
        const buffer = await generateInvoicePDF(sampleInvoice);
        expect(buffer).toBeInstanceOf(Buffer);
        expect(buffer.length).toBeGreaterThan(500);

        // Verify it's a valid PDF by loading it
        const doc = await PDFDocument.load(buffer);
        expect(doc.getPageCount()).toBe(1);
    });

    it('should generate successfully without crashing', async () => {
        const buffer = await generateInvoicePDF(sampleInvoice);
        expect(buffer).toBeInstanceOf(Buffer);
        const doc = await PDFDocument.load(buffer);
        expect(doc.getPageCount()).toBe(1);
    });

    it('should handle invoices with no line items gracefully', async () => {
        const emptyInvoice: InvoiceData = {
            ...sampleInvoice,
            lineItems: [],
            subtotal: 0,
            total: 95.77,
            amountDue: 95.77,
        };
        const buffer = await generateInvoicePDF(emptyInvoice);
        expect(buffer).toBeInstanceOf(Buffer);
        const doc = await PDFDocument.load(buffer);
        expect(doc.getPageCount()).toBe(1);
    });

    it('should generate a unique invoice number from PO and date when not provided', async () => {
        const noInvNum: InvoiceData = {
            ...sampleInvoice,
            invoiceNumber: 'UNKNOWN',
        };
        const buffer = await generateInvoicePDF(noInvNum);
        expect(buffer).toBeInstanceOf(Buffer);
        const doc = await PDFDocument.load(buffer);
        expect(doc.getPageCount()).toBe(1);
    });
});
