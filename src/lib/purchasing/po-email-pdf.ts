import PDFDocument from "pdfkit";
import type { DraftPOReview } from "../finale/client";

function money(value: number): string {
    return `$${Number.isFinite(value) ? value.toFixed(2) : "0.00"}`;
}

function shortDate(value: string): string {
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

export async function renderPurchaseOrderPdf(review: DraftPOReview): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "LETTER", margin: 42 });
        const chunks: Buffer[] = [];
        doc.on("data", chunk => chunks.push(Buffer.from(chunk)));
        doc.on("error", reject);
        doc.on("end", () => resolve(Buffer.concat(chunks)));

        doc.font("Helvetica-Bold").fontSize(18).text("BuildASoil", 42, 42);
        doc.font("Helvetica").fontSize(9).fillColor("#555")
            .text("Purchase Order", 42, 64)
            .text("buildasoil.com", 42, 78);

        doc.fillColor("#111").font("Helvetica-Bold").fontSize(16)
            .text(`PO #${review.orderId}`, 360, 42, { align: "right" });
        doc.font("Helvetica").fontSize(10)
            .text(`Date: ${shortDate(review.orderDate)}`, 360, 64, { align: "right" })
            .text(`Total: ${money(review.total)}`, 360, 80, { align: "right" });

        doc.moveTo(42, 110).lineTo(570, 110).strokeColor("#dddddd").stroke();

        doc.fillColor("#111").font("Helvetica-Bold").fontSize(10).text("Supplier", 42, 128);
        doc.font("Helvetica").fontSize(11).text(review.vendorName, 42, 144);

        doc.font("Helvetica-Bold").fontSize(10).text("Reference", 360, 128);
        doc.font("Helvetica").fontSize(9)
            .text(`Finale: ${review.finaleUrl}`, 360, 144, { width: 210 });

        const top = 200;
        doc.rect(42, top - 16, 528, 22).fill("#f1f5f9");
        doc.fillColor("#111").font("Helvetica-Bold").fontSize(9);
        doc.text("SKU", 50, top - 9, { width: 90 });
        doc.text("Description", 142, top - 9, { width: 220 });
        doc.text("Qty", 370, top - 9, { width: 50, align: "right" });
        doc.text("Unit", 430, top - 9, { width: 60, align: "right" });
        doc.text("Line", 502, top - 9, { width: 60, align: "right" });

        let y = top + 18;
        doc.font("Helvetica").fontSize(9).fillColor("#111");
        for (const item of review.items) {
            if (y > 720) {
                doc.addPage();
                y = 64;
            }
            doc.text(item.productId, 50, y, { width: 90 });
            doc.text(item.productName, 142, y, { width: 220 });
            doc.text(String(item.quantity), 370, y, { width: 50, align: "right" });
            doc.text(money(item.unitPrice), 430, y, { width: 60, align: "right" });
            doc.text(money(item.lineTotal), 502, y, { width: 60, align: "right" });
            y += Math.max(20, doc.heightOfString(item.productName, { width: 220 }) + 8);
            doc.moveTo(42, y - 5).lineTo(570, y - 5).strokeColor("#eeeeee").stroke();
        }

        y += 12;
        doc.font("Helvetica-Bold").fontSize(12)
            .text(`Total ${money(review.total)}`, 390, y, { width: 172, align: "right" });

        doc.font("Helvetica").fontSize(9).fillColor("#555")
            .text("Please acknowledge receipt and reply with ETA in this email thread.", 42, 742, {
                width: 528,
                align: "center",
            });

        doc.end();
    });
}
