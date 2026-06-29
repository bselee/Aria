/**
 * @file    po-email-pdf.ts
 * @purpose Renders a Finale-native-style PDF purchase order. Used as the
 *          Gmail fallback when Finale's native email send is unavailable.
 *          Layout closely matches the Finale-generated PO PDF.
 * @author  Hermia
 * @created 2026-05-28
 * @updated 2026-06-05 — matched Finale native PO format
 * @deps    pdfkit, finale/client (DraftPOReview)
 */

import PDFDocument from "pdfkit";
import type { DraftPOReview } from "../finale/client";

// ── BuildASoil constants ────────────────────────────────────────────────────
const BAS_ADDRESS = "5146 N. Townsend Ave";
const BAS_CITY = "Montrose, CO 81401 USA";
const BAS_PHONE = "855-877-7645";

// ── Helpers ─────────────────────────────────────────────────────────────────

function money(value: number): string {
    return `$${Number.isFinite(value) ? value.toFixed(2) : "0.00"}`;
}

function fmtDate(value: string): string {
    // Accepts "2026-06-25", "2026-06-25T...", ISO, or raw string. Never returns "undefined".
    if (!value) return "";
    let date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        // fallback parse YYYY-MM-DD prefix
        const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${parseInt(m[2],10)}/${parseInt(m[3],10)}/${m[1]}`;
        return value;
    }
    return date.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

function fmtQty(value: number): string {
    // Preserve trailing zeros for integers, show decimals for fractions
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// ── Layout constants ────────────────────────────────────────────────────────
const MARGIN = 42;
const PAGE_W = 612; // LETTER width
const INNER_W = PAGE_W - MARGIN * 2; // 528

// Column positions (x-coordinates)
const COL = {
    PRODUCT_ID: 50,
    SUPPLIER_ID: 120,
    DESCR: 190,
    PACKING: 340,
    QTY: 390,
    UNIT: 450,
    SUBTOTAL: 510,
} as const;

const COL_WIDTH = {
    PRODUCT_ID: 68,
    SUPPLIER_ID: 68,
    DESCR: 148,
    PACKING: 48,
    QTY: 58,
    UNIT: 58,
    SUBTOTAL: 58,
} as const;

const COL_RIGHT = {
    PRODUCT_ID: COL.PRODUCT_ID + COL_WIDTH.PRODUCT_ID,
    SUPPLIER_ID: COL.SUPPLIER_ID + COL_WIDTH.SUPPLIER_ID,
    DESCR: COL.DESCR + COL_WIDTH.DESCR,
    PACKING: COL.PACKING + COL_WIDTH.PACKING,
    QTY: COL.QTY + COL_WIDTH.QTY,
    UNIT: COL.UNIT + COL_WIDTH.UNIT,
    SUBTOTAL: COL.SUBTOTAL + COL_WIDTH.SUBTOTAL,
} as const;

// ── Render ──────────────────────────────────────────────────────────────────

export async function renderPurchaseOrderPdf(review: DraftPOReview): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
        const chunks: Buffer[] = [];
        doc.on("data", chunk => chunks.push(Buffer.from(chunk)));
        doc.on("error", reject);
        doc.on("end", () => resolve(Buffer.concat(chunks)));

        // ═══════════════════════════════════════════════════════════════════
        // HEADER
        // ═══════════════════════════════════════════════════════════════════
        doc.font("Helvetica-Bold").fontSize(20).fillColor("#000")
            .text("PURCHASE ORDER", MARGIN, MARGIN);

        doc.font("Helvetica").fontSize(9).fillColor("#333")
            .text(BAS_CITY, MARGIN, MARGIN + 24)
            .text(`Phone: ${BAS_PHONE}`, MARGIN, MARGIN + 36);

        // PO details — right-aligned block
        const poNumY = MARGIN + 24;
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#000")
            .text(`PO NUMBER: ${review.orderId}`, INNER_W + MARGIN - 170, poNumY, { width: 170, align: "right" });
        doc.font("Helvetica").fontSize(10).fillColor("#333")
            .text(`ORDER DATE: ${fmtDate(review.orderDate)}`, INNER_W + MARGIN - 170, poNumY + 16, { width: 170, align: "right" });

        // ═══════════════════════════════════════════════════════════════════
        // ADDRESSES
        // ═══════════════════════════════════════════════════════════════════
        const addrY = MARGIN + 72;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#000")
            .text("REQUESTED SHIPPING:", MARGIN, addrY);

        // Divider line
        doc.moveTo(MARGIN, addrY + 14).lineTo(MARGIN + INNER_W, addrY + 14)
            .strokeColor("#cccccc").lineWidth(0.5).stroke();

        const colY = addrY + 24;

        // Left column: Supplier
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#000")
            .text("Supplier", MARGIN, colY);
        doc.font("Helvetica").fontSize(10).fillColor("#111")
            .text(review.vendorName, MARGIN, colY + 14);

        // Right column: Ship to
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#000")
            .text("Ship to", PAGE_W / 2 + 10, colY);
        doc.font("Helvetica").fontSize(10).fillColor("#111")
            .text("BuildASoil", PAGE_W / 2 + 10, colY + 14)
            .text(BAS_ADDRESS, PAGE_W / 2 + 10, colY + 28)
            .text(BAS_CITY, PAGE_W / 2 + 10, colY + 42);

        // ═══════════════════════════════════════════════════════════════════
        // LINE ITEMS TABLE
        // ═══════════════════════════════════════════════════════════════════
        const tableTop = colY + 70;

        // Table header background
        doc.rect(MARGIN, tableTop - 14, INNER_W, 20).fill("#e8ecf0");

        // Header labels
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#222");
        doc.text("Product ID", COL.PRODUCT_ID, tableTop - 10, { width: COL_WIDTH.PRODUCT_ID });
        doc.text("Supplier's ID", COL.SUPPLIER_ID, tableTop - 10, { width: COL_WIDTH.SUPPLIER_ID });
        doc.text("Description", COL.DESCR, tableTop - 10, { width: COL_WIDTH.DESCR });
        doc.text("Packing", COL.PACKING, tableTop - 10, { width: COL_WIDTH.PACKING, align: "right" });
        doc.text("Quantity", COL.QTY, tableTop - 10, { width: COL_WIDTH.QTY, align: "right" });
        doc.text("Unit price", COL.UNIT, tableTop - 10, { width: COL_WIDTH.UNIT, align: "right" });
        doc.text("Sub-total", COL.SUBTOTAL, tableTop - 10, { width: COL_WIDTH.SUBTOTAL, align: "right" });

        // Item rows
        let y = tableTop + 16;
        doc.font("Helvetica").fontSize(8.5).fillColor("#111");
        for (const item of review.items) {
            if (y > 700) {
                doc.addPage();
                y = MARGIN;
            }

            const rowH = Math.max(18, doc.heightOfString(item.productName, { width: COL_WIDTH.DESCR }) + 6);

            doc.text(item.productId, COL.PRODUCT_ID, y, { width: COL_WIDTH.PRODUCT_ID });
            doc.text(item.supplierSku ?? "", COL.SUPPLIER_ID, y, { width: COL_WIDTH.SUPPLIER_ID });
            doc.text(item.productName, COL.DESCR, y, { width: COL_WIDTH.DESCR });
            doc.text(item.packing ?? "", COL.PACKING, y, { width: COL_WIDTH.PACKING, align: "right" });
            doc.text(fmtQty(item.quantity), COL.QTY, y, { width: COL_WIDTH.QTY, align: "right" });
            doc.text(money(item.unitPrice), COL.UNIT, y, { width: COL_WIDTH.UNIT, align: "right" });
            doc.text(money(item.lineTotal), COL.SUBTOTAL, y, { width: COL_WIDTH.SUBTOTAL, align: "right" });

            y += rowH;
            doc.moveTo(MARGIN, y).lineTo(MARGIN + INNER_W, y)
                .strokeColor("#e0e0e0").lineWidth(0.5).stroke();
        }

        // ═══════════════════════════════════════════════════════════════════
        // TOTAL
        // ═══════════════════════════════════════════════════════════════════
        y += 12;
        doc.font("Helvetica-Bold").fontSize(12).fillColor("#000")
            .text(`Total: ${money(review.total)}`, COL.SUBTOTAL - 40, y, { width: 98, align: "right" });

        // ═══════════════════════════════════════════════════════════════════
        // FOOTER
        // ═══════════════════════════════════════════════════════════════════
        doc.font("Helvetica").fontSize(8).fillColor("#777")
            .text("Please acknowledge receipt and reply with ETA in this email thread.",
                MARGIN, 735, { width: INNER_W, align: "center" });

        doc.end();
    });
}
