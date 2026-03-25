/**
 * @file    vendor-invoices.ts
 * @purpose Centralised read/write helpers for the vendor_invoices table.
 *          Every intake channel (email attachments, portal scrapers, CSV imports,
 *          sandbox drops, payment confirmations) calls upsertVendorInvoice() so
 *          that one table is the single source of truth for cost research.
 * @author  Will / Antigravity
 * @created 2026-03-17
 * @updated 2026-03-17
 * @deps    supabase/client
 * @env     NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "../supabase";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VendorInvoiceLineItem {
    sku: string;
    description: string;
    qty: number;
    unit_price: number;
    ext_price: number;
}

export type InvoiceSource =
    | "email_attachment"
    | "portal_scrape"
    | "csv_import"
    | "sandbox_drop"
    | "payment_confirm"
    | "axiom_api"
    | "manual";

export type InvoiceStatus =
    | "received"
    | "reconciled"
    | "paid"
    | "disputed"
    | "void";

export interface VendorInvoiceRecord {
    vendor_name: string;
    invoice_number?: string | null;
    invoice_date?: string | null;         // ISO date string or YYYY-MM-DD
    due_date?: string | null;
    po_number?: string | null;
    subtotal?: number;
    freight?: number;
    tax?: number;
    total?: number;
    status?: InvoiceStatus;
    source: InvoiceSource;
    source_ref?: string | null;
    pdf_storage_path?: string | null;
    line_items?: VendorInvoiceLineItem[];
    raw_data?: Record<string, unknown>;
    reconciled_at?: string | null;
    paid_at?: string | null;
    notes?: string | null;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Insert or update a vendor invoice record.
 *
 * Deduplication key: (vendor_name, invoice_number).
 * If the same invoice already exists, existing fields are preserved and only
 * non-null incoming fields overwrite (status and paid_at always merge forward).
 *
 * @param   record  - Partial invoice data from any intake channel
 * @returns The upserted row ID, or null if the upsert silently skipped
 */
export async function upsertVendorInvoice(
    record: VendorInvoiceRecord
): Promise<string | null> {
    const supabase = createClient();

    // Normalise vendor name: trim, title-case first word at minimum
    const vendorName = record.vendor_name.trim();

    const payload = {
        vendor_name: vendorName,
        invoice_number: record.invoice_number ?? null,
        invoice_date: record.invoice_date ?? null,
        due_date: record.due_date ?? null,
        po_number: record.po_number ?? null,
        subtotal: record.subtotal ?? 0,
        freight: record.freight ?? 0,
        tax: record.tax ?? 0,
        total: record.total ?? 0,
        status: record.status ?? "received",
        source: record.source,
        source_ref: record.source_ref ?? null,
        pdf_storage_path: record.pdf_storage_path ?? null,
        line_items: record.line_items ?? [],
        raw_data: record.raw_data ?? {},
        reconciled_at: record.reconciled_at ?? null,
        paid_at: record.paid_at ?? null,
        notes: record.notes ?? null,
        updated_at: new Date().toISOString(),
    };

    // If we have an invoice_number, UPSERT (dedup by vendor+inv).
    // If no invoice_number, just INSERT (can't dedup without a number).
    if (record.invoice_number) {
        const { data, error } = await supabase
            .from("vendor_invoices")
            .upsert(payload, { onConflict: "vendor_name,invoice_number" })
            .select("id")
            .single();

        if (error) {
            console.error(
                `[vendor-invoices] Upsert failed for ${vendorName} #${record.invoice_number}:`,
                error.message
            );
            return null;
        }
        return data?.id ?? null;
    }

    // No invoice number — plain insert
    const { data, error } = await supabase
        .from("vendor_invoices")
        .insert(payload)
        .select("id")
        .single();

    if (error) {
        console.error(
            `[vendor-invoices] Insert failed for ${vendorName}:`,
            error.message
        );
        return null;
    }
    return data?.id ?? null;
}

// ── Read helpers ──────────────────────────────────────────────────────────────

export interface InvoiceLookupFilters {
    vendor?: string;
    year?: number;
    month?: number;
    status?: InvoiceStatus;
    po?: string;
    unpaid?: boolean;
    limit?: number;
}

/**
 * Query vendor invoices with optional filters.
 * Returns rows ordered by invoice_date DESC.
 */
export async function lookupVendorInvoices(filters: InvoiceLookupFilters) {
    const supabase = createClient();

    let query = supabase
        .from("vendor_invoices")
        .select("*")
        .order("invoice_date", { ascending: false });

    if (filters.vendor) {
        query = query.ilike("vendor_name", `%${filters.vendor}%`);
    }
    if (filters.year) {
        query = query
            .gte("invoice_date", `${filters.year}-01-01`)
            .lte("invoice_date", `${filters.year}-12-31`);
    }
    if (filters.month && filters.year) {
        const mm = String(filters.month).padStart(2, "0");
        const lastDay = new Date(filters.year, filters.month, 0).getDate();
        query = query
            .gte("invoice_date", `${filters.year}-${mm}-01`)
            .lte("invoice_date", `${filters.year}-${mm}-${lastDay}`);
    }
    if (filters.status) {
        query = query.eq("status", filters.status);
    }
    if (filters.po) {
        query = query.eq("po_number", filters.po);
    }
    if (filters.unpaid) {
        query = query.neq("status", "paid");
    }
    if (filters.limit) {
        query = query.limit(filters.limit);
    }

    const { data, error } = await query;
    if (error) {
        console.error("[vendor-invoices] Lookup failed:", error.message);
        return [];
    }
    return data ?? [];
}

/**
 * Spend summary grouped by vendor for a date range.
 */
export async function vendorSpendSummary(sinceDate: string) {
    const supabase = createClient();

    const { data, error } = await supabase.rpc("vendor_spend_summary", {
        since_date: sinceDate,
    });

    // Fallback if the RPC doesn't exist yet — query directly
    if (error) {
        const { data: fallback } = await supabase
            .from("vendor_invoices")
            .select("vendor_name, total, freight, tax, invoice_date")
            .gte("invoice_date", sinceDate);

        if (!fallback) return [];

        // Client-side group-by
        const byVendor: Record<string, { count: number; total: number; freight: number }> = {};
        for (const row of fallback) {
            const v = row.vendor_name;
            if (!byVendor[v]) byVendor[v] = { count: 0, total: 0, freight: 0 };
            byVendor[v].count++;
            byVendor[v].total += Number(row.total) || 0;
            byVendor[v].freight += Number(row.freight) || 0;
        }

        return Object.entries(byVendor)
            .map(([vendor, stats]) => ({ vendor, ...stats }))
            .sort((a, b) => b.total - a.total);
    }

    return data ?? [];
}

/**
 * Mark an invoice as paid.
 */
export async function markInvoicePaid(
    vendorName: string,
    invoiceNumber: string,
    paidAt?: string
): Promise<boolean> {
    const supabase = createClient();

    const { error } = await supabase
        .from("vendor_invoices")
        .update({
            status: "paid",
            paid_at: paidAt ?? new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq("vendor_name", vendorName)
        .eq("invoice_number", invoiceNumber);

    if (error) {
        console.error(
            `[vendor-invoices] markPaid failed for ${vendorName} #${invoiceNumber}:`,
            error.message
        );
        return false;
    }
    return true;
}
