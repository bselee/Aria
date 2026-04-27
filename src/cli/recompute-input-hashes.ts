/**
 * @file    recompute-input-hashes.ts
 * @purpose One-shot script to recompute agent_task.input_hash for every row
 *          using the canonical TS form (matches what `incrementOrCreate`
 *          computes for new rows).
 *
 * WHY THIS EXISTS
 *
 * 20260501_hygiene_backfill.sql populated input_hash via a SQL canonical form
 * (`digest(string_agg(key||':'||value::text, ',' ORDER BY key), 'sha256')`)
 * that does NOT match the TypeScript canonicalize() form in
 * src/lib/intelligence/agent-task-hash.ts. As a result, dedup-on-insert
 * (incrementOrCreate looking up an existing row by input_hash) cannot match
 * any backfilled row — every "same signal" creates a new hub row instead of
 * incrementing the existing dedup_count.
 *
 * Postgres cannot easily produce text matching TS canonicalize because
 * JSONB::text inserts spaces after `:` and `,`. The cleanest fix is to
 * recompute input_hash from TS via this one-shot script.
 *
 * USAGE
 *
 *   node --import tsx src/cli/recompute-input-hashes.ts          # dry-run by default
 *   node --import tsx src/cli/recompute-input-hashes.ts --apply  # actually UPDATE
 *
 * The dry-run prints a sample of (id, old_hash → new_hash) per row so you
 * can verify the transform looks right before committing.
 *
 * IDEMPOTENT — safe to re-run. The TS hash for a given inputs JSONB is
 * deterministic; rows already at the correct hash will UPDATE-no-op.
 *
 * Loads .env.local for SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "../lib/supabase";
import { inputHash } from "../lib/intelligence/agent-task-hash";

const PAGE_SIZE = 200;

async function main() {
    const apply = process.argv.includes("--apply");
    if (!apply) {
        console.log("[recompute-input-hashes] DRY RUN — pass --apply to commit changes.");
    }

    const supabase = createClient();
    if (!supabase) {
        console.error("[recompute-input-hashes] Supabase client unavailable. Check .env.local for SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL.");
        process.exit(1);
    }

    let totalScanned = 0;
    let totalChanged = 0;
    let totalUnchanged = 0;
    let totalErrors = 0;
    const samples: Array<{ id: string; old: string; new_: string }> = [];

    let offset = 0;
    while (true) {
        const { data: rows, error } = await supabase
            .from("agent_task")
            .select("id, inputs, input_hash")
            .order("created_at", { ascending: true })
            .range(offset, offset + PAGE_SIZE - 1);

        if (error) {
            console.error(`[recompute-input-hashes] page fetch failed at offset=${offset}: ${error.message}`);
            process.exit(2);
        }
        if (!rows || rows.length === 0) break;

        for (const row of rows) {
            totalScanned++;
            const inputs = (row.inputs ?? {}) as Record<string, unknown>;
            const newHash = inputHash(inputs);

            if (newHash === row.input_hash) {
                totalUnchanged++;
                continue;
            }

            if (samples.length < 5) {
                samples.push({ id: row.id, old: row.input_hash ?? "(null)", new_: newHash });
            }

            if (apply) {
                const { error: updErr } = await supabase
                    .from("agent_task")
                    .update({ input_hash: newHash })
                    .eq("id", row.id);
                if (updErr) {
                    totalErrors++;
                    console.warn(`[recompute-input-hashes] UPDATE failed for id=${row.id}: ${updErr.message}`);
                } else {
                    totalChanged++;
                }
            } else {
                totalChanged++; // count what WOULD change in dry-run
            }
        }

        if (rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    console.log("");
    console.log(`[recompute-input-hashes] scanned: ${totalScanned}`);
    console.log(`[recompute-input-hashes] would change: ${totalChanged}${apply ? " (UPDATEs applied)" : " (dry-run, no UPDATEs)"}`);
    console.log(`[recompute-input-hashes] already correct: ${totalUnchanged}`);
    if (totalErrors > 0) {
        console.log(`[recompute-input-hashes] errors: ${totalErrors}`);
    }

    if (samples.length > 0) {
        console.log("");
        console.log("Sample transforms:");
        for (const s of samples) {
            console.log(`  ${s.id}`);
            console.log(`    old: ${s.old}`);
            console.log(`    new: ${s.new_}`);
        }
    }

    if (!apply && totalChanged > 0) {
        console.log("");
        console.log("Re-run with --apply to commit changes.");
    }

    process.exit(totalErrors > 0 ? 3 : 0);
}

main().catch((err) => {
    console.error("[recompute-input-hashes] fatal:", err);
    process.exit(99);
});
