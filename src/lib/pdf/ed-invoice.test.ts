/**
 * @file    ed-invoice.test.ts
 * @purpose Unit tests for Organic AG (Ed) B&W invoice spec + HTML.
 * @author  Hermia
 * @created 2026-08-25
 */
import { describe, expect, it } from "vitest";
import {
    buildEdInvoiceHtml,
    buildEdInvoiceSpec,
    formatUsd,
    normalizeUpsTracking,
    parseCasualDate,
} from "./ed-invoice";

describe("normalizeUpsTracking", () => {
    it("compacts spaced UPS numbers", () => {
        expect(normalizeUpsTracking("1zj2y 725-03 0490-6559")).toBe("1ZJ2Y7250304906559");
    });

    it("returns null for empty", () => {
        expect(normalizeUpsTracking("")).toBeNull();
        expect(normalizeUpsTracking(null)).toBeNull();
    });
});

describe("parseCasualDate", () => {
    it("parses 8-24-26 as 2026-08-24", () => {
        expect(parseCasualDate("8-24-26")).toBe("2026-08-24");
    });

    it("parses ISO unchanged", () => {
        expect(parseCasualDate("2026-08-24")).toBe("2026-08-24");
    });
});

describe("buildEdInvoiceSpec", () => {
    const base = {
        poNumber: "125230",
        orderDate: "2026-08-24T00:00:00",
        items: [{ productId: "PPD101", quantity: 50, unitPrice: 19, description: "" }],
        freight: 72.62,
        tracking: "1zj2y 725-03 0490-6559",
        shipped: "8-24-26",
    };

    it("sets invoice number equal to PO", () => {
        const spec = buildEdInvoiceSpec(base);
        expect(spec.invoiceNumber).toBe("125230");
        expect(spec.poNumber).toBe("125230");
    });

    it("computes 50 x 19 + 72.62 = 1022.62", () => {
        const spec = buildEdInvoiceSpec(base);
        expect(spec.subtotal).toBe(950);
        expect(spec.freight).toBe(72.62);
        expect(spec.total).toBe(1022.62);
    });

    it("labels PPD101 when Finale description is blank", () => {
        const spec = buildEdInvoiceSpec(base);
        expect(spec.lines[0].description).toContain("15-1-1");
        expect(spec.lines[0].description).toContain("PPD101");
    });

    it("strips a leading hash from the PO", () => {
        const spec = buildEdInvoiceSpec({ ...base, poNumber: "#125230" });
        expect(spec.invoiceNumber).toBe("125230");
    });
});

describe("buildEdInvoiceHtml", () => {
    it("is black and white and uses PO as invoice number", () => {
        const spec = buildEdInvoiceSpec({
            poNumber: "125230",
            items: [{ productId: "PPD101", quantity: 50, unitPrice: 19 }],
            freight: 72.62,
            tracking: "1ZJ2Y7250304906559",
            shipped: "2026-08-24",
        });
        const html = buildEdInvoiceHtml(spec);
        expect(html).toContain("Invoice #");
        expect(html).toContain(">125230<");
        expect(html).not.toContain("IG-");
        expect(html).not.toContain("rgb(");
        expect(html).not.toContain("Internally generated");
        expect(html).toContain(formatUsd(1022.62));
        expect(html).toContain("1ZJ2Y7250304906559");
        const colors = html.match(/#[0-9a-fA-F]{3,8}/g) || [];
        const allowed = new Set(["#fff", "#000", "#222", "#ccc", "#ffffff", "#000000"]);
        expect(colors.every((c) => allowed.has(c.toLowerCase()))).toBe(true);
    });
});
