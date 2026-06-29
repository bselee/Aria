/**
 * @file    src/cli/obsidian-invoice-sync.ts
 * @purpose CLI tool that queries recent AP activity from Supabase and writes
 *          invoice summaries into the Obsidian vault. Designed to run as a
 *          cron job after the AP pipeline completes.
 *
 *          Bridge 1 of 3: Aria AP Pipeline → Obsidian Vault
 *
 * @author  Hermia
 * @created 2026-06-26
 * @deps    supabase, obsidian/bridge
 * @env     NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *          OBSIDIAN_VAULT_PATH
 */

import { createClient } from "../lib/supabase";
import {
    writeInvoiceSummary,
    syncInvoiceBatch,
    type InvoiceSummary,
} from "../lib/obsidian/bridge";

async function main() {
    const hoursBack = parseInt(process.argv[2] || "24", 10);
    const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();

    console.log(`[obsidian-invoice-sync] Syncing invoices since ${since} (${hoursBack}h back)`);

    const supabase = createClient();
    if (!supabase) {
        console.error("[obsidian-invoice-sync] Supabase not available — skipping sync.");
        process.exit(0); // Non-fatal — cron will retry next tick
    }

    // Query vendor_invoices table for recent entries
    const { data: invoices, error } = await supabase
        .from("vendor_invoices")
        .select("*")
        .gte("updated_at", since)
        .order("updated_at", { ascending: false })
        .limit(100);

    if (error) {
        console.error(`[obsidian-invoice-sync] Supabase query failed: ${error.message}`);
        process.exit(1);
    }

    if (!invoices || invoices.length === 0) {
        console.log("[obsidian-invoice-sync] No recent invoices to sync.");
        process.exit(0);
    }

    console.log(`[obsidian-invoice-sync] Found ${invoices.length} invoices to sync.`);

    // Map Supabase rows to InvoiceSummary format
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

    // Log paths for debugging
    for (const p of result.paths) {
        console.log(`  → ${p}`);
    }
}

main().catch((err) => {
    console.error("[obsidian-invoice-sync] Fatal:", err);
    process.exit(1);
});
