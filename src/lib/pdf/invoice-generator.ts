/**
 * @file    invoice-generator.ts
 * @purpose Generates professional PDF invoices from structured data.
 *          Designed with composable layout primitives to allow future
 *          generation of Purchase Orders or Credit Memos using the same engine.
 * @author  Will / Antigravity
 * @created 2026-03-12
 * @updated 2026-03-12
 * @deps    pdf-lib, invoice-parser (InvoiceData type)
 */

import { PDFDocument, rgb, StandardFonts, PDFFont, PDFPage } from 'pdf-lib';
import type { InvoiceData } from './invoice-parser';

// --- Shared PDF Layout Primitives ---

const COLORS = {
    black: rgb(0, 0, 0),
    darkGray: rgb(0.3, 0.3, 0.3),
    medGray: rgb(0.5, 0.5, 0.5),
    lightGray: rgb(0.85, 0.85, 0.85),
    headerBg: rgb(0.15, 0.22, 0.35), // Dark navy
    white: rgb(1, 1, 1),
};

interface RenderContext {
    page: PDFPage;
    fontReg: PDFFont;
    fontBold: PDFFont;
    margin: number;
    width: number;
    height: number;
    y: number;
}

function drawHeaderBar(ctx: RenderContext, title: string, docTypeLabel: string) {
    ctx.page.drawRectangle({
        x: 0, y: ctx.height - 90, width: ctx.width, height: 90,
        color: COLORS.headerBg,
    });
    ctx.page.drawText(title, {
        x: ctx.margin, y: ctx.height - 55, size: 22, font: ctx.fontBold, color: COLORS.white,
    });
    ctx.page.drawText(docTypeLabel, {
        x: ctx.width - ctx.margin - ctx.fontBold.widthOfTextAtSize(docTypeLabel, 20),
        y: ctx.height - 55, size: 20, font: ctx.fontBold, color: COLORS.white,
    });
    ctx.y = ctx.height - 120;
}

function drawMetadataSection(ctx: RenderContext, billTo: string[], metaRows: [string, string][]) {
    const startY = ctx.y;
    
    // Left column: "Bill To:"
    ctx.page.drawText('Bill To:', { x: ctx.margin, y: ctx.y, size: 10, font: ctx.fontBold, color: COLORS.darkGray });
    let leftY = ctx.y - 16;
    for (const [idx, line] of billTo.entries()) {
        ctx.page.drawText(line, { 
            x: ctx.margin, y: leftY, size: idx === 0 ? 10 : 9, 
            font: ctx.fontReg, color: idx === 0 ? COLORS.black : COLORS.medGray 
        });
        leftY -= (idx === 0 ? 14 : 12);
    }

    // Right column: Metadata pairs
    let rightY = startY;
    const metaX = ctx.width - ctx.margin - 200;
    for (const [label, value] of metaRows) {
        ctx.page.drawText(label, { x: metaX, y: rightY, size: 9, font: ctx.fontBold, color: COLORS.darkGray });
        ctx.page.drawText(value, { x: metaX + 85, y: rightY, size: 9, font: ctx.fontReg, color: COLORS.black });
        rightY -= 16;
    }

    ctx.y = Math.min(leftY, rightY) - 15;
}

function drawLineItemsTable(ctx: RenderContext, items: { desc: string, qty: string, unit: string, total: string }[]) {
    const colX = { desc: ctx.margin, qty: ctx.margin + 280, unit: ctx.margin + 340, total: ctx.width - ctx.margin - 70 };

    ctx.page.drawRectangle({
        x: ctx.margin - 5, y: ctx.y - 4, width: ctx.width - 2 * ctx.margin + 10, height: 20, color: COLORS.lightGray,
    });
    ctx.page.drawText('Description', { x: colX.desc, y: ctx.y, size: 9, font: ctx.fontBold, color: COLORS.darkGray });
    ctx.page.drawText('Qty', { x: colX.qty, y: ctx.y, size: 9, font: ctx.fontBold, color: COLORS.darkGray });
    ctx.page.drawText('Unit Price', { x: colX.unit, y: ctx.y, size: 9, font: ctx.fontBold, color: COLORS.darkGray });
    ctx.page.drawText('Total', { x: colX.total, y: ctx.y, size: 9, font: ctx.fontBold, color: COLORS.darkGray });
    ctx.y -= 22;

    for (const item of items) {
        ctx.page.drawText(item.desc, { x: colX.desc, y: ctx.y, size: 9, font: ctx.fontReg, color: COLORS.black });
        ctx.page.drawText(item.qty, { x: colX.qty, y: ctx.y, size: 9, font: ctx.fontReg, color: COLORS.black });
        ctx.page.drawText(item.unit, { x: colX.unit, y: ctx.y, size: 9, font: ctx.fontReg, color: COLORS.black });
        ctx.page.drawText(item.total, { x: colX.total, y: ctx.y, size: 9, font: ctx.fontReg, color: COLORS.black });
        ctx.y -= 18;
        if (ctx.y < 120) break; // Simple page limit handling
    }
}

function drawTotals(ctx: RenderContext, subRows: [string, string][], grandTotal: string) {
    ctx.y -= 10;
    const totalsX = ctx.margin + 330;
    const totalsValX = ctx.width - ctx.margin - 70;

    ctx.page.drawLine({
        start: { x: totalsX, y: ctx.y + 8 }, end: { x: ctx.width - ctx.margin + 5, y: ctx.y + 8 },
        thickness: 0.5, color: COLORS.lightGray,
    });

    for (const [label, val] of subRows) {
        ctx.page.drawText(label, { x: totalsX, y: ctx.y, size: 9, font: ctx.fontReg, color: COLORS.darkGray });
        ctx.page.drawText(val, { x: totalsValX, y: ctx.y, size: 9, font: ctx.fontReg, color: COLORS.black });
        ctx.y -= 16;
    }

    ctx.y -= 8;
    ctx.page.drawLine({
        start: { x: totalsX, y: ctx.y + 14 }, end: { x: ctx.width - ctx.margin + 5, y: ctx.y + 14 },
        thickness: 1, color: COLORS.headerBg,
    });
    ctx.page.drawText('TOTAL:', { x: totalsX, y: ctx.y, size: 12, font: ctx.fontBold, color: COLORS.headerBg });
    ctx.page.drawText(grandTotal, {
        x: totalsValX, y: ctx.y, size: 12, font: ctx.fontBold, color: COLORS.headerBg,
    });
}

function drawNotes(ctx: RenderContext, notes: string) {
    if (!notes) return;
    ctx.y -= 35;
    ctx.page.drawText('Notes:', { x: ctx.margin, y: ctx.y, size: 9, font: ctx.fontBold, color: COLORS.darkGray });
    ctx.y -= 14;
    ctx.page.drawText(truncate(notes, 100), { x: ctx.margin, y: ctx.y, size: 9, font: ctx.fontReg, color: COLORS.medGray });
}

function drawFooter(ctx: RenderContext, leftText: string, rightText: string) {
    const footerY = 35;
    ctx.page.drawLine({
        start: { x: ctx.margin, y: footerY + 12 }, end: { x: ctx.width - ctx.margin, y: footerY + 12 },
        thickness: 0.5, color: COLORS.lightGray,
    });
    ctx.page.drawText(leftText, { x: ctx.margin, y: footerY, size: 7, font: ctx.fontReg, color: COLORS.medGray });
    ctx.page.drawText(rightText, {
        x: ctx.width - ctx.margin - ctx.fontReg.widthOfTextAtSize(rightText, 7),
        y: footerY, size: 7, font: ctx.fontReg, color: COLORS.medGray,
    });
}

// --- Specific Document Generators ---

/**
 * Generates a clean, professional PDF invoice from structured invoice data.
 *
 * The PDF is vendor-branded (uses vendor name as header) with a subtle footer
 * noting it was internally generated from email correspondence.
 *
 * DECISION(2026-03-12): PDF is styled as a vendor invoice document, not a
 * BuildASoil internal document. This is intentional — Bill.com parses vendor
 * invoices, so the format must match their expectations. A small footer
 * distinguishes it from original vendor-issued documents.
 *
 * @param   invoice  - Structured invoice data (from LLM extraction)
 * @param   sourceEmailDate - Optional date of the source email
 * @returns PDF buffer ready for email attachment
 */
export async function generateInvoicePDF(invoice: InvoiceData, sourceEmailDate?: string): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]); // US Letter
    const { width, height } = page.getSize();
    
    // We create the rendering context to pass down our components
    const ctx: RenderContext = {
        page,
        fontReg: await doc.embedFont(StandardFonts.Helvetica),
        fontBold: await doc.embedFont(StandardFonts.HelveticaBold),
        margin: 50,
        width, height,
        y: height - 50
    };

    // 1. Header
    drawHeaderBar(ctx, invoice.vendorName || 'Vendor Invoice', 'INVOICE');

    // 2. Metadata & Addresses
    const invoiceNumber = invoice.invoiceNumber !== 'UNKNOWN'
        ? invoice.invoiceNumber
        : generateSyntheticId('IG', invoice.poNumber || null, invoice.invoiceDate);

    const metaRows: [string, string][] = [
        ['Invoice #:', invoiceNumber || ''],
        ['Date:', invoice.invoiceDate || new Date().toISOString().split('T')[0]],
    ];
    if (invoice.poNumber) metaRows.push(['PO Reference:', `#${invoice.poNumber}`]);
    if (invoice.paymentTerms) metaRows.push(['Terms:', invoice.paymentTerms]);

    const billTo = [
        'BuildASoil',
        '1455 Branding Iron Dr',
        'Montrose, CO 81401'
    ];
    drawMetadataSection(ctx, billTo, metaRows);

    // 3. Line Items
    ctx.y -= 15;
    const tableItems = invoice.lineItems.map(item => ({
        desc: truncate(item.description || item.sku || 'Item', 45),
        qty: String(item.qty),
        unit: fmtCurrency(item.unitPrice),
        total: fmtCurrency(item.total || item.qty * item.unitPrice)
    }));
    drawLineItemsTable(ctx, tableItems);

    // 4. Totals
    const subRows: [string, string][] = [];
    if (invoice.subtotal > 0) subRows.push(['Subtotal:', fmtCurrency(invoice.subtotal)]);
    if (invoice.freight) subRows.push(['Freight/Shipping:', fmtCurrency(invoice.freight)]);
    if (invoice.tax) subRows.push(['Tax:', fmtCurrency(invoice.tax)]);
    if (invoice.fuelSurcharge) subRows.push(['Fuel Surcharge:', fmtCurrency(invoice.fuelSurcharge)]);
    
    drawTotals(ctx, subRows, fmtCurrency(invoice.total || invoice.amountDue));

    // 5. Notes
    if (invoice.notes) drawNotes(ctx, invoice.notes);

    // 6. Footer
    const genDate = sourceEmailDate || new Date().toISOString().split('T')[0];
    drawFooter(
        ctx, 
        'Created from email correspondence \u2014 Internally generated document', 
        `Generated ${genDate}`
    );

    const pdfBytes = await doc.save();
    return Buffer.from(pdfBytes);
}

// --- Utilities ---

/** Generate a synthetic document number. Format: {PREFIX}-YYYY-MMDD-<PO#> */
function generateSyntheticId(prefix: string, referenceNum: string | null, stringDate?: string): string {
    const d = stringDate || new Date().toISOString().split('T')[0];
    const parts = d.split('-');
    const datePart = parts.length >= 3 ? `${parts[0]}-${parts[1]}${parts[2]}` : d.replace(/-/g, '');
    const ref = referenceNum || Math.random().toString(36).slice(2, 8).toUpperCase();
    return `${prefix}-${datePart}-${ref}`;
}

function fmtCurrency(n: number): string {
    return `$${n.toFixed(2)}`;
}

function truncate(s: string, maxLen: number): string {
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '\u2026' : s;
}
