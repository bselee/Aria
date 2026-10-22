// Audit: every shipment citing a BARE 235xxxxx ref - is it a PO or a Finale SALES_ORDER?
import { Client } from "pg";
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { FinaleClient } from "../src/lib/finale/client";

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const rows = await c.query(
    `select po, count(*) filter (where active) active_rows, count(*) rows
       from (select unnest(po_numbers) po, active from shipments) s
      where po ~ '^235[0-9]{5}$'
      group by po order by po`,
  );
  console.log(`bare 235xxxxx refs cited by shipments: ${rows.rows.length}`);
  const f = new FinaleClient();
  const verdicts: Record<string, string> = {};
  for (const r of rows.rows) {
    let type = "NOT_FOUND";
    try {
      const d: any = await f.getOrderDetails(r.po);
      type = `${d?.orderTypeId}/${d?.statusId}`;
    } catch {
      type = "404";
    }
    verdicts[r.po] = type;
    console.log(`${r.po} rows=${r.rows} active=${r.active_rows} -> ${type}`);
  }
  const sales = rows.rows.filter((r: any) => String(verdicts[r.po]).startsWith("SALES_ORDER"));
  console.log(`\nSALES_ORDER refs (must not live in po_numbers): ${sales.length}`);
  for (const s of sales) console.log(`  ${s.po} rows=${s.rows} active=${s.active_rows} ${verdicts[s.po]}`);
  await c.end();
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
