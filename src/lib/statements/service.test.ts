import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StatementIntakeRecord } from "./types";

const calls: Record<string, any[]> = {};

const chain = {
    select: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
};

const mockSupabase = {
    from: vi.fn(() => {
        const c = {
            select: (...args: any[]) => { calls.select = args; return c; },
            ilike: (...args: any[]) => { calls.ilike = args; return c; },
            gte: (...args: any[]) => { calls.gte = args; return c; },
            lte: (...args: any[]) => { calls.lte = args; return c; },
            order: (...args: any[]) => { calls.order = args; return c; },
            limit: (...args: any[]) => { calls.limit = args; return c; },
        };
        return c;
    }),
};

vi.mock("@/lib/supabase", () => ({
    createClient: () => mockSupabase,
}));

function makeIntake(overrides: Partial<StatementIntakeRecord> = {}): StatementIntakeRecord {
    return {
        id: "intake_1",
        vendorName: "AAA COOPER",
        sourceType: "email_statement",
        sourceRef: "msg_123",
        artifactPath: "msg_123/statement.pdf",
        artifactKind: "pdf",
        statementDate: "2026-03-31",
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        status: "ready",
        adapterKey: "email_statement",
        fingerprint: "fp1",
        rawMetadata: {},
        discoveredAt: "2026-03-31T10:00:00Z",
        queuedBy: "ap_identifier",
        lastError: null,
        ...overrides,
    };
}

describe("fetchArchivedInvoices", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.keys(calls).forEach(k => delete calls[k]);
    });

    it("calls from with vendor_invoices", async () => {
        const { fetchArchivedInvoices } = await import("./service");
        chain.select.mockResolvedValue({ data: [], error: null });
        await fetchArchivedInvoices(makeIntake());
        expect(mockSupabase.from).toHaveBeenCalledWith("vendor_invoices");
    });

    it("queries with ilike using the canonicalized vendor name", async () => {
        const { fetchArchivedInvoices } = await import("./service");
        chain.select.mockResolvedValue({ data: [], error: null });
        await fetchArchivedInvoices(makeIntake({ vendorName: "AAA Cooper Transportation" }));
        expect(calls.ilike).toEqual(["vendor_name", "%AAA COOPER%"]);
    });

    it("queries with FedEx canonical name", async () => {
        const { fetchArchivedInvoices } = await import("./service");
        chain.select.mockResolvedValue({ data: [], error: null });
        await fetchArchivedInvoices(makeIntake({ vendorName: "FedEx Ground" }));
        expect(calls.ilike).toEqual(["vendor_name", "%FedEx%"]);
    });

    it("applies both gte and lte when periodStart and periodEnd are provided", async () => {
        const { fetchArchivedInvoices } = await import("./service");
        chain.select.mockResolvedValue({ data: [], error: null });
        await fetchArchivedInvoices(makeIntake({ periodStart: "2026-03-01", periodEnd: "2026-03-31" }));
        expect(calls.gte).toEqual(["invoice_date", "2026-03-01"]);
        expect(calls.lte).toEqual(["invoice_date", "2026-03-31"]);
    });

    it("derives periodEnd from statementDate when periodEnd is null", async () => {
        const { fetchArchivedInvoices } = await import("./service");
        chain.select.mockResolvedValue({ data: [], error: null });
        await fetchArchivedInvoices(makeIntake({ periodStart: "2026-03-01", periodEnd: null, statementDate: "2026-04-15" }));
        expect(calls.lte).toEqual(["invoice_date", "2026-04-15"]);
    });

    it("derives periodStart as 180 days before periodEnd when periodStart is null", async () => {
        const { fetchArchivedInvoices } = await import("./service");
        chain.select.mockResolvedValue({ data: [], error: null });
        await fetchArchivedInvoices(makeIntake({ periodStart: null, periodEnd: "2026-04-30", statementDate: "2026-04-30" }));
        expect(calls.gte).toEqual(["invoice_date", "2025-11-01"]);
    });

    it("derives periodEnd from statementDate AND periodStart as 180-day lookback when both are null", async () => {
        const { fetchArchivedInvoices } = await import("./service");
        chain.select.mockResolvedValue({ data: [], error: null });
        await fetchArchivedInvoices(makeIntake({ periodStart: null, periodEnd: null, statementDate: "2026-03-31" }));
        expect(calls.gte).toEqual(["invoice_date", "2025-10-02"]);
        expect(calls.lte).toEqual(["invoice_date", "2026-03-31"]);
    });

    it("still applies explicit period bounds when they are provided (override lookback)", async () => {
        const { fetchArchivedInvoices } = await import("./service");
        chain.select.mockResolvedValue({ data: [], error: null });
        await fetchArchivedInvoices(makeIntake({ periodStart: "2026-02-01", periodEnd: "2026-02-28" }));
        expect(calls.gte).toEqual(["invoice_date", "2026-02-01"]);
        expect(calls.lte).toEqual(["invoice_date", "2026-02-28"]);
    });
});
