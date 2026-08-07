/**
 * @file    ordering-po-coverage.test.ts
 * @purpose Unit tests for Ordering recent-PO coverage overlay.
 * @author  Hermia
 * @created 2026-08-06
 */
import { describe, expect, it } from "vitest";
import {
    buildRecentOpenCoverageByProduct,
    isDraftOrderingStatus,
    isOpenOrderingStatus,
    isTerminalOrderingStatus,
    mergeOpenPOsWithRecentCoverage,
} from "./ordering-po-coverage";

describe("ordering-po-coverage status classifiers", () => {
    it("treats cancel/complete as terminal", () => {
        expect(isTerminalOrderingStatus("Cancelled")).toBe(true);
        expect(isTerminalOrderingStatus("ORDER_COMPLETED")).toBe(true);
        expect(isTerminalOrderingStatus("Committed")).toBe(false);
    });

    it("detects drafts", () => {
        expect(isDraftOrderingStatus("Created")).toBe(true);
        expect(isDraftOrderingStatus("ORDER_CREATED")).toBe(true);
        expect(isDraftOrderingStatus("Draft")).toBe(true);
        expect(isDraftOrderingStatus("Committed")).toBe(false);
    });

    it("treats committed/locked/sent as open coverage", () => {
        expect(isOpenOrderingStatus("Committed")).toBe(true);
        expect(isOpenOrderingStatus("ORDER_LOCKED")).toBe(true);
        expect(isOpenOrderingStatus("Sent")).toBe(true);
        expect(isOpenOrderingStatus("Acknowledged")).toBe(true);
        expect(isOpenOrderingStatus("Completed")).toBe(false);
        expect(isOpenOrderingStatus("Cancelled")).toBe(false);
    });
});

describe("buildRecentOpenCoverageByProduct", () => {
    it("indexes draft + committed POs so post-commit SKUs stay covered", () => {
        const map = buildRecentOpenCoverageByProduct([
            {
                orderId: "1001",
                status: "Created",
                orderDate: "2026-08-06",
                vendorName: "Sustainable Village",
                items: [
                    { productId: "BLM221", quantity: 150 },
                    { productId: "ALK101", quantity: 200 },
                ],
            },
            {
                orderId: "1002",
                status: "Committed",
                orderDate: "2026-08-06",
                vendorName: "Sustainable Village",
                items: [
                    { productId: "BLM212", quantity: 70 },
                ],
            },
            {
                orderId: "999",
                status: "Completed",
                orderDate: "2026-01-01",
                items: [{ productId: "BLM221", quantity: 9999 }],
            },
        ]);

        const blm221 = map.get("BLM221");
        expect(blm221?.totalQty).toBe(150);
        expect(blm221?.draft?.orderId).toBe("1001");
        expect(blm221?.openHits).toHaveLength(0);

        const blm212 = map.get("BLM212");
        expect(blm212?.totalQty).toBe(70);
        expect(blm212?.draft).toBeNull();
        expect(blm212?.openHits[0]?.orderId).toBe("1002");

        // Completed PO must not suppress Ordering
        expect(blm221?.totalQty).not.toBe(9999 + 150);
    });

    it("sums multiple open POs for the same SKU", () => {
        const map = buildRecentOpenCoverageByProduct([
            {
                orderId: "A",
                status: "Committed",
                items: [{ productId: "SKU1", quantity: 40 }],
            },
            {
                orderId: "B",
                status: "Locked",
                items: [{ productId: "SKU1", quantity: 60 }],
            },
        ]);
        expect(map.get("SKU1")?.totalQty).toBe(100);
        expect(map.get("SKU1")?.openHits).toHaveLength(2);
    });
});

describe("mergeOpenPOsWithRecentCoverage", () => {
    it("merges committed recent hits into empty GraphQL openPOs (stale SWR gap)", () => {
        const coverage = buildRecentOpenCoverageByProduct([
            {
                orderId: "125000",
                status: "Committed",
                orderDate: "2026-08-06",
                items: [{ productId: "BLM221", quantity: 150 }],
            },
        ]).get("BLM221");

        const merged = mergeOpenPOsWithRecentCoverage([], coverage);
        expect(merged).toEqual([
            { orderId: "125000", quantity: 150, orderDate: "2026-08-06" },
        ]);
    });

    it("keeps the larger qty when both sources have the same PO", () => {
        const coverage = buildRecentOpenCoverageByProduct([
            {
                orderId: "1",
                status: "Committed",
                orderDate: "2026-08-01",
                items: [{ productId: "X", quantity: 200 }],
            },
        ]).get("X");

        const merged = mergeOpenPOsWithRecentCoverage(
            [{ orderId: "1", quantity: 50, orderDate: "2026-08-01" }],
            coverage,
        );
        expect(merged).toEqual([{ orderId: "1", quantity: 200, orderDate: "2026-08-01" }]);
    });
});
