// Before a "never push this shape to Finale" gate lands, measure the shape over
// the live corpus and check that no -S- row actually resolves in Finale.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";
import { FinaleClient } from "../src/lib/finale/client";

const GATE = /-S(?:[A-Z0-9]+)?-DropshipPO$/i;

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    // 1. Every distinct suffix tail on a dropship-shaped po_number, with counts.
    const shapes = await c.query(`
        select substring(po_number from '[^0-9]+$') as tail, count(*)::int n,
               count(*) filter (where status = 'open')::int open
          from purchase_orders
         where po_number ~* 'dropship'
         group by 1 order by 2 desc`);
    console.log("distinct dropship tails:");
    for (const r of shapes.rows) console.log(`  ${JSON.stringify(r.tail)}  n=${r.n} open=${r.open}`);

    // 2. Does aria-coder's proposed gate cover every live -S- row, and does it
    //    also catch anything that is NOT a sales-order variant?
    const gate = await c.query(`
        select count(*)::int matched from purchase_orders where po_number ~* '-S(?:[A-Z0-9]+)?-DropshipPO$'`);
    const sminus = await c.query(`
        select count(*)::int n from purchase_orders where po_number ~* '^(?:[0-9]{8})-S[A-Z0-9]*-DropshipPO$'`);
    console.log(`gate matches ${gate.rows[0].matched} rows; -S[A-Z0-9]*-DropshipPO matches ${sminus.rows[0].n}`);

    const nonmatching_s = await c.query(`
        select po_number from purchase_orders
         where po_number ~* 'dropship' and po_number ~* '-[A-Z0-9]*S[A-Z0-9]*-' and po_number !~* '-S(?:[A-Z0-9]+)?-DropshipPO$'`);
    if (nonmatching_s.rowCount) {
        console.log("rows containing an S segment that the gate would MISS:");
        for (const r of nonmatching_s.rows) console.log("  " + r.po_number);
    }

    // 3. The risk a blanket gate carries: does ANY -S- row resolve in Finale?
    const sample = await c.query(`
        (select po_number from purchase_orders where po_number ~* '-S(?:[A-Z0-9]+)?-DropshipPO$' order by created_at asc limit 8)
        union
        (select po_number from purchase_orders where po_number ~* '-S(?:[A-Z0-9]+)?-DropshipPO$' order by created_at desc limit 8)`);
    console.log(`\n--- Finale resolution for ${sample.rowCount} -S- rows (oldest 8 + newest 8) ---`);
    const f = new FinaleClient();
    let resolved = 0;
    for (const r of sample.rows) {
        try {
            const d: any = await f.getOrderDetails(r.po_number);
            resolved++;
            console.log(`  ${r.po_number}: RESOLVES type=${d?.orderTypeId}`);
        } catch (e: any) {
            console.log(`  ${r.po_number}: ${e.message.includes("404") ? "404" : e.message.slice(0, 40)}`);
        }
    }
    console.log(`resolved ${resolved} of ${sample.rowCount}`);

    // 4. Control: a few plain and letter rows must keep resolving, or the gate
    //    would be "fixing" a shape that already works.
    for (const pat of ["^[0-9]{8}-DropshipPO$", "^[0-9]{8}[A-Z]-DropshipPO$"]) {
        const one = await c.query(`select po_number from purchase_orders where po_number ~ '${pat}' order by created_at desc limit 3`);
        for (const r of one.rows) {
            try {
                const d: any = await f.getOrderDetails(r.po_number);
                console.log(`  control ${r.po_number}: OK type=${d?.orderTypeId}`);
            } catch (e: any) {
                console.log(`  control ${r.po_number}: ${e.message.includes("404") ? "404" : e.message.slice(0, 40)}`);
            }
        }
    }

    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
