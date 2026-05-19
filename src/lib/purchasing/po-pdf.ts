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

export function renderPurchaseOrderPDF(
    review: DraftPOReview,
    opts: RenderPOOptions = {},
): Promise<Buffer> {
    const o = { ...DEFAULTS, ...opts };

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "LETTER", margin: 54 });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        // Header
        doc.fontSize(18).font("Helvetica-Bold").text(o.companyName);
        doc.fontSize(9).font("Helvetica").text(o.companyAddress);
        doc.moveDown(0.5);
        doc.fontSize(9).text(`Contact: ${o.contactName}  ·  ${o.contactEmail}${o.contactPhone ? `  ·  ${o.contactPhone}` : ""}`);

        // PO title
        doc.moveDown(1);
        doc.fontSize(16).font("Helvetica-Bold").text(`Purchase Order #${review.orderId}`);
        doc.moveDown(0.25);
        doc.fontSize(10).font("Helvetica")
            .text(`Vendor: ${review.vendorName}`)
            .text(`Order Date: ${review.orderDate}`);

        // Items table
        doc.moveDown(1);
        const tableTop = doc.y;
        const colX = { sku: 54, name: 130, qty: 380, price: 440, line: 510 };
        doc.fontSize(10).font("Helvetica-Bold");
        doc.text("SKU", colX.sku, tableTop);
        doc.text("Description", colX.name, tableTop);
        doc.text("Qty", colX.qty, tableTop, { width: 50, align: "right" });
        doc.text("Unit $", colX.price, tableTop, { width: 60, align: "right" });
        doc.text("Line $", colX.line, tableTop, { width: 60, align: "right" });
        doc.moveTo(colX.sku, tableTop + 14).lineTo(570, tableTop + 14).stroke();

        doc.font("Helvetica").fontSize(9);
        let y = tableTop + 20;
        for (const item of review.items) {
            if (y > 720) {
                doc.addPage();
                y = 54;
            }
            doc.text(String(item.productId).slice(0, 14), colX.sku, y, { width: 70 });
            doc.text(item.productName, colX.name, y, { width: 240 });
            doc.text(item.quantity.toString(), colX.qty, y, { width: 50, align: "right" });
            doc.text(`$${item.unitPrice.toFixed(2)}`, colX.price, y, { width: 60, align: "right" });
            doc.text(`$${item.lineTotal.toFixed(2)}`, colX.line, y, { width: 60, align: "right" });
            const rowHeight = Math.max(
                14,
                doc.heightOfString(item.productName, { width: 240 }) + 4,
            );
            y += rowHeight;
        }

        // Total
        doc.moveTo(colX.qty, y + 6).lineTo(570, y + 6).stroke();
        doc.fontSize(11).font("Helvetica-Bold");
        doc.text("Total", colX.price, y + 14, { width: 60, align: "right" });
        doc.text(`$${review.total.toFixed(2)}`, colX.line, y + 14, { width: 60, align: "right" });

        // Footer
        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text(
            `Reference: ${review.finaleUrl}`,
            54,
            760,
            { width: 500, align: "left" },
        );

        doc.end();
    });
}
