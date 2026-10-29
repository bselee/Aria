// Which po_number shapes resolve in Finale, and how many live rows are affected?
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
import { FinaleClient } from "../src/lib/finale/client";
import { Client } from "pg";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const shapes = await c.query(`
        select case
                 when po_number ~ '^[0-9]{8}-S-DropshipPO$' then 'suffix -S-DropshipPO'
                 when po_number ~ '^[0-9]{8}-DropshipPO$'  then 'plain -DropshipPO'
                 when po_number ~ '^[0-9]{8}[A-Z]-DropshipPO$' then 'letter -X-DropshipPO'
                 when po_number ~* 'dropship' then 'other dropship'
                 else 'not dropship' end shape,
               count(*)::int n,
               count(*) filter (where status = 'open')::int open
          from purchase_orders group by 1 order by 2 desc`);
    console.log("PG po_number shapes:", JSON.stringify(shapes.rows, null, 1));

    const f = new FinaleClient();
    const tries: string[] = [];
    for (const r of shapes.rows) tries.push(r.shape);

    const sample = await c.query(`
        select po_number from purchase_orders
         where po_number ~ '^[0-9]{8}-S-DropshipPO$' and status='open'
         order by created_at desc limit 6`);
    const samplePlain = await c.query(`
        select po_number from purchase_orders
         where po_number ~ '^[0-9]{8}-DropshipPO$' and status='open'
         order by created_at desc limit 6`);

    console.log("\n--- -S- samples in Finale ---");
    for (const r of sample.rows) {
        const id = r.po_number;
        const base = id.replace("-S-DropshipPO", "");
        let a = "?", b = "?", cc = "?";
        try { await f.getOrderDetails(id); a = "OK"; } catch (e: any) { a = e.message.includes("404") ? "404" : e.message.slice(0, 40); }
        try { await f.getOrderDetails(`${base}-DropshipPO`); b = "OK"; } catch (e: any) { b = e.message.includes("404") ? "404" : e.message.slice(0, 40); }
        try { await f.getOrderDetails(base); cc = "OK"; } catch (e: any) { cc = e.message.includes("404") ? "404" : e.message.slice(0, 40); }
        console.log(`${id}: as-is=${a} as-plain=${b} as-salesorder=${cc}`);
    }

    console.log("\n--- plain samples in Finale ---");
    for (const r of samplePlain.rows) {
        const id = r.po_number;
        let a = "?";
        try { await f.getOrderDetails(id); a = "OK"; } catch (e: any) { a = e.message.includes("404") ? "404" : e.message.slice(0, 40); }
        console.log(`${id}: as-is=${a}`);
    }
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
