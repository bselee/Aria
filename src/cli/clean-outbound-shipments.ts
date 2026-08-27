/**
 * @file    src/cli/clean-outbound-shipments.ts
 * @purpose Deactivate outbound BAS shipments that were incorrectly ingested
 *          as inbound vendor shipments. These come from FedEx/UPS billing
 *          invoice emails (noreply@fedex.com, noreply@ups.com) which contain
 *          tracking numbers for packages BAS SENT to customers, not vendor
 *          shipments coming in.
 *
 *          The email-tracking-ingest cron was picking these up because the
 *          search query matches "shipped OR tracking". The SKIP_SENDER_DOMAINS
 *          fix prevents new ones, but existing ones need cleanup.
 *
 *          --apply to write. Dry-run by default.
 *
 * @author  Hermia
 * @created 2026-08-26
 * @env     PGRST_URL, DATABASE_URL
 */

import { createClient } from "@/lib/db";

const APPLY = process.argv.includes("--apply");

// FedEx billing email message IDs that contain outbound shipment tracking
const BILLING_EMAIL_IDS = [
    "gmail:ap:1a036799c6a989ef",  // 849 shipments
    "gmail:ap:1a012d7914e9862f",  // 679 shipments
    "gmail:ap:1a0145183a6bb63e",  // 107 shipments
    "gmail:ap:1a03679a866d7a51",  // 98 shipments
];

async function main() {
    const db = createClient();
    if (!db) {
        console.error("No PostgREST client available");
        process.exit(1);
    }

    // Find all active shipments from these billing emails
    const allBilling: any[] = [];
    let offset = 0;
    while (true) {
        const { data } = await db
            .from("shipments")
            .select("id, tracking_number, carrier_name, source_refs, po_numbers, last_source")
            .eq("active", true)
            .limit(1000)
            .offset(offset);
        const rows = data || [];
        for (const row of rows as any[]) {
            const refs = (row.source_refs || []).map((r: any) => r.sourceRef);
            const isBilling = refs.some((r: string) => BILLING_EMAIL_IDS.includes(r));
            if (isBilling) {
                allBilling.push(row);
            }
        }
        if (rows.length < 1000) break;
        offset += 1000;
    }

    console.log(`Outbound BAS shipments from billing emails: ${allBilling.length}`);

    // Group by carrier
    const byCarrier: Record<string, number> = {};
    for (const s of allBilling) {
        const c = s.carrier_name || "null";
        byCarrier[c] = (byCarrier[c] || 0) + 1;
    }
    console.log(`\nBy carrier:`);
    for (const [carrier, count] of Object.entries(byCarrier).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${carrier}: ${count}`);
    }

    // Check how many are linked to POs (shouldn't be, but verify)
    const linked = allBilling.filter((s: any) => (s.po_numbers || []).length > 0);
    console.log(`\nLinked to POs: ${linked.length}`);
    if (linked.length > 0) {
        console.log(`  (these will be unlinked)`);
        for (const s of linked.slice(0, 5)) {
            console.log(`  ${s.tracking_number} → PO ${JSON.stringify(s.po_numbers)}`);
        }
    }

    console.log(`\nMode: ${APPLY ? "APPLY (deactivate + unlink)" : "DRY-RUN (no writes)"}`);

    if (APPLY) {
        console.log(`\nDeactivating ${allBilling.length} outbound shipments...`);
        let done = 0;
        let failed = 0;

        for (const s of allBilling) {
            const { error } = await db
                .from("shipments")
                .update({ active: false, po_numbers: [] })
                .eq("id", s.id);

            if (error) {
                console.warn(`  FAIL ${s.id}: ${error.message}`);
                failed++;
            } else {
                done++;
            }
        }

        console.log(`\nDeactivated: ${done}/${allBilling.length} (${failed} failed)`);
    } else {
        console.log(`\nRe-run with --apply to deactivate these outbound shipments.`);
    }
}

main().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
});