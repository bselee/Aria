/**
 * @file    seed-vendor-aliases.ts
 * @purpose Auto-populates the vendor_aliases table by matching `vendor_name` from 
 *          existing invoice archives that successfully matched a `po_number`
 *          against the actual Finale supplier name for that PO.
 *
 * @usage   node --import tsx src/cli/seed-vendor-aliases.ts
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "../lib/supabase";
import { FinaleClient } from "../lib/finale/client";

async function run() {
    const supabase = createClient();
    const finale = new FinaleClient();

    console.log("🔍 Scanning vendor_invoices for verified PO matches...");

    // Find all invoices that have a po_number
    const { data: invoices, error: invErr } = await supabase
        .from("vendor_invoices")
        .select("vendor_name, po_number")
        .not("po_number", "is", null);

    if (invErr) {
        console.error("❌ Failed to fetch vendor_invoices:", invErr);
        process.exit(1);
    }

    if (!invoices || invoices.length === 0) {
        console.log("⚠️ No invoices with PO numbers found. Run backfill first.");
        process.exit(0);
    }

    // Group by vendor_name -> po_number to minimize API calls
    const poByVendor = new Map<string, string>();
    for (const inv of invoices) {
        if (!poByVendor.has(inv.vendor_name)) {
            poByVendor.set(inv.vendor_name, inv.po_number!);
        }
    }

    console.log(`📊 Found ${poByVendor.size} unique vendors with assigned POs. Validating with Finale...`);

    let added = 0;
    let skipped = 0;

    for (const [vendorName, poNumber] of poByVendor.entries()) {
        try {
            // Fetch the PO from Finale to get the exact supplier name
            const poSummary = await finale.getOrderSummary(poNumber);
            if (!poSummary || !poSummary.supplier) {
                console.warn(`⚠️ PO ${poNumber} for vendor "${vendorName}" not found in Finale. Skipping.`);
                skipped++;
                continue;
            }

            const finaleSupplier = poSummary.supplier.trim();

            // Insert into vendor_aliases
            const { error: upsertErr } = await supabase
                .from("vendor_aliases")
                .upsert({
                    alias: vendorName.trim(),
                    finale_supplier_name: finaleSupplier,
                }, { onConflict: "alias" });

            if (upsertErr) {
                console.error(`❌ DB error inserting alias "${vendorName}" -> "${finaleSupplier}":`, upsertErr.message);
                skipped++;
            } else {
                console.log(`✅ Seeded alias: "${vendorName}" -> "${finaleSupplier}"`);
                added++;
            }

        } catch (e: any) {
            console.error(`❌ Error processing vendor "${vendorName}" (PO: ${poNumber}):`, e.message);
            skipped++;
        }
    }

    console.log("\n✅ Seeding complete.");
    console.log(`   Added/Updated: ${added}`);
    console.log(`   Skipped/Failed: ${skipped}`);
}

run();
