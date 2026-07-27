/**
 * @file    src/lib/purchasing/auto-match-unmatched.test.ts
 * @purpose Unit tests for the batch auto-match runner
 * @author  Hermia
 * @created 2026-07-27
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the db module before importing
vi.mock("@/lib/db", () => ({
    createClient: vi.fn(),
}));

// Mock invoice-po-matcher
vi.mock("@/lib/purchasing/invoice-po-matcher", () => ({
    findPOCandidates: vi.fn(),
}));

import { createClient } from "@/lib/db";
import { findPOCandidates } from "@/lib/purchasing/invoice-po-matcher";
import {
    runAutoMatchUnmatched,
    loadUnmatchedInvoicesForAutoMatch,
    applyPOCandidate,
    validatePOExists,
    approveCloseMatchUnreconciled,
} from "./auto-match-unmatched";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a mock query builder that returns the given data/error.
 *
 * IMPORTANT: The `.then()` mock MUST call the resolve callback (not just
 * return a resolved promise) because JavaScript's `await` on a thenable
 * calls `then(resolve, reject)` and expects resolve to be CALLED, not
 * for `then` to return a resolved promise. Using mockResolvedValue here
 * would cause `await` to hang forever.
 */
function mockQuery(data: any = null, error: any = null): any {
    const qb: any = {};
    const chainMethods = [
        "select", "eq", "neq", "gt", "gte", "lt", "lte",
        "like", "ilike", "is", "in", "not", "or", "contains",
        "order", "limit", "single", "maybeSingle",
        "insert", "upsert", "update", "delete",
        "filter", "overlap", "overlaps", "offset",
    ];
    for (const m of chainMethods) {
        qb[m] = vi.fn().mockReturnValue(qb);
    }
    qb.then = vi.fn().mockImplementation((resolve: Function) => {
        resolve({ data, error });
        return undefined; // return void, the internal Promise handles the chain
    });
    return qb;
}

/**
 * Chain mockQuery calls: each call to .from() returns the next query builder
 * in sequence.
 */
function chainQueries(...queryBuilders: any[]): any {
    const fn = vi.fn();
    for (const qb of queryBuilders) {
        fn.mockReturnValueOnce(qb);
    }
    return fn;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("loadUnmatchedInvoicesForAutoMatch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns empty array when db is not configured", async () => {
        (createClient as any).mockReturnValue(null);
        expect(await loadUnmatchedInvoicesForAutoMatch()).toEqual([]);
    });

    it("returns empty array when no invoices found", async () => {
        const qInv = mockQuery([], null);
        (createClient as any).mockReturnValue({ from: vi.fn().mockReturnValue(qInv), rpc: vi.fn() });
        expect(await loadUnmatchedInvoicesForAutoMatch()).toEqual([]);
    });

    it("loads and enriches invoices with OCR candidates", async () => {
        const qInv = mockQuery([
            { id: "inv-1", invoice_number: "INV-001", vendor_name: "Test Vendor", total: 500,
              subtotal: 450, freight: 25, tax: 25, invoice_date: "2026-07-15",
              created_at: "2026-07-15T10:00:00Z", po_number: null, no_po_required: false, status: "unmatched" },
        ], null);
        const qVi = mockQuery([
            { vendor_name: "Test Vendor", invoice_number: "INV-001",
              raw_data: { poNumber: "PO-OCR-123", orderNumber: "ORD-456" } },
        ], null);

        (createClient as any).mockReturnValue({
            from: chainQueries(qInv, qVi),
            rpc: vi.fn(),
        });

        const result = await loadUnmatchedInvoicesForAutoMatch(100);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("inv-1");
        expect(result[0].ocrPoCandidate).toBe("PO-OCR-123");
        expect(result[0].ocrOrderCandidate).toBe("ORD-456");
    });
});

describe("runAutoMatchUnmatched", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns empty result when db not configured", async () => {
        (createClient as any).mockReturnValue(null);
        const r = await runAutoMatchUnmatched(10);
        expect(r.examined).toBe(0);
        expect(r.autoApplied).toHaveLength(0);
    });

    it("auto-applies when findPOCandidates returns autoApplyReady", async () => {
        // Setup: invoices query returns one unmatched invoice
        const qInv = mockQuery([
            { id: "inv-1", invoice_number: "INV-001", vendor_name: "Test Vendor",
              total: 500, subtotal: 450, freight: 25, tax: 25,
              invoice_date: "2026-07-15", created_at: "2026-07-15T10:00:00Z",
              po_number: null, no_po_required: false, status: "unmatched" },
        ], null);

        // vendor_invoices query returns empty
        const qVi = mockQuery([], null);

        // Idempotency check: invoice still has no PO
        const qCheck = mockQuery({ po_number: null }, null);

        // Updates and inserts resolve successfully
        const qUpdInv = mockQuery(null, null);
        const qUpdVi = mockQuery(null, null);
        const qLog = mockQuery(null, null);

        (createClient as any).mockReturnValue({
            from: chainQueries(qInv, qVi, qCheck, qUpdInv, qUpdVi, qLog),
            rpc: vi.fn(),
        });

        // findPOCandidates returns a high-confidence match
        (findPOCandidates as any).mockResolvedValue({
            invoice: { id: "inv-1" },
            candidates: [
                { orderId: "PO-123", vendorName: "Test Vendor",
                  score: 85, reasons: ["exact vendor match", "close date"] },
            ],
            bestMatch: { orderId: "PO-123", vendorName: "Test Vendor",
                         score: 85, reasons: ["exact vendor match", "close date"] },
            autoApplyReady: true,
        });

        const result = await runAutoMatchUnmatched(10);

        expect(result.examined).toBe(1);
        expect(result.autoApplied).toHaveLength(1);
        expect(result.autoApplied[0].poNumber).toBe("PO-123");
        expect(result.autoApplied[0].score).toBe(85);
        expect(result.skipped).toHaveLength(0);
        expect(result.errors).toBe(0);

        // Verify the update set po_number and matched_unreconciled status
        expect(qUpdInv.update).toHaveBeenCalledWith({
            po_number: "PO-123",
            status: "matched_unreconciled",
        });
        expect(qUpdInv.eq).toHaveBeenCalledWith("id", "inv-1");
    });

    it("skips when no PO candidates found", async () => {
        const qInv = mockQuery([
            { id: "inv-1", invoice_number: "INV-001", vendor_name: "Unknown Vendor",
              total: 500, subtotal: 450, freight: 25, tax: 25,
              invoice_date: "2026-07-15", created_at: "2026-07-15T10:00:00Z",
              po_number: null, no_po_required: false, status: "unmatched" },
        ], null);
        const qVi = mockQuery([], null);
        const qCheck = mockQuery({ po_number: null }, null);

        (createClient as any).mockReturnValue({
            from: chainQueries(qInv, qVi, qCheck),
            rpc: vi.fn(),
        });

        (findPOCandidates as any).mockResolvedValue({
            invoice: { id: "inv-1" }, candidates: [], bestMatch: null, autoApplyReady: false,
        });

        const result = await runAutoMatchUnmatched(10);
        expect(result.examined).toBe(1);
        expect(result.autoApplied).toHaveLength(0);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].reason).toContain("no PO candidates");
    });

    it("handles findPOCandidates errors gracefully", async () => {
        const qInv = mockQuery([
            { id: "inv-1", invoice_number: "INV-001", vendor_name: "Test Vendor",
              total: 500, subtotal: 450, freight: 25, tax: 25,
              invoice_date: "2026-07-15", created_at: "2026-07-15T10:00:00Z",
              po_number: null, no_po_required: false, status: "unmatched" },
        ], null);

        // Need idempotency check query too — loadUnmatched returns invoices
        // then the main loop does its own idempotency check
        const qVi = mockQuery([], null);
        const qCheck = mockQuery({ po_number: null }, null);

        (createClient as any).mockReturnValue({
            from: chainQueries(qInv, qVi, qCheck),
            rpc: vi.fn(),
        });

        (findPOCandidates as any).mockRejectedValue(new Error("DB connection failed"));

        const result = await runAutoMatchUnmatched(10);
        expect(result.examined).toBe(1);
        // findPOCandidates threw — caught in catch block, increments errors
        expect(result.errors).toBeGreaterThanOrEqual(1);
    });
});

describe("validatePOExists", () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it("returns false when db not configured", async () => {
        (createClient as any).mockReturnValue(null);
        expect(await validatePOExists("PO-123")).toBe(false);
    });

    it("returns true when PO found", async () => {
        const q = mockQuery({ po_number: "PO-123" }, null);
        (createClient as any).mockReturnValue({ from: vi.fn().mockReturnValue(q), rpc: vi.fn() });
        expect(await validatePOExists("PO-123")).toBe(true);
    });

    it("returns false when PO not found", async () => {
        const q = mockQuery(null, new Error("not found"));
        (createClient as any).mockReturnValue({ from: vi.fn().mockReturnValue(q), rpc: vi.fn() });
        expect(await validatePOExists("PO-999")).toBe(false);
    });
});

describe("applyPOCandidate", () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it("returns error when db not configured", async () => {
        (createClient as any).mockReturnValue(null);
        const r = await applyPOCandidate("inv-1", "PO-123");
        expect(r.success).toBe(false);
    });

    it("returns error when PO not found", async () => {
        const qPo = mockQuery(null, new Error("not found"));
        (createClient as any).mockReturnValue({ from: vi.fn().mockReturnValue(qPo), rpc: vi.fn() });
        const r = await applyPOCandidate("inv-1", "PO-999");
        expect(r.success).toBe(false);
        expect(r.message).toContain("not found");
    });

    it("returns error when invoice not found", async () => {
        const qPo = mockQuery({ po_number: "PO-123" }, null);
        const qInv = mockQuery(null, new Error("not found"));
        (createClient as any).mockReturnValue({
            from: chainQueries(qPo, qInv),
            rpc: vi.fn(),
        });
        const r = await applyPOCandidate("inv-1", "PO-123");
        expect(r.success).toBe(false);
        expect(r.message).toContain("Invoice not found");
    });

    it("blocks when invoice already has a different PO", async () => {
        const qPo = mockQuery({ po_number: "PO-123" }, null);
        const qInv = mockQuery({
            id: "inv-1", invoice_number: "INV-001", vendor_name: "Old Vendor",
            po_number: "PO-OLD", status: "matched_unreconciled",
        }, null);
        (createClient as any).mockReturnValue({
            from: chainQueries(qPo, qInv),
            rpc: vi.fn(),
        });
        const r = await applyPOCandidate("inv-1", "PO-123");
        expect(r.success).toBe(false);
        expect(r.message).toContain("already has PO");
    });

    it("succeeds for valid PO and unmatched invoice", async () => {
        const qPo = mockQuery({ po_number: "PO-123" }, null);
        const qInv = mockQuery({
            id: "inv-1", invoice_number: "INV-001", vendor_name: "Test Vendor",
            po_number: null, status: "unmatched",
        }, null);
        const qUpdInv = mockQuery(null, null);
        const qUpdVi = mockQuery(null, null);
        const qUpsert = mockQuery(null, null);
        const qLog = mockQuery(null, null);

        (createClient as any).mockReturnValue({
            from: chainQueries(qPo, qInv, qUpdInv, qUpdVi, qUpsert, qLog),
            rpc: vi.fn(),
        });

        const r = await applyPOCandidate("inv-1", "PO-123", "Will");
        expect(r.success).toBe(true);
        expect(r.message).toContain("PO PO-123 applied");
        expect(qUpdInv.update).toHaveBeenCalledWith({
            po_number: "PO-123",
            status: "matched_unreconciled",
        });
    });
});

describe("approveCloseMatchUnreconciled", () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it("returns zeros when db not configured", async () => {
        (createClient as any).mockReturnValue(null);
        const r = await approveCloseMatchUnreconciled();
        expect(r.approved).toBe(0);
        expect(r.errors).toBe(0);
    });

    it("returns zeros when no matched_unreconciled invoices exist", async () => {
        const q = mockQuery([], null);
        (createClient as any).mockReturnValue({ from: vi.fn().mockReturnValue(q), rpc: vi.fn() });
        const r = await approveCloseMatchUnreconciled();
        expect(r.approved).toBe(0);
        expect(r.errors).toBe(0);
    });
});
