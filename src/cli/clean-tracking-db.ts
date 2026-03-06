/**
 * Clean up false positive tracking numbers stored in purchase_orders.
 * Removes entries with < 2 digits (word false positives like "information", "duction").
 * Safe to re-run.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "../lib/supabase";

const dryRun = process.argv.includes("--dry-run");

async function main() {
    const supabase = createClient();
    if (!supabase) { console.error("Supabase unavailable"); process.exit(1); }

    const { data, error } = await supabase
        .from("purchase_orders")
        .select("po_number, tracking_numbers")
        .not("tracking_numbers", "eq", "{}");

    if (error) { console.error(error.message); process.exit(1); }

    let cleaned = 0;
    for (const po of data ?? []) {
        const good = po.tracking_numbers.filter((t: string) => (t.match(/\d/g)?.length ?? 0) >= 2);
        const bad = po.tracking_numbers.filter((t: string) => (t.match(/\d/g)?.length ?? 0) < 2);
        if (bad.length === 0) continue;

        console.log(`PO #${po.po_number}: removing [${bad.join(", ")}], keeping [${good.join(", ")}]`);
        if (!dryRun) {
            await supabase.from("purchase_orders").update({
                tracking_numbers: good,
                updated_at: new Date().toISOString(),
            }).eq("po_number", po.po_number);
            cleaned++;
        }
    }

    console.log(`\n${dryRun ? "[DRY RUN] " : ""}Cleaned ${cleaned} PO(s).`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
