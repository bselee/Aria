/**
 * @file    scripts/cleanup-po125178-inferred-shipments.ts
 * @purpose One-shot cleanup: unlink email_ingest_inferred shipments from
 *          PO 125178 that absorbed 567 of 671 shipment rows via weak PO
 *          inference (score=1 single-token match). Clears po_numbers for
 *          those rows; does NOT delete them — tracking data is preserved.
 * @author  aria-coder (Hermes kanban t_7d8806de)
 * @created 2026-08-11
 * @deps    @/lib/db (createClient), .env.local (PGRST_URL etc.)
 * @env     PGRST_URL, PGRST_JWT_SECRET
 *
 * Usage:
 *   node --import tsx --env-file=.env.local scripts/cleanup-po125178-inferred-shipments.ts
 */

import { createClient } from "@/lib/db";

async function main() {
    const db = createClient();
    if (!db) {
        console.error("No DB client — check PGRST_URL in .env.local");
        process.exit(1);
    }

    const targetPO = "125178";

    // 1. Count rows to be affected
    // Use overlap (ov.) instead of contains (cs.) because the custom PostgREST
    // client in db.ts produces JSON array syntax for cs. which Postgres rejects
    // as a malformed array literal.  ov. uses curly-brace Postgres syntax.
    const { data: affected, count: countHeader, error: countErr } = await db
        .from("shipments")
        .select("*")
        .overlap("po_numbers", [targetPO])
        .eq("last_source", "email_ingest_inferred");

    if (countErr) {
        console.error("Count query failed:", countErr.message);
        process.exit(1);
    }

    const count = (affected || []).length;
    if (!count || count === 0) {
        console.log(`No email_ingest_inferred rows found for PO ${targetPO} — nothing to clean up.`);
        process.exit(0);
    }

    console.log(`Found ${count} email_ingest_inferred rows pointing at PO ${targetPO}.`);
    console.log(`Proceeding to clear po_numbers for these rows...`);

    // 2. Update each row to clear po_numbers
    //    PostgREST .eq + .contains doesn't support batch updates easily,
    //    so we update one by one. For 567 rows this is fine.
    let cleared = 0;
    let errors = 0;

    for (const row of affected || []) {
        const { error: updateErr } = await db
            .from("shipments")
            .update({
                po_numbers: [],
                updated_at: new Date().toISOString(),
            })
            .eq("tracking_key", row.tracking_key);

        if (updateErr) {
            console.error(`  FAILED ${row.tracking_key}: ${updateErr.message}`);
            errors++;
        } else {
            cleared++;
            if (cleared % 50 === 0) {
                console.log(`  Cleared ${cleared}/${count}...`);
            }
        }
    }

    console.log(`\nDone: cleared ${cleared} rows, ${errors} errors.`);

    // 3. Verify
    const { data: verifyData, error: verifyErr } = await db
        .from("shipments")
        .select("tracking_key")
        .overlap("po_numbers", [targetPO])
        .eq("last_source", "email_ingest_inferred");

    if (verifyErr) {
        console.error("Verification query failed:", verifyErr.message);
    } else {
        console.log(`Post-cleanup: ${(verifyData || []).length} email_ingest_inferred rows remain for PO ${targetPO}.`);
    }

    if (errors > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});