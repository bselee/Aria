// Annotate an outbound-freight row: say WHY it has no PO, so the next agent
// does not "repair" a carrier order ref into a phantom PO link.
//
// Usage: node --import tsx --env-file=.env.local scripts/annotate-outbound-freight.ts <PRO> "<annotation>" [--apply]
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const pro = args[0];
const note = args[1];
if (!pro || !note) {
    console.log('usage: <PRO> "<annotation>" [--apply]');
    process.exit(0);
}

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const b = await pg.query(
        "select tracking_number, status_category, status_display, po_numbers from shipments where normalized_tracking_number = $1",
        [pro],
    );
    if (!b.rowCount) {
        console.log(`${pro}: no PG row`);
        return;
    }
    const row = b.rows[0];
    console.log("before:", JSON.stringify(row));
    // Never invent a PO link, and never let an annotation claim a delivery we
    // do not have evidence for.
    if (row.po_numbers?.length) {
        console.log(`${pro}: row already cites ${JSON.stringify(row.po_numbers)} — refusing to overwrite a live link`);
        await pg.end();
        return;
    }
    const prefix = row.status_category === "delivered" && /^Delivered /.test(String(row.status_display || ""))
        ? String(row.status_display).split(" — ")[0] + " — "
        : "";
    const display = prefix + note;

    if (!APPLY) {
        console.log("would set:", display);
        await pg.end();
        return;
    }
    const r = await pg.query("update shipments set status_display = $2 where normalized_tracking_number = $1", [pro, display]);
    const db = new Database("aria-local.db");
    const c = db
        .prepare("update shipments_cache set status_display = ?, updated_at = ? where tracking_number = ?")
        .run(display, new Date().toISOString(), row.tracking_number);
    db.close();
    console.log(`pg ${r.rowCount} row(s), cache ${c.changes} row(s)`);
    console.log("after:", JSON.stringify((await pg.query("select status_display from shipments where normalized_tracking_number = $1", [pro])).rows[0]));
    await pg.end();
})().catch((e) => console.error("ERR", e?.message || e));
