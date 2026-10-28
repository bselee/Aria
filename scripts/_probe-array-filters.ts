// Find a PostgREST array filter that actually works against shipments.po_numbers
// (text[]), so the writer's PO-column derivation can stop blanking the column.
import { createClient } from "../src/lib/db";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const PO = "23550677-DropshipPO";

async function attempt(label: string, q: any) {
    const { data, error, count } = await q;
    console.log(
        `${label} -> rows=${data?.length ?? "null"} count=${count ?? "-"}${error ? ` ERROR ${error.code ?? ""} ${error.message}` : ""}`,
    );
}

(async () => {
    const db: any = createClient();
    await attempt("contains([PO])   ", db.from("shipments").select("tracking_number").contains("po_numbers", [PO]).eq("active", true));
    await attempt("overlaps([PO])   ", db.from("shipments").select("tracking_number").overlaps("po_numbers", [PO]).eq("active", true));
    await attempt("filter(cs,{PO})  ", db.from("shipments").select("tracking_number").filter("po_numbers", "cs", `{${PO}}`).eq("active", true));
    await attempt("filter(ov,{PO})  ", db.from("shipments").select("tracking_number").filter("po_numbers", "ov", `{${PO}}`).eq("active", true));
    const active = await db.from("shipments").select("tracking_number,po_numbers").eq("active", true).limit(2000);
    console.log(
        `eq(active).limit(2000) -> rows=${active.data?.length ?? "null"}${active.error ? ` ERROR ${active.error.code} ${active.error.message}` : ""}`,
    );
})().catch((e) => console.error("ERR", e?.message || e));
