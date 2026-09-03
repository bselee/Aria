/**
 * @file    src/cli/clean-tracking-magnet.ts
 * @purpose Deactivate the PO 125178 inferred-PO magnet: 567 tracking links
 *          guessed onto one PO (Rootwise) across 6 carriers. These are wrong
 *          matches from the vendor-name-overlap inference. Retire them
 *          (active=false, unlink PO) so counts/board/Finale-sync stop seeing them.
 *
 *          --apply to write. Dry-run by default.
 * @author  Hermia
 * @created 2026-08-25
 */
import { createClient } from "@/lib/db";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = createClient();
  if (!db) { console.error("no db"); return; }

  // All inferred shipments linked to 125178
  const { data: rows } = await db
    .from("shipments")
    .select("id")
    .eq("last_source", "email_ingest_inferred")
    .overlap("po_numbers", ["125178"]);
  const ids = (rows || []).map((r: any) => r.id);
  console.log(`Inferred shipments linked to PO 125178: ${ids.length}`);

  // Also count inferred shipments linked to OTHER POs (leave alone for now)
  const { data: other } = await db
    .from("shipments")
    .select("id")
    .eq("last_source", "email_ingest_inferred")
    .not("po_numbers", "cs", "{}")
    .limit(1000);
  console.log(`All inferred shipments (incl. other POs): ${(other || []).length}`);

  if (!APPLY) {
    console.log(`\nDRY-RUN. Re-run with --apply to deactivate ${ids.length} rows.`);
    return;
  }

  // Deactivate + unlink
  let done = 0;
  for (const id of ids) {
    const { error } = await db
      .from("shipments")
      .update({ active: false, po_numbers: [] })
      .eq("id", id);
    if (error) {
      console.log(`  FAIL ${id}: ${error.message}`);
    } else {
      done++;
    }
  }
  console.log(`\nDeactivated ${done}/${ids.length} inferred shipments on PO 125178.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
