/**
 * @file    invoice-description-match.test.ts
 * @purpose Unit tests for the description→SKU resolver and scorer
 *          (invoice-description-match.ts) — Miles bills by free-text
 *          description, and the SKU is the goods' identity.
 * @author  Hermia
 * @created 2026-11-04
 */
import { describe, it, expect } from "vitest";
import {
    isMilesVendorName,
    resolveMilesDescriptionToSku,
    skusFromInvoiceDescriptions,
    scoreDescriptionSkuCandidates,
    type DescriptionPoRow,
} from "./invoice-description-match";

describe("isMilesVendorName", () => {
    it("matches the sender and the OCR name", () => {
        expect(isMilesVendorName("Miles Filippelli")).toBe(true);
        expect(isMilesVendorName("Fermented Plant Extracts")).toBe(true);
    });
    it("does not match other vendors", () => {
        expect(isMilesVendorName("Uline")).toBe(false);
        expect(isMilesVendorName(null)).toBe(false);
    });
});

describe("resolveMilesDescriptionToSku", () => {
    it("resolves gallon vs half-gallon", () => {
        expect(resolveMilesDescriptionToSku("Comfrey Gallon")).toBe("BASLCE103");
        expect(resolveMilesDescriptionToSku("comfrey half gallon")).toBe("BASLCE102");
        expect(resolveMilesDescriptionToSku("Peach Half Gallon")).toBe("BASLPEE103");
        expect(resolveMilesDescriptionToSku("peach gallon")).toBe("BASLPEE102");
    });
    it("handles the OCR typo 'horsetaial'", () => {
        expect(resolveMilesDescriptionToSku("Horsetaial gallon")).toBe("HTF101");
    });
    it("resolves the single-SKU wetting agent", () => {
        expect(resolveMilesDescriptionToSku("Herbal Wetting Agent")).toBe("JWA101");
    });
    it("returns null for unknown descriptions", () => {
        expect(resolveMilesDescriptionToSku(null)).toBeNull();
        expect(resolveMilesDescriptionToSku("Something Else")).toBeNull();
    });
});

describe("skusFromInvoiceDescriptions", () => {
    it("dedupes resolved SKUs", () => {
        expect(
            skusFromInvoiceDescriptions([
                { description: "Comfrey Gallon" },
                { description: "Comfrey Gallon" },
                { description: "Peach half gallon" },
            ]),
        ).toEqual(["BASLCE103", "BASLPEE103"]);
    });
});

describe("scoreDescriptionSkuCandidates", () => {
    const openPeachPo: DescriptionPoRow = {
        po_number: "125465",
        vendor_name: "Miles Filippelli",
        issue_date: "2026-11-02",
        total_amount: 2600,
        status: "Committed",
        line_items: [
            { quantity: "100", productId: "BASLPEE103", unitPrice: 13, remainingQty: 100 },
            { quantity: "40", productId: "BASLHE105", unitPrice: 13, remainingQty: 40 },
            { quantity: "60", productId: "BASLCE102", unitPrice: 13, remainingQty: 60 },
        ],
    };
    const receivedPeachPo: DescriptionPoRow = {
        po_number: "125261",
        vendor_name: "Miles Filippelli",
        issue_date: "2026-09-02",
        total_amount: 1980,
        status: "received",
        line_items: [
            { quantity: "50", productId: "BASLPEE103", unitPrice: 13, remainingQty: 0 },
        ],
    };

    it("uniquely identifies the open PO for 'Peach Half Gallon'", () => {
        const hits = scoreDescriptionSkuCandidates(
            [{ description: "Peach Half Gallon", qty: 50 }],
            [openPeachPo, receivedPeachPo],
        );
        expect(hits).toHaveLength(1);
        expect(hits[0].poNumber).toBe("125465");
        expect(hits[0].matchedSkus).toEqual(["BASLPEE103"]);
        expect(hits[0].matchedAllLines).toBe(true);
    });

    it("does not credit a received PO whose remainingQty is absent (old PO)", () => {
        // 125039 shape: old received PO has `quantity` but no `remainingQty`.
        // The quantity fallback must NOT turn it into cover.
        const receivedComfreyPo: DescriptionPoRow = {
            po_number: "125039",
            vendor_name: "Miles Filippelli",
            issue_date: "2026-06-26",
            total_amount: 5330,
            status: "received",
            line_items: [
                { quantity: "80", productId: "BASLCE103", unitPrice: 24 },
            ],
        };
        const hits = scoreDescriptionSkuCandidates(
            [{ description: "Comfrey Gallon", qty: 24 }],
            [receivedComfreyPo],
        );
        expect(hits).toHaveLength(0);
    });

    it("does not credit a fully-received PO (remainingQty 0)", () => {
        const receivedComfreyPo: DescriptionPoRow = {
            po_number: "125408",
            vendor_name: "Miles Filippelli",
            issue_date: "2026-10-15",
            total_amount: 2090,
            status: "Committed",
            line_items: [
                { quantity: "50", productId: "BASLCE103", unitPrice: 24, remainingQty: 0 },
            ],
        };
        const hits = scoreDescriptionSkuCandidates(
            [{ description: "Comfrey Gallon", qty: 24 }],
            [receivedComfreyPo],
        );
        expect(hits).toHaveLength(0);
    });

    it("returns [] when no description resolves to a Miles SKU", () => {
        expect(
            scoreDescriptionSkuCandidates([{ description: "Not a product" }], [openPeachPo]),
        ).toEqual([]);
    });
});
