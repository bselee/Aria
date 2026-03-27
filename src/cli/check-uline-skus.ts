import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { FinaleClient } from "../lib/finale/client";

const CANDIDATES = [
    "S-15625",  // confirmed OK
    "S-2835",   // was S-28357 (7 is start of description "7 X 8"")
    "S-4092",   // was S-409 (9 is start of description "9 X 5 X 5"")
    "S-409",    // also check original
    "S-4796",
    "S-4128",
    "S-4551",
    "ULS455",
    "S-6771",
];

async function main() {
    const client = new FinaleClient();
    for (const sku of CANDIDATES) {
        const ok = await client.validateProductExists(sku);
        console.log(`${ok ? "✅" : "❌"} ${sku}`);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
