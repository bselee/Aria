/**
 * @file    po-email-pdf.ts
 * @purpose Renders a Finale-native-style PDF purchase order. Used as the
 *          Gmail fallback when Finale's native email send is unavailable.
 *          Layout closely matches the Finale-generated PO PDF.
 * @author  Hermia
 * @created 2026-05-28
 * @updated 2026-06-05 — matched Finale native PO format
 * @updated 2026-09-21 — matched Finale native PO exactly: company block left,
 *          grey PURCHASE ORDER heading right, supplier postal address,
 *          Supplier's ID falls back to the product id, and amounts render
 *          Finale-style (2,700.00 — thousands separator, no "$").
 * @deps    pdfkit, finale/client (DraftPOReview)
 */

import PDFDocument from "pdfkit";
import type { DraftPOReview } from "../finale/client";

// ── BuildASoil constants ────────────────────────────────────────────────────
const BAS_ADDRESS = "5146 N. Townsend Ave";
const BAS_CITY = "Montrose, CO 81401 USA";
const BAS_PHONE = "855-877-7645";
const BAS_TOLL_FREE = "855-877-SOIL";
const BAS_TAGLINE = "The #1 Choice For Custom Organic Fertilizer";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Format a currency amount the way Finale's native PO PDF does: thousands
 * separators, two decimals, no currency symbol (2,700.00 / 1,008.00).
 *
 * DECISION(2026-09-21, Bill): the Aria fallback PDF must be indistinguishable
 * from the document Finale prints, and Finale omits the "$".
 *
 * @param value - Amount to render.
 * @returns Formatted amount, or "0.00" for non-finite input.
 */
function money(value: number): string {
    return Number.isFinite(value)
        ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : "0.00";
}

/**
 * Render a PO date the way Finale does (M/D/YYYY).
 *
 * DECISION(2026-09-21): a bare "YYYY-MM-DD" is parsed by `new Date()` as UTC
 * midnight, which renders as the PREVIOUS day in Denver (9/21 → 9/20). Date-only
 * values are now formatted directly from their parts; only real timestamps go
 * through `Date`.
 *
 * @param value - ISO date, ISO timestamp, or already-formatted string.
 * @returns M/D/YYYY, or the input unchanged when it cannot be parsed. Never "undefined".
 */
function fmtDate(value: string): string {
    if (!value) return "";
    const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateOnly) {
        return `${parseInt(dateOnly[2], 10)}/${parseInt(dateOnly[3], 10)}/${dateOnly[1]}`;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
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
        // HEADER — matches Finale's native PO: company block left,
        // grey "PURCHASE ORDER" heading right.
        // ═══════════════════════════════════════════════════════════════════
        doc.font("Helvetica-Bold").fontSize(14).fillColor("#000")
            .text("BUILD A SOIL.COM", MARGIN, MARGIN);
        doc.font("Helvetica").fontSize(8).fillColor("#444")
            .text(BAS_TAGLINE, MARGIN, MARGIN + 16)
            .text(BAS_TOLL_FREE, MARGIN, MARGIN + 27)
            .text(BAS_CITY, MARGIN, MARGIN + 38)
            .text(`Phone: ${BAS_PHONE}`, MARGIN, MARGIN + 49);

        doc.font("Helvetica-Bold").fontSize(18).fillColor("#888")
            .text("PURCHASE ORDER", INNER_W + MARGIN - 190, MARGIN, { width: 190, align: "right" });

        // PO details — right-aligned block under the heading
        const poNumY = MARGIN + 30;
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#000")
            .text(`PO NUMBER: ${review.orderId}`, INNER_W + MARGIN - 190, poNumY, { width: 190, align: "right" });
        doc.font("Helvetica").fontSize(10).fillColor("#333")
            .text(`ORDER DATE: ${fmtDate(review.orderDate)}`, INNER_W + MARGIN - 190, poNumY + 14, { width: 190, align: "right" });

        // ═══════════════════════════════════════════════════════════════════
        // ADDRESSES
        // ═══════════════════════════════════════════════════════════════════
        const addrY = MARGIN + 78;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#000")
            .text("REQUESTED SHIPPING:", MARGIN, addrY);

        // Divider line
        doc.moveTo(MARGIN, addrY + 14).lineTo(MARGIN + INNER_W, addrY + 14)
            .strokeColor("#cccccc").lineWidth(0.5).stroke();

        const colY = addrY + 24;

        // Left column: Supplier (name + postal address, Finale includes it)
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#000")
            .text("Supplier", MARGIN, colY);
        let supplierY = colY + 14;
        doc.font("Helvetica").fontSize(10).fillColor("#111")
            .text(review.vendorName, MARGIN, supplierY);
        supplierY += 14;
        for (const line of review.vendorAddress ?? []) {
            doc.text(line, MARGIN, supplierY);
            supplierY += 14;
        }

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
        const tableTop = Math.max(supplierY, colY + 42) + 28;

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
            // Finale prints the product's own id in "Supplier's ID" when no
            // vendor-specific part number is recorded — mirror that so the
            // column is never mysteriously blank (Bill, 2026-09-21).
            doc.text(item.supplierSku ?? item.productId, COL.SUPPLIER_ID, y, { width: COL_WIDTH.SUPPLIER_ID });
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

        doc.end();
    });
}
