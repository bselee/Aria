/**
 * @file    po-pdf.ts
 * @purpose Render a BuildASoil purchase order to a PDF buffer using pdfkit.
 *          Used by the Gmail fallback path when Finale's native PO email action
 *          is unavailable (Finale does not expose any email/PDF action URL on
 *          the order REST object — confirmed 2026-05-19 on PO #124832).
 */

import PDFDocument from "pdfkit";
import type { DraftPOReview } from "../finale/client";

export interface RenderPOOptions {
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string;
    companyName?: string;
    companyAddress?: string;
}

const DEFAULTS: Required<RenderPOOptions> = {
    contactName: "Bill Selee",
    contactEmail: "bill.selee@buildasoil.com",
    contactPhone: "",
    companyName: "BuildASoil",
    companyAddress: "BuildASoil Organics LLC",
};

const COL_X = { sku: 54, name: 130, qty: 380, price: 440, line: 510 } as const;
const TABLE_RIGHT = 570;
const PAGE_BOTTOM = 720;

/**
 * pdfkit's built-in Helvetica is WinAnsi (Latin-1) only. Vendor names like
 * "Café Patrón" need to be normalized to NFKD + stripped of combining marks
 * before they print, otherwise pdfkit silently emits replacement chars and
 * the vendor sees garbled text. Anything still outside Latin-1 (CJK, Arabic,
 * Cyrillic, etc.) is replaced with '?' rather than crashing the render.
 */
function sanitizeForPDF(input: string | null | undefined): string {
    if (input == null) return "";
    let s = String(input).normalize("NFKD");
    // strip diacritical combining marks (so "café" → "cafe")
    s = s.replace(/[̀-ͯ]/g, "");
    // replace anything still outside Latin-1 with '?' (won't crash, won't lie)
    s = s.replace(/[^\x00-\xFF]/g, "?");
    return s;
}

export function renderPurchaseOrderPDF(
    review: DraftPOReview,
    opts: RenderPOOptions = {},
): Promise<Buffer> {
    if (!Array.isArray(review.items) || review.items.length === 0) {
        return Promise.reject(
            new Error(`Cannot render PO #${review.orderId}: 0 line items — refuse to ship empty PO`),
        );
    }

    const o = { ...DEFAULTS, ...opts };

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "LETTER", margin: 54, bufferPages: true });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const drawHeader = (isFirstPage: boolean) => {
            const startY = isFirstPage ? doc.y : 54;
            doc.fontSize(18).font("Helvetica-Bold").text(sanitizeForPDF(o.companyName), 54, startY);
            doc.fontSize(9).font("Helvetica").text(sanitizeForPDF(o.companyAddress));
            doc.moveDown(0.5);
            doc.fontSize(9).text(
                sanitizeForPDF(`Contact: ${o.contactName}  ·  ${o.contactEmail}${o.contactPhone ? `  ·  ${o.contactPhone}` : ""}`),
            );

            doc.moveDown(1);
            doc.fontSize(16).font("Helvetica-Bold")
                .text(sanitizeForPDF(`Purchase Order #${review.orderId}`), { width: 500 });
            doc.moveDown(0.25);
            doc.fontSize(10).font("Helvetica")
                .text(sanitizeForPDF(`Vendor: ${review.vendorName}`), { width: 500 })
                .text(sanitizeForPDF(`Order Date: ${review.orderDate}`));
            if (!isFirstPage) {
                doc.fontSize(8).fillColor("#888888").text("(continued)", { width: 500 });
                doc.fillColor("#000000");
            }

            doc.moveDown(1);
            const headerY = doc.y;
            doc.fontSize(10).font("Helvetica-Bold");
            doc.text("SKU", COL_X.sku, headerY);
            doc.text("Description", COL_X.name, headerY);
            doc.text("Qty", COL_X.qty, headerY, { width: 50, align: "right" });
            doc.text("Unit $", COL_X.price, headerY, { width: 60, align: "right" });
            doc.text("Line $", COL_X.line, headerY, { width: 60, align: "right" });
            doc.moveTo(COL_X.sku, headerY + 14).lineTo(TABLE_RIGHT, headerY + 14).stroke();
            doc.font("Helvetica").fontSize(9);
            return headerY + 20;
        };

        // Draw header for the FIRST page eagerly. Subsequent pages are added
        // explicitly inside the loop below so we can redraw the table header.
        let y = drawHeader(true);

        for (const item of review.items) {
            // Estimate row height so we don't half-render a wrapped row across
            // the page break. Worst case is the description wrapping in 240px.
            const sku = sanitizeForPDF(item.productId).slice(0, 14);
            const name = sanitizeForPDF(item.productName);
            const rowHeight = Math.max(14, doc.heightOfString(name, { width: 240 }) + 4);

            if (y + rowHeight > PAGE_BOTTOM) {
                doc.addPage();
                y = drawHeader(false);
            }

            doc.text(sku, COL_X.sku, y, { width: 70 });
            doc.text(name, COL_X.name, y, { width: 240 });
            doc.text(item.quantity.toString(), COL_X.qty, y, { width: 50, align: "right" });
            doc.text(`$${item.unitPrice.toFixed(2)}`, COL_X.price, y, { width: 60, align: "right" });
            doc.text(`$${item.lineTotal.toFixed(2)}`, COL_X.line, y, { width: 60, align: "right" });
            y += rowHeight;
        }

        // Total — keep on the same page as the closing rule if possible
        if (y + 28 > PAGE_BOTTOM) {
            doc.addPage();
            y = drawHeader(false);
        }
        doc.moveTo(COL_X.qty, y + 6).lineTo(TABLE_RIGHT, y + 6).stroke();
        doc.fontSize(11).font("Helvetica-Bold");
        doc.text("Total", COL_X.price, y + 14, { width: 60, align: "right" });
        doc.text(`$${review.total.toFixed(2)}`, COL_X.line, y + 14, { width: 60, align: "right" });

        // Footer — fixed position on whatever the current last page is
        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text(
            sanitizeForPDF(`Reference: ${review.finaleUrl}`),
            54,
            760,
            { width: 500, align: "left" },
        );

        doc.end();
    });
}

// Exported for unit tests that want to verify sanitization without going
// through the full pdfkit render.
export const _sanitizeForPDF = sanitizeForPDF;
