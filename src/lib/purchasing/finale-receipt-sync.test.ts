/**
 * @file    finale-receipt-sync.test.ts
 * @purpose Unit tests for the Finale receipt sync (receipt leg for 3-way match).
 * @author  Hermia
 * @created 2026-08-12
 *
 * Focus on the pure function computePOReceiptFacts — the part that turns raw
 * Finale shipment payloads into per-PO ordered/received/short facts. The
 * syncFinaleReceiptData I/O path is best-effort; its invariant is "never
 * throws, returns a structured result".
 */

import { describe, expect, it } from "vitest";

import {
    computePOReceiptFacts,
    hasReceiptEvidence,
    isConcretePastDate,
    POReceiptFacts,
    syncFinaleReceiptData,
} from "./finale-receipt-sync";

describe("computePOReceiptFacts", () => {
    const po = {
        orderId: "125155",
        vendorName: "ULINE",
        items: [
            { productId: "S-16882BL-L", quantity: 24 },
            { productId: "S-16882BL-S", quantity: 24 },
            { productId: "S-12610", quantity: 150 },
        ],
    };

    it("aggregates received quantities from shipment receipt items", () => {
        const facts = computePOReceiptFacts(po, [
            {
                receiveDate: "2026-08-04",
                itemList: [
                    { productId: "S-16882BL-L", quantity: 24 },
                    { productId: "S-16882BL-S", quantity: 24 },
                    { productId: "S-12610", quantity: 150 },
                ],
            },
        ]);

        expect(facts.po_number).toBe("125155");
        expect(facts.vendor_name).toBe("ULINE");
        expect(facts.total_ordered).toBe(198);
        expect(facts.total_received).toBe(198);
        expect(facts.units_short).toBe(0);
        expect(facts.fully_received).toBe(true);
        expect(facts.last_receipt_date).toBe("2026-08-04");
        expect(facts.line_items).toHaveLength(3);
    });

    it("detects short shipments (received < ordered)", () => {
        const facts = computePOReceiptFacts(po, [
            {
                receiveDate: "2026-08-04",
                itemList: [
                    { productId: "S-16882BL-L", quantity: 24 },
                    { productId: "S-16882BL-S", quantity: 24 },
                    // S-12610: 150 ordered, 0 received → short
                ],
            },
        ]);

        expect(facts.total_received).toBe(48);
        expect(facts.units_short).toBe(150);
        expect(facts.fully_received).toBe(false);
    });

    it("handles multiple shipments summing per-SKU receipt quantities", () => {
        const facts = computePOReceiptFacts(
            {
                orderId: "X1",
                vendorName: "Vendor",
                items: [{ productId: "A", quantity: 100 }],
            },
            [
                { receiveDate: "2026-08-01", itemList: [{ productId: "A", quantity: 40 }] },
                { receiveDate: "2026-08-05", itemList: [{ productId: "A", quantity: 60 }] },
            ],
        );

        expect(facts.total_received).toBe(100);
        expect(facts.units_short).toBe(0);
        expect(facts.fully_received).toBe(true);
        expect(facts.last_receipt_date).toBe("2026-08-05");
    });

    it("returns zeros when no shipment details and no items", () => {
        const facts = computePOReceiptFacts(
            { orderId: "E1", vendorName: "Empty", items: [] },
            [],
        );

        expect(facts.total_ordered).toBe(0);
        expect(facts.total_received).toBe(0);
        expect(facts.units_short).toBe(0);
        expect(facts.fully_received).toBe(false);
        expect(facts.last_receipt_date).toBeNull();
        expect(facts.line_items).toHaveLength(0);
    });

    it("line_items include every SKU (ordered-only, received-only, both)", () => {
        const facts = computePOReceiptFacts(
            {
                orderId: "Y1",
                vendorName: "V",
                items: [
                    { productId: "ORDERED_ONLY", quantity: 10 },
                    { productId: "BOTH", quantity: 5 },
                ],
            },
            [
                {
                    receiveDate: "2026-07-01",
                    itemList: [
                        { productId: "BOTH", quantity: 5 },
                        { productId: "RECEIVED_ONLY", quantity: 3 },
                    ],
                },
            ],
        );

        const skus = facts.line_items.map((li) => li.sku).sort();
        expect(skus).toEqual(["BOTH", "ORDERED_ONLY", "RECEIVED_ONLY"]);
        const both = facts.line_items.find((li) => li.sku === "BOTH");
        expect(both?.ordered).toBe(5);
        expect(both?.received).toBe(5);
    });
});

describe("isConcretePastDate / hasReceiptEvidence", () => {
    it("treats past dates as concrete receipt evidence", () => {
        expect(isConcretePastDate("2026-08-04")).toBe(true);
        expect(isConcretePastDate(new Date(Date.now() - 86400000).toISOString())).toBe(true);
    });

    it("rejects future planned ETAs (Finale mis-stores them in receiveDate)", () => {
        expect(isConcretePastDate(new Date(Date.now() + 9 * 86400000).toISOString())).toBe(false);
        expect(isConcretePastDate("2026-10-31")).toBe(false); // observed junk ETA
    });

    it("rejects null / garbage dates", () => {
        expect(isConcretePastDate(null)).toBe(false);
        expect(isConcretePastDate(undefined)).toBe(false);
        expect(isConcretePastDate("not-a-date")).toBe(false);
    });

    it("hasReceiptEvidence requires a PAST receiveDate, not any receiveDate", () => {
        expect(hasReceiptEvidence({ receiveDate: "2026-08-04", shipments: [] })).toBe(true);
        expect(hasReceiptEvidence({ receiveDate: "2026-10-31", shipments: [] })).toBe(false);
        expect(hasReceiptEvidence({ receiveDate: null, shipments: [{ receiveDate: "2026-08-04" }] })).toBe(true);
        // Dynamic future date — the original hardcoded "2026-08-21" expired on 2026-08-21
        // and started failing the day it became a past date (time-bomb fixture).
        const futureDate = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
        expect(hasReceiptEvidence({ receiveDate: null, shipments: [{ receiveDate: futureDate }] })).toBe(false);
        expect(hasReceiptEvidence({ receiveDate: null, shipments: [] })).toBe(false);
    });
});

describe("syncFinaleReceiptData (best-effort I/O)", () => {
    it("never throws and returns a structured result", async () => {
        const result = await syncFinaleReceiptData({ daysBack: 30, limit: 20, maxPos: 5 });

        expect(result).toHaveProperty("scanned");
        expect(result).toHaveProperty("withReceipts");
        expect(result).toHaveProperty("upserted");
        expect(result).toHaveProperty("skippedFresh");
        expect(result).toHaveProperty("errors");
        expect(Array.isArray(result.details)).toBe(true);

        expect(Number.isInteger(result.scanned)).toBe(true);
        expect(result.scanned).toBeGreaterThanOrEqual(0);
        expect(result.errors).toBeGreaterThanOrEqual(0);
        // upserted + skippedFresh + errors can never exceed scanned POs
        expect(result.upserted + result.skippedFresh + result.errors).toBeLessThanOrEqual(
            Math.max(result.scanned, 1),
        );
    });
});
