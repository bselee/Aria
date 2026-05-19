import { describe, expect, it } from "vitest";
import { _sanitizeForPDF as sanitizeForPDF, renderPurchaseOrderPDF } from "./po-pdf";
import type { DraftPOReview } from "../finale/client";

function makeReview(overrides: Partial<DraftPOReview> = {}): DraftPOReview {
    return {
        orderId: "124999",
        vendorName: "Compost Tea Lab",
        vendorPartyId: "10999",
        orderDate: "2026-05-19",
        total: 100,
        items: [
            { productId: "CTL-1", productName: "Brewer", quantity: 1, unitPrice: 100, lineTotal: 100 },
        ],
        finaleUrl: "https://finale.example/po/124999",
        canCommit: false,
        ...overrides,
    };
}

describe("sanitizeForPDF", () => {
    it("strips combining diacritics so Latin-1 vendor names render cleanly", () => {
        expect(sanitizeForPDF("Café Müller")).toBe("Cafe Muller");
        expect(sanitizeForPDF("Patrón Tequila")).toBe("Patron Tequila");
    });

    it("replaces non-Latin-1 chars with '?' instead of crashing pdfkit", () => {
        expect(sanitizeForPDF("北京 Vendor")).toBe("?? Vendor");
        expect(sanitizeForPDF("Привет")).toBe("??????");
    });

    it("passes ASCII through untouched", () => {
        expect(sanitizeForPDF("ULINE - 12oz Bottle")).toBe("ULINE - 12oz Bottle");
    });

    it("handles null/undefined safely", () => {
        expect(sanitizeForPDF(null)).toBe("");
        expect(sanitizeForPDF(undefined)).toBe("");
    });
});

describe("renderPurchaseOrderPDF", () => {
    it("refuses to render an empty PO", async () => {
        await expect(renderPurchaseOrderPDF(makeReview({ items: [] })))
            .rejects.toThrow(/0 line items/);
    });

    it("returns a non-trivial PDF for a normal PO", async () => {
        const buf = await renderPurchaseOrderPDF(makeReview());
        expect(buf.length).toBeGreaterThan(500);
        expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    });

    it("produces multi-page output when there are many rows (header should repeat)", async () => {
        const items = Array.from({ length: 60 }, (_, i) => ({
            productId: `SKU-${i}`,
            productName: `Item number ${i} with a fairly long description so the row height accumulates`,
            quantity: 1,
            unitPrice: 10,
            lineTotal: 10,
        }));
        const buf = await renderPurchaseOrderPDF(makeReview({ items, total: 600 }));
        // Count actual page markers in the PDF stream — pdfkit writes one
        // /Page object per page in the body.
        const text = buf.toString("latin1");
        const pageObjects = (text.match(/\/Type \/Page\b/g) ?? []).length;
        expect(pageObjects).toBeGreaterThan(1);
    });

    it("survives a unicode vendor name without throwing", async () => {
        const buf = await renderPurchaseOrderPDF(makeReview({ vendorName: "Café Müller's 北京 Supply Co." }));
        expect(buf.length).toBeGreaterThan(500);
    });
});
