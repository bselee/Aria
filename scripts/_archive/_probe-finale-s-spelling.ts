// Is the -S- id a spelling mismatch (Finale has 23582767S-DropshipPO) or a missing PO?
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
import { FinaleClient } from "../src/lib/finale/client";

const BASE = "23582767";
const CANDS = [
    `${BASE}-S-DropshipPO`, `${BASE}S-DropshipPO`, `${BASE}-DropshipPO`, `${BASE}S`,
    `${BASE}-1-DropshipPO`, `${BASE}-SF1-DropshipPO`, `${BASE}SF1-DropshipPO`,
];

(async () => {
    const f = new FinaleClient();
    for (const id of CANDS) {
        try {
            const d: any = await f.getOrderDetails(id);
            console.log(`${id}: OK type=${d?.orderTypeId}`);
        } catch (e: any) { console.log(`${id}: ${e.message.includes("404") ? "404" : e.message.slice(0, 50)}`); }
    }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
