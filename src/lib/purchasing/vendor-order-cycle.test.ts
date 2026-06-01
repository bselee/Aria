/**
 * @file    src/lib/purchasing/vendor-order-cycle.test.ts
 * @purpose Unit tests for vendor-level order cycle guard.
 *          Verifies Grassroots/TeaLAB fragmentation patterns,
 *          exception evidence bypass, and cancel/dropship exclusion.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    vitest, ./vendor-order-cycle
 *
 * Run: npx vitest run src/lib/purchasing/vendor-order-cycle.test.ts
 */

import { describe, it, expect } from "vitest";
import {
    evaluateVendorCycle,
    findReusableDraft,
    type VendorCycleCheck,
} from "./vendor-order-cycle";

type TestPO = {
    orderId: string;
    orderDate: string | null;
    status: string;
    supplier: string;
    isDropship?: boolean;
    isCanceled?: boolean;
};

describe("evaluateVendorCycle", () => {
    const baseCheck: VendorCycleCheck = {
        vendorPartyId: "party_001",
        vendorName: "Test Vendor",
    };

    // ── Grassroots-like fragmentation pattern ───────────────────────────

    it("should lock after first committed PO (Grassroots pattern)", () => {
        const day = 86400000;
        const pos: TestPO[] = [
            { orderId: "PO-001", orderDate: new Date(Date.now() - 10 * day).toISOString(), status: "ORDER_COMMITTED", supplier: "Grassroots" },
            { orderId: "PO-002", orderDate: new Date(Date.now() - 5 * day).toISOString(), status: "ORDER_COMMITTED", supplier: "Grassroots" },
        ];

        const result = evaluateVendorCycle(pos, baseCheck);
        expect(result.decision).toBe("routine_locked");
        expect(result.blockingPOs.length).toBeGreaterThanOrEqual(1);
        expect(result.blockingPOs[0].orderId).toBe("PO-001");
    });

    // ── TeaLAB-like: second PO 12 days after first committed ──────────

    it("should block second PO 12 days after first committed (TeaLAB pattern)", () => {
        const day = 86400000;
        const pos: TestPO[] = [
            { orderId: "PO-001", orderDate: new Date(Date.now() - 12 * day).toISOString(), status: "ORDER_COMMITTED", supplier: "TeaLAB" },
        ];

        const result = evaluateVendorCycle(pos, baseCheck);
        expect(result.decision).toBe("routine_locked");
        expect(result.blockingPOs).toHaveLength(1);
    });

    // ── Canceled POs should not lock ──────────────────────────────────

    it("should ignore canceled POs (Grassroots May 2026 canceled)", () => {
        const day = 86400000;
        const pos: TestPO[] = [
            { orderId: "PO-001", orderDate: new Date(Date.now() - 10 * day).toISOString(), status: "ORDER_CANCELED", supplier: "Grassroots", isCanceled: true },
        ];

        const result = evaluateVendorCycle(pos, baseCheck);
        expect(result.decision).toBe("clear");
        expect(result.ignoredCanceled).toBe(1);
    });

    // ── Dropship POs should not lock ──────────────────────────────────

    it("should ignore dropship POs", () => {
        const day = 86400000;
        const pos: TestPO[] = [
            { orderId: "PO-001", orderDate: new Date(Date.now() - 10 * day).toISOString(), status: "ORDER_COMMITTED", supplier: "DropshipVendor", isDropship: true },
        ];

        const result = evaluateVendorCycle(pos, baseCheck);
        expect(result.decision).toBe("clear");
        expect(result.ignoredDropship).toBe(1);
    });

    // ── Old POs outside cycle window should not block ─────────────────

    it("should ignore POs older than 30 days", () => {
        const oldDate = new Date(Date.now() - 35 * 86400000).toISOString();
        const pos: TestPO[] = [
            { orderId: "PO-001", orderDate: oldDate, status: "ORDER_COMMITTED", supplier: "Old Vendor" },
        ];

        const result = evaluateVendorCycle(pos, baseCheck);
        expect(result.decision).toBe("clear");
    });

    // ── Exception evidence bypass ─────────────────────────────────────

    it("should allow exception for sale demand despite cycle lock", () => {
        const day = 86400000;
        const pos: TestPO[] = [
            { orderId: "PO-001", orderDate: new Date(Date.now() - 10 * day).toISOString(), status: "ORDER_COMMITTED", supplier: "Grassroots" },
        ];

        const check: VendorCycleCheck = {
            ...baseCheck,
            exceptionReason: {
                reason: "sale_demand",
                detail: "Linked to sales order #456, 200 units needed",
            },
        };

        const result = evaluateVendorCycle(pos, check);
        expect(result.decision).toBe("exception_allowed");
        expect(result.exceptionEvidence?.reason).toBe("sale_demand");
    });

    it("should allow exception for surge demand", () => {
        const day = 86400000;
        const pos: TestPO[] = [
            { orderId: "PO-001", orderDate: new Date(Date.now() - 10 * day).toISOString(), status: "ORDER_COMMITTED", supplier: "Grassroots" },
        ];

        const check: VendorCycleCheck = {
            ...baseCheck,
            exceptionReason: {
                reason: "surge_demand",
                detail: "Demand 3× above baseline this week",
            },
        };

        const result = evaluateVendorCycle(pos, check);
        expect(result.decision).toBe("exception_allowed");
    });

    it("should allow exception for build-critical demand", () => {
        const day = 86400000;
        const pos: TestPO[] = [
            { orderId: "PO-001", orderDate: new Date(Date.now() - 10 * day).toISOString(), status: "ORDER_OPEN", supplier: "BuildsVendor" },
        ];

        const check: VendorCycleCheck = {
            ...baseCheck,
            exceptionReason: {
                reason: "build_critical",
                detail: "BOM requires this SKU for tomorrow's build",
            },
        };

        const result = evaluateVendorCycle(pos, check);
        expect(result.decision).toBe("exception_allowed");
    });

    // ── No POs at all → clear ─────────────────────────────────────────

    it("should return clear when no POs exist", () => {
        const result = evaluateVendorCycle([], baseCheck);
        expect(result.decision).toBe("clear");
        expect(result.blockingPOs).toHaveLength(0);
    });

    // ── Mixed: committed + canceled + dropship ────────────────────────

    it("should only count committed/open POs, not canceled or dropship", () => {
        const day = 86400000;
        const pos: TestPO[] = [
            { orderId: "PO-001", orderDate: new Date(Date.now() - 10 * day).toISOString(), status: "ORDER_COMMITTED", supplier: "MixedVendor" },
            { orderId: "PO-002", orderDate: new Date(Date.now() - 5 * day).toISOString(), status: "ORDER_CANCELED", supplier: "MixedVendor", isCanceled: true },
            { orderId: "PO-003", orderDate: new Date(Date.now() - 2 * day).toISOString(), status: "ORDER_COMMITTED", supplier: "MixedVendor", isDropship: true },
        ];

        const result = evaluateVendorCycle(pos, baseCheck);
        expect(result.decision).toBe("routine_locked");
        expect(result.blockingPOs).toHaveLength(1); // Only PO-001
        expect(result.ignoredCanceled).toBe(1);
        expect(result.ignoredDropship).toBe(1);
    });
});

describe("findReusableDraft", () => {
    it("should find a reusable draft PO within the cycle window", () => {
        const recentDraft = new Date().toISOString();
        const pos: TestPO[] = [
            { orderId: "PO-DRAFT", status: "ORDER_DRAFT", orderDate: recentDraft, supplier: "TestVendor" },
        ];

        const draft = findReusableDraft(pos.map(p => ({
            orderId: p.orderId,
            status: p.status,
            orderDate: p.orderDate,
        })));
        expect(draft).not.toBeNull();
        expect(draft!.orderId).toBe("PO-DRAFT");
    });

    it("should not find draft PO outside cycle window", () => {
        const oldDate = new Date(Date.now() - 35 * 86400000).toISOString();
        const pos = [
            { orderId: "PO-OLD-DRAFT", status: "ORDER_DRAFT", orderDate: oldDate },
        ];

        const draft = findReusableDraft(pos);
        expect(draft).toBeNull();
    });
});
