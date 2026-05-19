/** One-shot: delete today's PO_ARRIVAL_AT_RISK rows so the re-tick is clean.
 *  node --import tsx src/cli/purge-stale-po-risk-rows.ts
 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@/lib/supabase";

async function main() {
    const sb = createClient();
    if (!sb) throw new Error("supabase not configured");
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const { data, error } = await sb
        .from("ap_activity_log")
        .delete()
        .eq("intent", "PO_ARRIVAL_AT_RISK")
        .gte("created_at", today.toISOString())
        .select("id");
    if (error) throw error;
    console.log(`deleted ${data?.length ?? 0} stale rows`);
    process.exit(0);
}

main().catch((e) => {
    console.error("err:", e?.message ?? e);
    process.exit(1);
});
