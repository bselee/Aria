/**
 * @file    src/app/api/dashboard/invoice-queue/route.test.ts
 * @purpose Unit tests for the invoice-queue route — specifically that disregarded
 *          invoices are excluded from the response list and from stats.unmatched.
 *          Mocks @/lib/db and the classification/config modules so no live DB is hit.
 * @author  Hermia
 * @created 2026-08-02
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockDbClient = {
    from: vi.fn(),
    rpc: vi.fn(),
};

vi.mock("@/lib/db", () => ({
    createClient: () => mockDbClient,
}));

// Mock classifyInvoice — default to "real_invoice"
vi.mock("@/config/invoice-classification", () => ({
    classifyInvoice: vi.fn().mockReturnValue({
        classification: "real_invoice",
        reason: "Test",
    }),
}));

// Mock dropship keywords
vi.mock("@/config/dropship-vendors", () => ({
    KNOWN_DROPSHIP_KEYWORDS: [],
}));

// Mock resolve-status — default to "unmatched"
vi.mock("./resolve-status", () => ({
    resolveStatus: vi.fn().mockReturnValue("unmatched"),
    isPendingStatus: vi.fn().mockReturnValue(false),
}));

// findPOCandidates pulls Finale via invoice-po-matcher — mock entirely
vi.mock("@/lib/purchasing/invoice-po-matcher", () => ({
    findPOCandidates: vi.fn().mockResolvedValue({
        candidates: [],
        bestMatch: null,
        autoApplyReady: false,
        invoice: {},
    }),
}));

const { GET } = await import("./route");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(bust = true): NextRequest {
    const url = bust
        ? "http://localhost:3001/api/dashboard/invoice-queue?bust=1"
        : "http://localhost:3001/api/dashboard/invoice-queue";
    const parsed = new URL(url);
    return { nextUrl: parsed } as NextRequest;
}

/**
 * Build a query builder that returns the given invoices from select,
 * and empty ap_activity_log data from the second select.
 */
function mockQueueDb(invoices: any[], logData: any[] = []) {
    // Query builder for invoices select
    const invoiceSelectBuilder = {
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((resolve: any) => resolve({
            data: invoices,
            error: null,
        })),
    };

    // Query builder for activity log select
    const logSelectBuilder = {
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((resolve: any) => resolve({
            data: logData,
            error: null,
        })),
    };

    // First .from('invoices') call returns invoiceSelectBuilder
    // Any subsequent .from() calls return logSelectBuilder
    mockDbClient.from.mockImplementation((table: string) => {
        const qb = {
            select: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            then: vi.fn(),
        };

        if (table === "invoices") {
            qb.select.mockReturnValue(invoiceSelectBuilder);
        } else if (table === "vendor_profiles") {
            // requires_po filter: return empty list by default (no suppressed vendors)
            qb.select.mockReturnThis();
            qb.eq = vi.fn().mockReturnThis();
            qb.then = vi.fn().mockImplementation((resolve: any) => resolve({ data: [], error: null }));
        } else if (table === "vendor_invoices") {
            // source_inbox lookup
            qb.select.mockReturnThis();
            qb.in = vi.fn().mockReturnThis();
            qb.not = vi.fn().mockReturnThis();
            qb.then = vi.fn().mockImplementation((resolve: any) => resolve({ data: [], error: null }));
        } else {
            qb.select.mockReturnValue(logSelectBuilder);
        }

        return qb;
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/dashboard/invoice-queue — disregard filter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("excludes invoices with no_po_required=true from the unmatched list", async () => {
        const invoices = [
            {
                id: "1",
                invoice_number: "INV-001",
                vendor_name: "Vendor A",
                total: 100,
                subtotal: 100,
                freight: 0,
                tax: 0,
                tariff: 0,
                labor: 0,
                status: "received",
                po_number: null,
                created_at: new Date().toISOString(),
                discrepancies: null,
                no_po_required: false, // normal unmatched — should appear
            },
            {
                id: "2",
                invoice_number: "INV-002",
                vendor_name: "Vendor B",
                total: 200,
                subtotal: 200,
                freight: 0,
                tax: 0,
                tariff: 0,
                labor: 0,
                status: "received",
                po_number: null,
                created_at: new Date().toISOString(),
                discrepancies: null,
                no_po_required: true, // DISREGARDED — must be filtered out
            },
        ];

        const logs: any[] = [];

        mockQueueDb(invoices, logs);

        const req = makeRequest(true);
        const res = await GET(req);
        const body = await res.json();

        expect(res.status).toBe(200);

        // INV-002 should be excluded
        expect(body.invoices.length).toBe(1);
        expect(body.invoices[0].invoiceNumber).toBe("INV-001");

        // unmatched count should reflect only INV-001
        expect(body.stats.unmatched).toBe(1);
    });

    it("returns empty list when all unmatched invoices are disregarded", async () => {
        const invoices = [
            {
                id: "3",
                invoice_number: "INV-003",
                vendor_name: "Vendor C",
                total: 150,
                subtotal: 150,
                freight: 0,
                tax: 0,
                tariff: 0,
                labor: 0,
                status: "received",
                po_number: null,
                created_at: new Date().toISOString(),
                discrepancies: null,
                no_po_required: true, // disregarded
            },
        ];

        const logs: any[] = [];
        mockQueueDb(invoices, logs);

        const req = makeRequest(true);
        const res = await GET(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.invoices.length).toBe(0);

        // Since the mock's resolveStatus returns "unmatched" for every invoice,
        // and mocks' isPendingStatus returns false, all items pass through the
        // flatMap but INV-003 gets filtered out by no_po_required check.
        // With no items making it through, unmatched should be 0.
        expect(body.stats.unmatched).toBe(0);
    });
});
