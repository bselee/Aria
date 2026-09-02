/**
 * @file    src/cli/backfill-po-links.ts
 * @purpose Reverse-match unlinked shipments → POs using the strongest signal:
 *          tracking numbers already in vendor_invoices or purchase_orders.
 *
 *          This is the same logic added to email-tracking-ingest.ts as Fallback 1.
 *          Run this CLI to retroactively link existing unlinked shipments.
 *
 *          Dry-run by default. Pass `--apply` to write po_numbers and trigger
 *          syncLegacyPurchaseOrderTracking (which pushes to Finale).
 *
 * @author  Hermia
 * @created 2026-08-26
 * @env     PGRST_URL, DATABASE_URL
 */

import { createClient } from "@/lib/db";
import { syncLegacyPurchaseOrderTracking } from "@/lib/tracking/shipment-intelligence";

const APPLY = process.argv.includes("--apply");

async function main() {
    const db = createClient();
    if (!db) {
        console.error("No PostgREST client available");
        process.exit(1);
    }

    // Load all active unlinked shipments
    const allUnlinked: any[] = [];
    let offset = 0;
    while (true) {
        const { data } = await db
            .from("shipments")
            .select("id, tracking_number, carrier_name, last_source, created_at")
            .eq("active", true)
            .limit(1000)
            .offset(offset);
        const rows = data || [];
        for (const row of rows as any[]) {
            if (!row.po_numbers || row.po_numbers.length === 0) {
                allUnlinked.push(row);
            }
        }
        if (rows.length < 1000) break;
        offset += 1000;
    }

    console.log(`Active unlinked shipments: ${allUnlinked.length}`);

    // For each, check if the tracking number exists in vendor_invoices or purchase_orders
    const matches: Array<{ shipment: any; poNumber: string; source: string }> = [];
    const noMatch: any[] = [];

    for (const shipment of allUnlinked) {
        const rawNum = shipment.tracking_number || "";
        const normalized = rawNum.includes(":::") ? rawNum.split(":::")[1].trim() : rawNum;
        if (!normalized || normalized.length < 8) {
            noMatch.push(shipment);
            continue;
        }

        let foundPO: string | null = null;
        let source = "";

        // Check vendor_invoices
        try {
            const { data: invMatch } = await db
                .from("vendor_invoices")
                .select("po_number")
                .not("po_number", "is", null)
                .or(`tracking_numbers.cs.{${normalized}},tracking_numbers.cs.{"${normalized}"}`)
                .limit(1);
            if (invMatch && invMatch.length > 0 && invMatch[0].po_number) {
                foundPO = invMatch[0].po_number;
                source = "vendor_invoices";
            }
        } catch { /* non-fatal */ }

        // Check purchase_orders
        if (!foundPO) {
            try {
                const { data: poMatch } = await db
                    .from("purchase_orders")
                    .select("po_number")
                    .or(`tracking_numbers.cs.{${normalized}},tracking_numbers.cs.{"${normalized}"}`)
                    .limit(1);
                if (poMatch && poMatch.length > 0 && poMatch[0].po_number) {
                    foundPO = poMatch[0].po_number;
                    source = "purchase_orders";
                }
            } catch { /* non-fatal */ }
        }

        if (foundPO) {
            matches.push({ shipment, poNumber: foundPO, source });
        } else {
            noMatch.push(shipment);
        }
    }

    // Report
    console.log(`\n=== RESULTS ===`);
    console.log(`Matched: ${matches.length}`);
    console.log(`No match: ${noMatch.length}`);
    console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);

    // Group by source
    const bySource: Record<string, number> = {};
    for (const m of matches) {
        bySource[m.source] = (bySource[m.source] || 0) + 1;
    }
    console.log(`\nBy source:`);
    for (const [src, count] of Object.entries(bySource)) {
        console.log(`  ${src}: ${count}`);
    }

    // Show matches
    console.log(`\nMatches:`);
    for (const m of matches) {
        console.log(`  ${m.shipment.carrier_name}: ${m.shipment.tracking_number?.slice(0, 35)} → PO ${m.poNumber} (${m.source})`);
    }

    // Apply
    if (APPLY) {
        console.log(`\nApplying ${matches.length} matches...`);
        let applied = 0;
        let failed = 0;

        for (const m of matches) {
            try {
                const { data: current } = await db
                    .from("shipments")
                    .select("po_numbers")
                    .eq("id", m.shipment.id)
                    .single();

                const existingPOs = (current as any)?.po_numbers || [];
                if (existingPOs.includes(m.poNumber)) continue;

                const newPOs = [...existingPOs, m.poNumber];
                const { error } = await db
                    .from("shipments")
                    .update({ po_numbers: newPOs })
                    .eq("id", m.shipment.id);

                if (error) {
                    console.warn(`  FAIL ${m.shipment.id}: ${error.message}`);
                    failed++;
                    continue;
                }

                try {
                    await syncLegacyPurchaseOrderTracking(m.poNumber);
                } catch (syncErr: any) {
                    console.warn(`  Sync warn for PO ${m.poNumber}: ${syncErr.message}`);
                }

                applied++;
            } catch (err: any) {
                console.warn(`  ERROR ${m.shipment.id}: ${err.message}`);
                failed++;
            }
        }

        console.log(`\nApplied: ${applied}/${matches.length} (${failed} failed)`);
    } else {
        console.log(`\nRe-run with --apply to write po_numbers + sync to Finale.`);
    }
}

main().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
});