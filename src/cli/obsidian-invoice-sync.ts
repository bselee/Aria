/**
 * @file    src/cli/obsidian-invoice-sync.ts
 * @purpose CLI tool that queries recent AP activity from the local database
 *          and writes invoice summaries into the Obsidian vault. Designed to
 *          run as a cron job after the AP pipeline completes.
 *
 *          Bridge 1 of 3: AP Pipeline → Obsidian Vault
 *
 *          Uses local PostgREST (port 5434) for vendor_invoices queries.
 *          No cloud Supabase — fully local.
 *
 * @author  Hermia
 * @created 2026-06-26
 * @updated 2026-07-15 — migrated from Supabase to local PostgREST
 * @deps    @/lib/db (PostgREST client), @/lib/obsidian/bridge
 * @env     PGRST_URL (default: http://localhost:5434)
 */
import { createClient } from "../lib/db";
import {
    writeInvoiceSummary,
    syncInvoiceBatch,
    type InvoiceSummary,
} from "../lib/obsidian/bridge";

async function main() {
    const hoursBack = parseInt(process.argv[2] || "24", 10);
    const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();

    console.log(`[obsidian-invoice-sync] Syncing invoices since ${since} (${hoursBack}h back)`);

    const db = createClient();
    if (!db) {
        console.error("[obsidian-invoice-sync] Local PostgREST not available — skipping sync.");
        process.exit(0);
    }

    // Query vendor_invoices table for recent entries via PostgREST
    const { data: invoices, error } = await db
        .from("vendor_invoices")
        .select("*")
        .gte("updated_at", since)
        .order("updated_at", { ascending: false })
        .limit(100);

    if (error) {
        console.error(`[obsidian-invoice-sync] Query failed: ${error.message}`);
        process.exit(1);
    }

    if (!invoices || invoices.length === 0) {
        console.log("[obsidian-invoice-sync] No recent invoices to sync.");
        process.exit(0);
    }

    console.log(`[obsidian-invoice-sync] Found ${invoices.length} invoices to sync.`);

    // Map rows to InvoiceSummary format
    const summaries: InvoiceSummary[] = invoices.map((inv: any) => ({
        vendorName: inv.vendor_name || "Unknown",
        invoiceNumber: inv.invoice_number || "unknown",
        invoiceDate: inv.invoice_date || new Date().toISOString().split("T")[0],
        dueDate: inv.due_date,
        poNumber: inv.po_number,
        total: Number(inv.total) || 0,
        subtotal: Number(inv.subtotal) || 0,
        freight: Number(inv.freight) || 0,
        tax: Number(inv.tax) || 0,
        status: inv.status || "received",
        lineItemCount: Array.isArray(inv.line_items) ? inv.line_items.length : 0,
        source: inv.source || "unknown",
        reconciledAt: inv.reconciled_at,
        notes: inv.notes,
    }));

    const result = syncInvoiceBatch(summaries);

    console.log(
        `[obsidian-invoice-sync] Done: ${result.succeeded} synced, ${result.failed} failed.`
    );

    for (const p of result.paths) {
        console.log(`  → ${p}`);
    }
}

main().catch((err) => {
    console.error("[obsidian-invoice-sync] Fatal:", err);
    process.exit(1);
});
