/**
 * @file    src/lib/storage/vendor-invoices.gate.test.ts
 * @purpose Regression tests for the extraction-quality gate in
 *          upsertVendorInvoice (Phase 1.1, t_3d2c50e0).
 *          A failed-quality invoice (total=0 + garbage invoice number) must
 *          NEVER be written with status='reconciled' — it is force-downgraded
 *          to 'received' and flagged extraction_quality='failed'. The DB CHECK
 *          chk_vi_no_reconcile_failed is the constraint-level backstop.
 * @author  aria-ap
 * @created 2026-08-12
 * @deps    vitest, @/lib/storage/vendor-invoices
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { upsertMock, insertMock, createClientMock } = vi.hoisted(() => {
    const upsertMock = vi.fn();
    const insertMock = vi.fn();
    const createClientMock = vi.fn();
    return { upsertMock, insertMock, createClientMock };
});

vi.mock("../db", () => ({
    createClient: () => createClientMock(),
}));

import { upsertVendorInvoice } from "./vendor-invoices";

function mockDbChains() {
    const select = vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: { id: "abc-123" }, error: null }) }));
    upsertMock.mockReturnValue({ select });
    insertMock.mockReturnValue({ select });
    createClientMock.mockReturnValue({
        from: vi.fn((table: string) => {
            if (table === "vendor_invoices") {
                return { upsert: upsertMock, insert: insertMock };
            }
            return { upsert: upsertMock, insert: insertMock };
        }),
    });
}

describe("upsertVendorInvoice extraction-quality gate (t_3d2c50e0)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDbChains();
    });

    it("refuses to write failed-quality invoice as reconciled — forces received", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const id = await upsertVendorInvoice({
            vendor_name: "Acme Supply",
            invoice_number: "Reminder", // not invoice-like
            total: 0,
            status: "reconciled", // attempt to sneak into reconciled
            source: "manual",
        });

        expect(id).toBe("abc-123");
        const payload = upsertMock.mock.calls[0][0];
        expect(payload.extraction_quality).toBe("failed");
        expect(payload.status).toBe("received"); // never reconciled
        // NOTE: the storage layer preserves the raw invoice_number; it is the
        // extraction layer (normalizeInvoiceForDb → isInvoiceLikeNumber) that
        // nulls garbage numbers before calling upsertVendorInvoice. The gate
        // here is about quality + status, not number sanitization.
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it("keeps complete-quality invoices reconciled", async () => {
        const id = await upsertVendorInvoice({
            vendor_name: "Acme Supply",
            invoice_number: "APUS-244677",
            total: 1250.5,
            status: "reconciled",
            source: "manual",
        });

        expect(id).toBe("abc-123");
        const payload = upsertMock.mock.calls[0][0];
        expect(payload.extraction_quality).toBe("complete");
        expect(payload.status).toBe("reconciled");
    });

    it("marks total=0 + invoice-like number as partial (usable number, no amount)", async () => {
        await upsertVendorInvoice({
            vendor_name: "Acme Supply",
            invoice_number: "1682",
            total: 0,
            status: "received",
            source: "manual",
        });
        const payload = upsertMock.mock.calls[0][0];
        expect(payload.extraction_quality).toBe("partial");
    });

    it("honors explicit extraction_quality override (human-verified partial)", async () => {
        await upsertVendorInvoice({
            vendor_name: "Acme Supply",
            invoice_number: "Reminder",
            total: 0,
            status: "received",
            source: "manual",
            extraction_quality: "partial", // human says this is a legit partial
        });
        const payload = upsertMock.mock.calls[0][0];
        expect(payload.extraction_quality).toBe("partial");
    });

    it("uses INSERT path (not upsert) when invoice number is null", async () => {
        await upsertVendorInvoice({
            vendor_name: "Acme Supply",
            invoice_number: null,
            total: 0,
            status: "received",
            source: "manual",
        });
        expect(insertMock).toHaveBeenCalled();
        expect(upsertMock).not.toHaveBeenCalled();
        const payload = insertMock.mock.calls[0][0];
        expect(payload.extraction_quality).toBe("failed");
    });
});
