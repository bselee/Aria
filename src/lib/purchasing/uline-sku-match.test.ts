/**
 * @file    uline-sku-match.test.ts
 * @purpose Guard the exact-SKU fallback (WS3.3, 2026-10-29): a Uline invoice
 *          with no printable Finale PO is identified by the goods it bills,
 *          matched by EXACT productId equality against PO line items.
 *
 *          The trap this test exists for: Uline SKUs are prefixes of one
 *          another (`S-4738` vs `S-473824`). A substring rule would link the
 *          wrong PO and silently reconcile the wrong receipt.
 */
import { describe, it, expect } from "vitest";
import { scoreUlineSkuCandidates } from "./invoice-po-matcher";

const PO_125429 = {
    po_number: "125429",
    vendor_name: "ULINE",
    issue_date: "2026-10-22T00:00:00-06:00",
    total_amount: 2995.75,
    status: "Completed",
    line_items: [
        { productId: "S-4738", quantity: "1000", unitPrice: 2.43 },
        { productId: "S-17888", quantity: "14", unitPrice: 30.8 },
    ],
};

const PO_125410 = {
    po_number: "125410",
    vendor_name: "ULINE",
    issue_date: "2026-10-15T00:00:00-06:00",
    total_amount: 1978.92,
    status: "Completed",
    line_items: [
        { productId: "S-4128", quantity: "1500", unitPrice: 0.69 },
        { productId: "S-11443", quantity: "1500", unitPrice: 0.032 },
        { productId: "S-1667", quantity: "1500", unitPrice: 0.328 },
    ],
};

describe("scoreUlineSkuCandidates", () => {
    it("matches invoice 215047605 lines to PO 125429 on the exact S-17888 hit", () => {
        // Invoice 215047605 printed S-17888 and S-473824 — the latter is a
        // DIFFERENT product from the PO's S-4738 even though it starts with it.
        const hits = scoreUlineSkuCandidates(["S-17888", "S-473824"], [PO_125429, PO_125410]);
        expect(hits).toHaveLength(1);
        expect(hits[0].poNumber).toBe("125429");
        expect(hits[0].matchedSkus).toEqual(["S-17888"]);
    });

    it("never substring-matches S-4738 against S-473824", () => {
        const hits = scoreUlineSkuCandidates(["S-473824"], [PO_125429]);
        expect(hits).toEqual([]);
    });

    it("normalizes case and whitespace but not characters", () => {
        const hits = scoreUlineSkuCandidates([" s-17888 "], [PO_125429]);
        expect(hits).toHaveLength(1);
        expect(hits[0].matchedSkus).toEqual(["S-17888"]);
    });

    it("ignores POs from other vendors that carry the same productId", () => {
        const other = { ...PO_125429, po_number: "124000", vendor_name: "Axiom" };
        const hits = scoreUlineSkuCandidates(["S-17888"], [other]);
        expect(hits).toEqual([]);
    });

    it("ignores dropship POs", () => {
        const dropship = {
            ...PO_125429,
            po_number: "23581487-S-DropshipPO",
        };
        const hits = scoreUlineSkuCandidates(["S-17888"], [dropship]);
        expect(hits).toEqual([]);
    });

    it("ranks multiple hits by number of exact SKUs", () => {
        const both = {
            po_number: "125500",
            vendor_name: "Uline",
            issue_date: "2026-10-01T00:00:00-06:00",
            total_amount: 100,
            status: "open",
            line_items: [{ productId: "S-17888" }, { productId: "S-4738" }, { productId: "S-11443" }],
        };
        const hits = scoreUlineSkuCandidates(["S-4738", "S-17888", "S-11443"], [PO_125429, both]);
        expect(hits.map((h) => h.poNumber)).toEqual(["125500", "125429"]);
        expect(hits[0].matchedSkus).toEqual(["S-11443", "S-17888", "S-4738"]);
    });

    it("reads line_items stored as a JSON string", () => {
        const hits = scoreUlineSkuCandidates(
            ["S-11443"],
            [{ ...PO_125410, line_items: JSON.stringify(PO_125410.line_items) }],
        );
        expect(hits).toHaveLength(1);
        expect(hits[0].poNumber).toBe("125410");
    });

    it("returns nothing when the invoice carries no SKUs", () => {
        expect(scoreUlineSkuCandidates([], [PO_125429])).toEqual([]);
    });

    it("returns nothing when no PO line overlaps", () => {
        expect(scoreUlineSkuCandidates(["H-2505GR"], [PO_125429, PO_125410])).toEqual([]);
    });
});
