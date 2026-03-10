/**
 * @file    dropship-store.ts
 * @purpose Supabase-backed store for unmatched invoices pending dropship forwarding.
 *          C4 FIX: Previously in-memory with setTimeout expiry — lost on pm2 restart,
 *          making Telegram buttons dead links with no error.
 *          Now persists metadata to Supabase `pending_dropships` table.
 *          base64Pdf stays in memory (too large for DB); on restart, we re-fetch from Gmail.
 *
 * @author  Aria
 * @created 2026-02-27
 * @updated 2026-03-10
 */

import { createClient } from "../supabase";

export interface PendingDropship {
    id: string;
    invoiceNumber: string;
    vendorName: string;
    total: number;
    subject: string;
    from: string;
    filename: string;
    base64Pdf: string;
    createdAt: number;
}

/** In-memory cache for base64Pdf (too large for Supabase JSONB) */
const pdfCache = new Map<string, string>();

/**
 * Store a dropship invoice for later forwarding.
 * C4 FIX: Persists metadata to Supabase. PDF stays in memory only.
 */
export async function storePendingDropship(data: Omit<PendingDropship, 'id' | 'createdAt'>): Promise<string> {
    const id = `drop_${data.invoiceNumber.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    // Cache the PDF in memory for same-session retrieval
    pdfCache.set(id, data.base64Pdf);

    // Persist metadata to Supabase (survives restart)
    try {
        const supabase = createClient();
        if (supabase) {
            await supabase.from("pending_dropships").upsert({
                id,
                invoice_number: data.invoiceNumber,
                vendor_name: data.vendorName,
                total: data.total,
                subject: data.subject,
                email_from: data.from,
                filename: data.filename,
                status: "pending",
                expires_at: expiresAt.toISOString(),
            }, { onConflict: "id" });
        }
    } catch (err: any) {
        console.warn(`[dropship-store] Failed to persist ${id} to Supabase: ${err.message}`);
    }

    return id;
}

/**
 * Retrieve a pending dropship by ID.
 * C4 FIX: Reads from Supabase if not in memory (survives restart).
 * Note: base64Pdf will be empty after restart — caller must handle re-fetch.
 */
export async function getPendingDropship(id: string): Promise<PendingDropship | null> {
    // Check Supabase for metadata
    try {
        const supabase = createClient();
        if (supabase) {
            const { data } = await supabase.from("pending_dropships")
                .select("*")
                .eq("id", id)
                .eq("status", "pending")
                .gt("expires_at", new Date().toISOString())
                .single();

            if (!data) return null;

            return {
                id: data.id,
                invoiceNumber: data.invoice_number,
                vendorName: data.vendor_name,
                total: parseFloat(data.total) || 0,
                subject: data.subject || "",
                from: data.email_from || "",
                filename: data.filename || "",
                base64Pdf: pdfCache.get(id) || "",  // Empty after restart
                createdAt: new Date(data.created_at).getTime(),
            };
        }
    } catch { /* fall through */ }

    return null;
}

/**
 * Mark a dropship as forwarded (not deleted — preserves audit trail).
 * C4 FIX: Updates Supabase status instead of deleting.
 */
export async function removePendingDropship(id: string): Promise<void> {
    pdfCache.delete(id);
    try {
        const supabase = createClient();
        if (supabase) {
            await supabase.from("pending_dropships")
                .update({ status: "forwarded" })
                .eq("id", id);
        }
    } catch { /* non-blocking */ }
}

/**
 * Returns all pending dropship entries (for "Please forward" text fallback).
 * C4 FIX: Reads from Supabase so state survives restart.
 */
export async function getAllPendingDropships(): Promise<PendingDropship[]> {
    try {
        const supabase = createClient();
        if (!supabase) return [];

        const { data } = await supabase.from("pending_dropships")
            .select("*")
            .eq("status", "pending")
            .gt("expires_at", new Date().toISOString())
            .order("created_at", { ascending: false });

        if (!data) return [];

        return data.map((row: any) => ({
            id: row.id,
            invoiceNumber: row.invoice_number,
            vendorName: row.vendor_name,
            total: parseFloat(row.total) || 0,
            subject: row.subject || "",
            from: row.email_from || "",
            filename: row.filename || "",
            base64Pdf: pdfCache.get(row.id) || "",
            createdAt: new Date(row.created_at).getTime(),
        }));
    } catch {
        return [];
    }
}
