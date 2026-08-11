/**
 * @file    api/storage/invoice-pdf/route.ts
 * @purpose Serves vendor invoice PDFs by database UUID or invoice number.
 *          GET ?id=<vendor_invoices.id> or ?invoice=<invoice_number>
 *
 *          Security: paths are resolved ONLY via database lookup —
 *          never from query params. DB is the single source of truth
 *          for what storage paths are valid.
 *
 *          Returns raw PDF bytes with inline disposition so the
 *          browser renders them rather than downloading.
 *
 * @author  Aria Coder
 * @created 2026-08-11
 * @deps    @/lib/db, @/lib/storage/supabase-storage
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/db";
import { downloadPDF } from "@/lib/storage/supabase-storage";
import { isReceivingsPdfVendor } from "@/config/receivings-pdf-vendors";

/**
 * GET /api/storage/invoice-pdf?id=<uuid>       (preferred)
 * GET /api/storage/invoice-pdf?invoice=<number> (fallback)
 *
 * Serves the stored PDF for a vendor invoice.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
    try {
        const { searchParams } = new URL(req.url);
        const id = searchParams.get("id");
        const invoiceNumber = searchParams.get("invoice");

        // ── Validate input ──────────────────────────────────────────────
        if (!id && !invoiceNumber) {
            return NextResponse.json(
                { error: "query param `id` (UUID) or `invoice` (invoice number) required" },
                { status: 400 },
            );
        }

        // ── DB lookup ───────────────────────────────────────────────────
        const db = createClient();
        let query = db
            .from("vendor_invoices")
            .select("id, invoice_number, vendor_name, pdf_storage_path");

        if (id) {
            query = query.eq("id", id);
        } else {
            query = query.eq("invoice_number", invoiceNumber!);
        }

        const { data: invoice, error: lookupError } = await query.maybeSingle();

        if (lookupError) {
            console.warn(
                `[invoice-pdf] DB lookup failed: ${lookupError?.message || lookupError}`,
            );
            return NextResponse.json(
                { error: "db lookup failed" },
                { status: 500 },
            );
        }

        if (!invoice) {
            return NextResponse.json(
                { error: "invoice not found" },
                { status: 404 },
            );
        }

        // ── Vendor gate: Receivings PDF scope only (list B) ────────────
        const vendorName: string = (invoice as any).vendor_name || "";

        if (!isReceivingsPdfVendor(vendorName)) {
            return NextResponse.json(
                { error: "vendor not in Receivings PDF scope" },
                { status: 403 },
            );
        }

        // ── Validate PDF exists in storage ──────────────────────────────
        const storagePath: string | null =
            (invoice as any).pdf_storage_path || null;

        if (!storagePath) {
            return NextResponse.json(
                { error: "no pdf on file" },
                { status: 404 },
            );
        }

        // ── Read PDF from local filesystem ──────────────────────────────
        const pdfBuffer = await downloadPDF(storagePath);

        if (!pdfBuffer) {
            return NextResponse.json(
                { error: "pdf file not found on disk" },
                { status: 404 },
            );
        }

        // ── Return PDF with proper headers ──────────────────────────────
        const invNumber: string = (invoice as any).invoice_number || "unknown";
        const filename = `inv-${invNumber}.pdf`;

        return new NextResponse(pdfBuffer, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${filename}"`,
                "Cache-Control": "private, max-age=300",
            },
        });
    } catch (err: any) {
        console.error(
            `[invoice-pdf] Unexpected error: ${err?.message || err}`,
        );
        return NextResponse.json(
            { error: "internal server error" },
            { status: 500 },
        );
    }
}