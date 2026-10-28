// Battery for the PO tracking-column derivation (the `.contains` → `.overlaps`
// fix and its fail-closed guard).
//
// The defect: supabase-js serialises `.contains("po_numbers", [po])` as a JSON
// array; PostgREST wants a PG array literal, so the read 400s (22P02), the
// writer treated null data as "no shipments" and wrote tracking_numbers = []
// over a populated column. 71 of 174 POs with active shipments were empty.
//
// This battery pins three things over the LIVE corpus, not fixtures:
//   A. `.overlaps` returns exactly the rows raw SQL returns, for every PO that
//      has active shipments — the derivation source is now correct.
//   B. `.contains` still 400s with 22P02 (if PostgREST ever starts accepting it,
//      this case flips and a human re-reads the fix rather than assuming).
//   C. the projection the writer uses actually resolves — a valid filter over a
//      missing column would fail closed forever and the column would never fill.
//
// Then D: census of stored-vs-derived, which is the repair list. Exits non-zero
// while any PO's column disagrees with the shipments table.
import { createClient } from "../src/lib/db";
import { Client } from "pg";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const WRITER_COLUMNS = "tracking_number, public_tracking_url";

type Case = { name: string; ok: boolean; detail?: string };
const cases: Case[] = [];
const push = (name: string, ok: boolean, detail?: string) => {
    cases.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

(async () => {
    const db: any = createClient();
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    // ---- C. the writer's projection must resolve -------------------------
    const proj = await db
        .from("shipments")
        .select(WRITER_COLUMNS)
        .eq("active", true)
        .limit(1);
    push(
        "writer projection (tracking_number, public_tracking_url) resolves",
        !proj.error,
        proj.error ? `${proj.error.code ?? ""} ${proj.error.message}` : "",
    );
    const hasUrlColumn = !proj.error;

    // ---- B. `.contains` on text[] is still the broken filter --------------
    const containsProbe = await db
        .from("shipments")
        .select("tracking_number")
        .contains("po_numbers", ["125298"])
        .eq("active", true);
    const containsMsg = String(containsProbe.error?.message ?? "");
    push(
        ".contains('po_numbers', [..]) still rejects with 22P02 (fix still needed)",
        /22P02|malformed array literal/.test(containsMsg),
        containsMsg ? containsMsg.slice(0, 90) : "contains unexpectedly succeeded — re-read the fix",
    );

    // ---- A. overlaps == raw SQL, over the live corpus --------------------
    const pop = await pg.query(`
        select distinct po.po_number
          from purchase_orders po
          join shipments s on po.po_number = any(s.po_numbers) and s.active
         order by 1`);
    const poNumbers: string[] = pop.rows.map((r) => r.po_number);
    push("corpus: POs with active shipments enumerated", poNumbers.length > 0, `${poNumbers.length} POs`);

    let mismatches = 0;
    const checked: string[] = [];
    for (const po of poNumbers) {
        const sqlRows = await pg.query(
            "select tracking_number from shipments where $1 = any(po_numbers) and active",
            [po],
        );
        const sqlSet = sqlRows.rows.map((r: any) => r.tracking_number).sort().join("|");

        const cols = hasUrlColumn ? WRITER_COLUMNS : "tracking_number";
        const or = await db.from("shipments").select(cols).overlaps("po_numbers", [po]).eq("active", true);
        if (or.error) {
            mismatches++;
            if (mismatches <= 5) console.log(`  FAIL ${po}: overlaps error ${or.error.message}`);
            continue;
        }
        const orSet = (or.data || []).map((r: any) => r.tracking_number).sort().join("|");
        if (orSet !== sqlSet) {
            mismatches++;
            if (mismatches <= 5) console.log(`  FAIL ${po}: overlaps=[${orSet}] sql=[${sqlSet}]`);
        }
        checked.push(po);
    }
    push(
        "A. overlaps() rowset == raw SQL any() for every PO with active shipments",
        mismatches === 0,
        `${checked.length}/${poNumbers.length} agree, ${mismatches} mismatch`,
    );

    // ---- D. census: stored column vs derived set -------------------------
    // Phantom-shaped rows (null vendor) are excluded from the defect count: the
    // shipments table may legitimately cite a number that is not a PO, and
    // decorating a phantom row with tracking is not a repair.
    const census = await pg.query(`
        select po.po_number, po.vendor_name, po.status,
               coalesce(array_length(po.tracking_numbers,1),0) stored_n,
               (select count(*) from shipments s where s.active and po.po_number = any(s.po_numbers))::int derived_n
          from purchase_orders po
         where exists (select 1 from shipments s where s.active and po.po_number = any(s.po_numbers))`);
    const realRows = census.rows.filter((r: any) => (r.vendor_name ?? "").trim() !== "");
    const phantomRows = census.rows.filter((r: any) => (r.vendor_name ?? "").trim() === "");
    const disagree = realRows.filter((r: any) => r.stored_n !== r.derived_n);
    const blanked = disagree.filter((r: any) => r.stored_n === 0);
    push(
        "D. stored tracking_numbers agrees with the shipments table (real POs)",
        disagree.length === 0,
        `${realRows.length} real POs checked, ${disagree.length} disagree (${blanked.length} blanked); ` +
            `${phantomRows.length} null-vendor rows excluded as phantom residue`,
    );
    if (disagree.length) {
        for (const r of disagree.slice(0, 12))
            console.log(`  ${r.po_number}: stored=${r.stored_n} derived=${r.derived_n}`);
        if (disagree.length > 12) console.log(`  … ${disagree.length - 12} more`);
        console.log(`  repair: scripts/rebuild-po-tracking-column.ts ${disagree.map((r: any) => r.po_number).join(" ")} --apply`);
    }

    await pg.end();
    const failed = cases.filter((c) => !c.ok).length;
    console.log(`\n${cases.length} cases, ${failed} defects`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error("ERR", e?.message || e);
    process.exit(1);
});
