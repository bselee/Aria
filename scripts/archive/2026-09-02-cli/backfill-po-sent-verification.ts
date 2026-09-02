/**
 * @file    backfill-po-sent-verification.ts
 * @purpose One-shot scan of bill.selee@buildasoil.com `label:PO` outbox.
 *          For every PO email found, write `purchase_orders.po_sent_verified_at`
 *          unless a higher-confidence verification source already exists.
 *          Idempotent — safe to re-run.
 *
 * Usage:
 *   node --import tsx src/cli/backfill-po-sent-verification.ts [daysBack=365] [maxResults=500]
 */

import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

import { backfillPOSentVerificationFromGmail } from "../lib/intelligence/po-correlator";

async function main() {
    const daysBack = parseInt(process.argv[2] || "365", 10);
    const maxResults = parseInt(process.argv[3] || "500", 10);

    console.log(`🔁 Starting PO sent-verification backfill: daysBack=${daysBack} maxResults=${maxResults}`);
    const result = await backfillPOSentVerificationFromGmail(daysBack, maxResults);
    console.log("\n📊 Backfill summary:");
    console.log(`   Scanned:  ${result.scanned}`);
    console.log(`   Matched:  ${result.matched}`);
    console.log(`   Inserted: ${result.inserted}`);
    console.log(`   Skipped:  ${result.skipped}`);
    console.log(`   Errors:   ${result.errors}`);

    if (result.matchedPOs.length > 0) {
        console.log("\n✅ First 10 verified POs:");
        for (const po of result.matchedPOs.slice(0, 10)) {
            console.log(`   PO #${po.poNumber} — ${po.vendorName} (sent ${po.sentDate.slice(0, 10)})`);
        }
    }

    process.exit(0);
}

main().catch(err => {
    console.error("❌ Backfill failed:", err.message);
    console.error(err.stack);
    process.exit(1);
});
