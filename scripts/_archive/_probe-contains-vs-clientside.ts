// Prove the mechanism: the writer derives the PO's tracking column through
// PostgREST `.contains("po_numbers", [po])`; if that filter returns 0 rows the
// writer sets tracking_numbers = [] and wipes the column.
import { createClient } from "../src/lib/db";
import { Client } from "pg";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const PO = "23550677-DropshipPO";

(async () => {
    const db: any = createClient();

    const viaContains = await db
        .from("shipments")
        .select("tracking_number")
        .contains("po_numbers", [PO])
        .eq("active", true);
    console.log("PostgREST .contains ->", viaContains.data?.length ?? "ERR", viaContains.error?.message ?? "");

    const viaEq = await db.from("shipments").select("tracking_number").eq("active", true).limit(5000);
    const clientSide = (viaEq.data || []).filter((s: any) => (s.po_numbers || []).includes(PO));
    console.log("eq + client-side filter ->", clientSide.length, JSON.stringify(clientSide.map((s: any) => s.tracking_number)));

    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const raw = await c.query("select tracking_number from shipments where $1 = any(po_numbers) and active = true", [PO]);
    console.log("raw SQL any() ->", raw.rowCount, JSON.stringify(raw.rows.map((r) => r.tracking_number)));
    await c.end();
})().catch((e) => console.error("ERR", e?.message || e));
