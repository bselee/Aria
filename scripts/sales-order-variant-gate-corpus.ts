// Run the real gate over the real corpus: what changes, and does it ever fire on
// a PO that Finale actually has?
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";
import { FinaleClient } from "../src/lib/finale/client";
import { isSalesOrderVariantPoRef } from "../src/lib/purchasing/po-ref-validator";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const rows = await c.query(`
        select po_number, status,
               coalesce(array_length(tracking_numbers, 1), 0) as n_tracking,
               (last_eta_update is not null and last_eta_update::text not in ('{}', 'null')) as has_eta
          from purchase_orders
         where po_number ~* 'dropship'`);

    let skip = 0, push = 0, skipWithEvidence = 0, pushWithEvidence = 0;
    const skipped: any[] = [];
    for (const r of rows.rows) {
        const gated = isSalesOrderVariantPoRef(r.po_number);
        if (gated) {
            skip++;
            if (r.n_tracking > 0 || r.has_eta) skipWithEvidence++;
            skipped.push(r);
        } else {
            push++;
            if (r.n_tracking > 0 || r.has_eta) pushWithEvidence++;
        }
    }
    console.log(`dropship rows: ${rows.rowCount}`);
    console.log(`gate fires (Finale push skipped): ${skip}`);
    console.log(`gate does not fire (push continues): ${push}`);
    console.log(`  of the skipped, carrying tracking/ETA evidence that used to trigger a 404 push: ${skipWithEvidence}`);
    console.log(`  of the pushed, carrying the same evidence: ${pushWithEvidence}`);

    // Anything the gate fires on that is NOT in the expected tails = collateral.
    const bad = skipped.filter((r) => !/-S[A-Z0-9-]*-Dropships?PO$/i.test(r.po_number));
    console.log(`collateral (gated but not a -S family tail): ${bad.length}`);
    for (const b of bad) console.log("  " + b.po_number);

    // The decisive cross-check: does the gate ever fire on a PO Finale has?
    const f = new FinaleClient();
    const sampleSkipped = skipped.filter((r) => r.n_tracking > 0).slice(0, 6);
    const pushSamples = rows.rows.filter((r: any) => !isSalesOrderVariantPoRef(r.po_number)).slice(-6);
    let skippedResolve = 0;
    for (const r of sampleSkipped) {
        try { await f.getOrderDetails(r.po_number); skippedResolve++; console.log(`  gated-but-resolves: ${r.po_number}`); }
        catch { /* expected 404 */ }
    }
    let pushFails = 0;
    for (const r of pushSamples) {
        try { await f.getOrderDetails(r.po_number); }
        catch { pushFails++; console.log(`  pushed-but-404: ${r.po_number}`); }
    }
    console.log(`gated rows that resolve in Finale: ${skippedResolve} of ${sampleSkipped.length}`);
    console.log(`non-gated rows that 404 in Finale: ${pushFails} of ${pushSamples.length}`);

    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
