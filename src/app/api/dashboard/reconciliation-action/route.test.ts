/**
 * @file    src/app/api/dashboard/reconciliation-action/route.test.ts
 * @purpose Unit tests for the "disregard" action on the reconciliation-action route.
 *          Tests: sets fields, idempotent, 404 on unknown invoiceId, 400 on missing invoiceId.
 *          Mocks PostgREST via @/lib/db so no live database is touched.
 * @author  Hermia
 * @created 2026-08-02
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock @/lib/db BEFORE importing the route
const mockDbClient = {
    from: vi.fn(),
    rpc: vi.fn(),
};

// Default mock: from().select().eq().single() returns "not found" (avoids crash on initial ap_activity_log fetch)
function defaultMockDb() {
    const defaultQb = {
        select: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((resolve: any) => resolve({
            data: null,
            error: new Error("Row not found"),
        })),
    };
    mockDbClient.from.mockReturnValue(defaultQb);
}

defaultMockDb();

vi.mock("@/lib/db", () => ({
    createClient: () => mockDbClient,
}));

// Mock FinaleClient (needed for approve/rematch — won't be called by disregard)
vi.mock("@/lib/finale/client", () => ({
    FinaleClient: vi.fn(),
}));

// Mock reconciler
vi.mock("@/lib/finale/reconciler", () => ({
    reconcileInvoiceToPO: vi.fn(),
    applyReconciliation: vi.fn(),
    buildAuditMetadata: vi.fn(),
    ReconciliationResult: {},
}));

// Mock ap-issue
vi.mock("@/lib/intelligence/ap-issue", () => ({
    findApIssue: vi.fn().mockResolvedValue(null),
    unblockApIssue: vi.fn(),
    completeApIssue: vi.fn(),
}));

// Mock reconciliation-outcomes
vi.mock("@/lib/runtime/observability/reconciliation-outcomes", () => ({
    resolvePendingReconciliationOutcomeBySource: vi.fn(),
    writeReconciliationOutcome: vi.fn(),
}));

// Import the route handler after mocks are set up
const { POST } = await import("./route");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): Request {
    return new Request("http://localhost:3001/api/dashboard/reconciliation-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

/**
 * Create a mock query builder that returns the desired data/error.
 */
function mockQueryBuilder(mock: any, opts: {
    selectData?: any;
    selectError?: any;
    isSingle?: boolean;
    updateData?: any;
    updateError?: any;
}) {
    const qb: any = {
        select: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockReturnThis(),
        then: vi.fn(),
    };

    // Default: select returns data, update succeeds
    qb.then.mockImplementation((resolve: any) => {
        const result = { data: null, error: null };
        return resolve(result);
    });

    // If specific select data is provided, mock select chain
    if (opts.selectData !== undefined || opts.selectError !== undefined) {
        const selectBuilder = {
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockReturnThis(),
            then: vi.fn().mockImplementation((resolve: any) => {
                return resolve({
                    data: opts.selectData ?? null,
                    error: opts.selectError ?? null,
                });
            }),
        };
        qb.select.mockReturnValue(selectBuilder);
    }

    mock.from.mockReturnValue(qb);
    return qb;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/dashboard/reconciliation-action — disregard", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns 400 when invoiceId is missing", async () => {
        const req = makeRequest({ action: "disregard" });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toContain("invoiceId");
    });

    it("returns 400 when invoiceId is an empty string", async () => {
        const req = makeRequest({ action: "disregard", invoiceId: "" });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toContain("invoiceId");
    });

    it("returns 404 when invoice does not exist", async () => {
        mockQueryBuilder(mockDbClient, {
            selectData: null,
            selectError: new Error("Row not found"),
        });

        const req = makeRequest({ action: "disregard", invoiceId: "00000000-0000-0000-0000-000000000000" });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(404);
        expect(body.error).toContain("not found");
    });

    it("sets no_po_required=true on a valid invoice", async () => {
        // First call: select returns the invoice
        // Second call: update succeeds
        const updateBuilder = {
            eq: vi.fn().mockReturnThis(),
            then: vi.fn().mockImplementation((resolve: any) => resolve({ data: null, error: null })),
        };
        const selectBuilder = {
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockReturnThis(),
            then: vi.fn().mockImplementation((resolve: any) => resolve({
                data: { id: "abc-123", invoice_number: "INV-001", vendor_name: "Test Vendor" },
                error: null,
            })),
        };

        const qb: any = {
            select: vi.fn().mockReturnValue(selectBuilder),
            update: vi.fn().mockReturnValue(updateBuilder),
            eq: vi.fn().mockReturnThis(),
        };
        mockDbClient.from.mockReturnValue(qb);

        const req = makeRequest({ action: "disregard", invoiceId: "abc-123", reason: "credit_card", markedBy: "Will" });
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.message).toContain("INV-001");

        // Verify the update call carried the correct fields
        expect(qb.update).toHaveBeenCalledWith({
            no_po_required: true,
            no_po_reason: "credit_card",
            no_po_marked_by: "Will",
            no_po_marked_at: expect.any(String),
        });

        // Verify the update was filtered by id (the critical guard rail)
        expect(updateBuilder.eq).toHaveBeenCalledWith("id", "abc-123");
    });

    it("is idempotent — disregarding twice does not error", async () => {
        // Set up mock for both sequential calls
        const updateBuilder1 = {
            eq: vi.fn().mockReturnThis(),
            then: vi.fn().mockImplementation((resolve: any) => resolve({ data: null, error: null })),
        };
        const selectBuilder1 = {
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockReturnThis(),
            then: vi.fn().mockImplementation((resolve: any) => resolve({
                data: { id: "abc-123", invoice_number: "INV-001", vendor_name: "Test" },
                error: null,
            })),
        };
        const qb1: any = {
            select: vi.fn().mockReturnValue(selectBuilder1),
            update: vi.fn().mockReturnValue(updateBuilder1),
            eq: vi.fn().mockReturnThis(),
        };

        const updateBuilder2 = {
            eq: vi.fn().mockReturnThis(),
            then: vi.fn().mockImplementation((resolve: any) => resolve({ data: null, error: null })),
        };
        const selectBuilder2 = {
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockReturnThis(),
            then: vi.fn().mockImplementation((resolve: any) => resolve({
                data: { id: "abc-123", invoice_number: "INV-001", vendor_name: "Test" },
                error: null,
            })),
        };
        const qb2: any = {
            select: vi.fn().mockReturnValue(selectBuilder2),
            update: vi.fn().mockReturnValue(updateBuilder2),
            eq: vi.fn().mockReturnThis(),
        };

        // First call
        mockDbClient.from.mockReturnValueOnce(qb1);
        const req1 = makeRequest({ action: "disregard", invoiceId: "abc-123" });
        const res1 = await POST(req1);
        expect(res1.status).toBe(200);

        // Second call — same ID
        mockDbClient.from.mockReturnValueOnce(qb2);
        const req2 = makeRequest({ action: "disregard", invoiceId: "abc-123" });
        const res2 = await POST(req2);
        expect(res2.status).toBe(200);
    });
});
