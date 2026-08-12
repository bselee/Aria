/**
 * @file    api/storage/invoice-pdf/route.test.ts
 * @purpose Tests for the vendor invoice PDF serve route.
 *          Verifies UUID lookup, invoice number fallback,
 *          vendor allowlist gating (403 for non-allowlisted vendors),
 *          missing/missing-pdf 404s, and security boundaries.
 * @author  Aria Coder
 * @created 2026-08-11
 */

import { describe, expect, it, vi } from "vitest";

// ── Mock hoisting ──────────────────────────────────────────────────────
const {
    createClientMock,
    supabaseChain,
    downloadPDFMock,
    isReceivingsPdfVendorMock,
} = vi.hoisted(() => {
    const chain = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    return {
        createClientMock: vi.fn().mockReturnValue(chain),
        supabaseChain: chain,
        downloadPDFMock: vi.fn(),
        isReceivingsPdfVendorMock: vi.fn().mockReturnValue(true), // allowlisted by default
    };
});

vi.mock("@/lib/db", () => ({
    createClient: () => createClientMock(),
}));

vi.mock("@/lib/storage/supabase-storage", () => ({
    downloadPDF: downloadPDFMock,
}));

vi.mock("@/config/receivings-pdf-vendors", () => ({
    isReceivingsPdfVendor: isReceivingsPdfVendorMock,
}));

import { GET } from "./route";

describe("GET /api/storage/invoice-pdf", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        createClientMock.mockReturnValue(supabaseChain);
        supabaseChain.maybeSingle.mockResolvedValue({ data: null, error: null });
        downloadPDFMock.mockResolvedValue(null);
        isReceivingsPdfVendorMock.mockReturnValue(true); // default: allowlisted
    });

    // ── Valid requests ─────────────────────────────────────────────────

    it("returns PDF bytes for a valid UUID id lookup", async () => {
        const pdfBuf = Buffer.from("%PDF-1.4 fake pdf content");
        supabaseChain.maybeSingle.mockResolvedValue({
            data: {
                id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                invoice_number: "INV-0042",
                vendor_name: "Rootwise",
                pdf_storage_path: "local/storage/INVOICE/Rootwise/2026-01-15/inv-0042.pdf",
            },
            error: null,
        });
        downloadPDFMock.mockResolvedValue(pdfBuf);

        const req = new Request(
            "http://localhost:3001/api/storage/invoice-pdf?id=a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        );
        const res = await GET(req);

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("application/pdf");
        expect(res.headers.get("Content-Disposition")).toContain('filename="inv-INV-0042.pdf"');
        expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");

        const body = await res.arrayBuffer();
        expect(new Uint8Array(body)).toEqual(new Uint8Array(pdfBuf));

        expect(supabaseChain.from).toHaveBeenCalledWith("vendor_invoices");
        expect(supabaseChain.select).toHaveBeenCalledWith("id, invoice_number, vendor_name, pdf_storage_path");
        expect(supabaseChain.eq).toHaveBeenCalledWith(
            "id",
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        );
        expect(downloadPDFMock).toHaveBeenCalledWith(
            "local/storage/INVOICE/Rootwise/2026-01-15/inv-0042.pdf",
        );
    });

    it("returns PDF bytes for a valid invoice number lookup", async () => {
        const pdfBuf = Buffer.from("%PDF-1.4 invoice lookup content");
        supabaseChain.maybeSingle.mockResolvedValue({
            data: {
                id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                invoice_number: "INV-0099",
                vendor_name: "Malibu",
                pdf_storage_path: "local/storage/INVOICE/Malibu/2026-02-20/inv-0099.pdf",
            },
            error: null,
        });
        downloadPDFMock.mockResolvedValue(pdfBuf);

        const req = new Request(
            "http://localhost:3001/api/storage/invoice-pdf?invoice=INV-0099",
        );
        const res = await GET(req);

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("application/pdf");

        expect(supabaseChain.from).toHaveBeenCalledWith("vendor_invoices");
    });

    // ── Vendor gate: 403 for non-allowlisted vendors ────────────────────

    it("returns 403 when vendor is NOT on the Receivings PDF allowlist", async () => {
        isReceivingsPdfVendorMock.mockReturnValue(false);
        supabaseChain.maybeSingle.mockResolvedValue({
            data: {
                id: "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0",
                invoice_number: "INV-BLOCKED",
                vendor_name: "Unknown Vendor Inc",
                pdf_storage_path: "local/storage/INVOICE/blocked/blocked.pdf",
            },
            error: null,
        });

        const req = new Request(
            "http://localhost:3001/api/storage/invoice-pdf?id=f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0",
        );
        const res = await GET(req);

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toContain("not in Receivings PDF scope");
        expect(downloadPDFMock).not.toHaveBeenCalled();
    });

    // ── Not found / missing PDF ────────────────────────────────────────

    it("returns 404 when invoice id is not found", async () => {
        supabaseChain.maybeSingle.mockResolvedValue({ data: null, error: null });

        const req = new Request(
            "http://localhost:3001/api/storage/invoice-pdf?id=00000000-0000-0000-0000-000000000000",
        );
        const res = await GET(req);

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toBe("invoice not found");
    });

    it("returns 404 when invoice has no pdf_storage_path (no PDF on file)", async () => {
        supabaseChain.maybeSingle.mockResolvedValue({
            data: {
                id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
                invoice_number: "INV-NOPDF",
                vendor_name: "Axis",
                pdf_storage_path: null,
            },
            error: null,
        });

        const req = new Request(
            "http://localhost:3001/api/storage/invoice-pdf?id=cccccccc-cccc-cccc-cccc-cccccccccccc",
        );
        const res = await GET(req);

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toBe("no pdf on file");
    });

    it("returns 404 when downloadPDF returns null (file missing from disk)", async () => {
        supabaseChain.maybeSingle.mockResolvedValue({
            data: {
                id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
                invoice_number: "INV-GONE",
                vendor_name: "Lind Marine",
                pdf_storage_path: "local/storage/INVOICE/gone/gone.pdf",
            },
            error: null,
        });
        downloadPDFMock.mockResolvedValue(null); // file not on disk

        const req = new Request(
            "http://localhost:3001/api/storage/invoice-pdf?id=dddddddd-dddd-dddd-dddd-dddddddddddd",
        );
        const res = await GET(req);

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toBe("pdf file not found on disk");
    });

    // ── Input validation ───────────────────────────────────────────────

    it("returns 400 when neither id nor invoice query param is provided", async () => {
        const req = new Request("http://localhost:3001/api/storage/invoice-pdf");
        const res = await GET(req);

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("id");
        expect(body.error).toContain("invoice");
    });

    // ── Security: never accept arbitrary paths ─────────────────────────

    it("never reads a path directly from query params", async () => {
        const req = new Request(
            "http://localhost:3001/api/storage/invoice-pdf?path=../../.env",
        );
        const res = await GET(req);

        // Should NOT call downloadPDF with the injected path
        expect(downloadPDFMock).not.toHaveBeenCalled();
        // Should return 400 (neither id nor invoice provided)
        expect(res.status).toBe(400);
    });

    // ── DB error handling ──────────────────────────────────────────────

    it("returns 500 on DB lookup failure", async () => {
        supabaseChain.maybeSingle.mockResolvedValue({
            data: null,
            error: { message: "connection refused" },
        });

        const req = new Request(
            "http://localhost:3001/api/storage/invoice-pdf?id=eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        );
        const res = await GET(req);

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe("db lookup failed");
    });

    // ── Normalized vendor matching ─────────────────────────────────────

    it("passes vendor gate for normalized name match (e.g. 'Rootwise Compost' matches 'rootwise')", async () => {
        // isReceivingsPdfVendorMock already returns true by default
        supabaseChain.maybeSingle.mockResolvedValue({
            data: {
                id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                invoice_number: "INV-OK",
                vendor_name: "Rootwise Compost",
                pdf_storage_path: "local/storage/INVOICE/rw/ok.pdf",
            },
            error: null,
        });
        downloadPDFMock.mockResolvedValue(Buffer.from("ok"));

        const req = new Request(
            "http://localhost:3001/api/storage/invoice-pdf?id=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        );
        const res = await GET(req);

        expect(res.status).toBe(200);
    });
});