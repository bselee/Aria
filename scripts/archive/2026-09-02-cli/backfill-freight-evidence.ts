/**
 * @file    backfill-freight-evidence.ts
 * @purpose Seed po_freight_evidence from historical vendor_invoices data.
 *          This feeds the auto-learning system so vendors get classified
 *          without waiting for future completions.
 *
 * Usage: node --import tsx --env-file=.env.local src/cli/backfill-freight-evidence.ts [--apply]
 */

import { createClient } from "@/lib/db";

async function main() {
    const apply = process.argv.includes("--apply");
    const db = createClient();
    if (!db) { console.error("No DB"); process.exit(1); }

    // Load all invoices with po_number
    const allInvoices: any[] = [];
    let offset = 0;
    while (true) {
        const { data } = await db
            .from("vendor_invoices")
            .select("po_number, vendor_name, freight, subtotal, total")
            .not("po_number", "is", null)
            .limit(1000)
            .offset(offset);
        const rows = data || [];
        allInvoices.push(...rows);
        if (rows.length < 1000) break;
        offset += 1000;
    }

    // Dedupe by po_number (keep latest)
    const byPO = new Map<string, any>();
    for (const inv of allInvoices) {
        if (!inv.po_number) continue;
        byPO.set(inv.po_number, inv);
    }

    // Load PO freight adjustments from purchase_orders
    const allPOs: any[] = [];
    offset = 0;
    while (true) {
        const { data } = await db
            .from("purchase_orders")
            .select("po_number, vendor_name, total")
            .limit(1000)
            .offset(offset);
        const rows = data || [];
        allPOs.push(...rows);
        if (rows.length < 1000) break;
        offset += 1000;
    }
    const poMap = new Map(allPOs.map(p => [p.po_number, p]));

    // Build evidence records
    const records: Array<{
        order_id: string;
        vendor_name: string;
        had_freight_on_po: boolean;
        invoice_freight: number;
        freight_matched: boolean;
        completed_by: string;
    }> = [];

    for (const [poNumber, inv] of byPO) {
        const po = poMap.get(poNumber);
        if (!po) continue;

        const invFreight = Number(inv.freight || 0);
        // We don't have PO freight adjustments in this query, so infer:
        // If invoice has freight > 0, the PO likely has a freight adjustment
        // (since the reconciliation process adds it). This is an approximation.
        const hadFreightOnPO = invFreight > 0;
        // For matching: if invoice has freight, assume it was applied to PO
        const freightMatched = invFreight > 0;

        records.push({
            order_id: poNumber,
            vendor_name: inv.vendor_name || po.vendor_name || "unknown",
            had_freight_on_po: hadFreightOnPO,
            invoice_freight: invFreight,
            freight_matched: freightMatched,
            completed_by: "manual",
        });
    }

    console.log(`Found ${records.length} PO-invoice pairs to seed`);
    
    // Group by vendor for summary
    const byVendor: Record<string, { total: number; withFreight: number }> = {};
    for (const r of records) {
        const v = r.vendor_name;
        if (!byVendor[v]) byVendor[v] = { total: 0, withFreight: 0 };
        byVendor[v].total++;
        if (r.invoice_freight > 0) byVendor[v].withFreight++;
    }
    
    console.log("\nVendor summary (top 15):");
    for (const [v, s] of Object.entries(byVendor).sort((a, b) => b[1].total - a[1].total).slice(0, 15)) {
        const pct = s.total > 0 ? ((s.withFreight / s.total) * 100).toFixed(0) : "0";
        console.log(`  ${v}: ${s.total} POs, ${s.withFreight} with freight (${pct}%)`);
    }

    if (!apply) {
        console.log("\nDRY RUN — pass --apply to write");
        return;
    }

    // Load existing order_ids so a re-run is idempotent. Since 20260827
    // added a UNIQUE constraint on order_id, a blind INSERT would fail on
    // any PO already seeded. Skip POs we already have evidence for.
    const existingIds = new Set<string>();
    {
        let off = 0;
        while (true) {
            const { data } = await db
                .from("po_freight_evidence")
                .select("order_id")
                .limit(1000)
                .offset(off);
            const rows = (data || []) as { order_id: string }[];
            for (const r of rows) if (r.order_id) existingIds.add(r.order_id);
            if (rows.length < 1000) break;
            off += 1000;
        }
    }
    const toInsert = records.filter(r => !existingIds.has(r.order_id));
    console.log(`\n${existingIds.size} existing POs already have evidence; inserting ${toInsert.length} new.`);

    // Upsert on order_id so a concurrent partial write can't duplicate.
    const BATCH = 50;
    let written = 0;
    for (let i = 0; i < toInsert.length; i += BATCH) {
        const batch = toInsert.slice(i, i + BATCH);
        const { error } = await db
            .from("po_freight_evidence")
            .upsert(batch, { onConflict: "order_id" });
        if (error) {
            console.error(`Batch ${i} error:`, error.message);
        } else {
            written += batch.length;
        }
    }

    console.log(`\nWrote ${written} evidence rows to po_freight_evidence`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
