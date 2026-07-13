/**
 * @file    src/cli/drain-stale-ops.ts
 * @purpose Mark abandoned nightshift queue rows + stale ops exceptions so
 *          ops_health_summary stops permanent-red from multi-day backlog.
 * @author  Hermia
 * @created 2026-07-13
 * @deps    dotenv, ../lib/db
 * @env     .env.local
 *
 * nightshift_queue status CHECK: pending|processing|completed|failed
 * Default: fail nightshift pending older than 48h; resolve ops_agent_exceptions older than 7d.
 * Pass --dry-run to preview only.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "../lib/db";

const dryRun = process.argv.includes("--dry-run");

async function main() {
    const db = createClient();
    if (!db) throw new Error("PostgREST client unavailable");

    const nightshiftCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const exceptionCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: nq, error: nqErr } = await db
        .from("nightshift_queue")
        .select("id,status,created_at,updated_at")
        .in("status", ["pending", "processing"])
        .lt("created_at", nightshiftCutoff)
        .limit(500);

    if (nqErr) throw nqErr;
    const nightshiftRows = (nq || []) as Array<{ id: string; status: string }>;
    console.log(
        JSON.stringify({
            nightshift_stale_count: nightshiftRows.length,
            cutoff: nightshiftCutoff,
            dryRun,
        }),
    );

    if (!dryRun && nightshiftRows.length > 0) {
        const ids = nightshiftRows.map((r) => r.id);
        const { error } = await db
            .from("nightshift_queue")
            .update({
                status: "failed",
                error: "stale >48h — drained after local-db recovery 2026-07-13",
                updated_at: new Date().toISOString(),
                processed_at: new Date().toISOString(),
                result: {
                    drained_by: "drain-stale-ops",
                    reason: "stale_backlog",
                    at: new Date().toISOString(),
                },
            })
            .in("id", ids);
        if (error) throw error;
        console.log(JSON.stringify({ nightshift_failed: ids.length }));
    }

    // ops_agent_exceptions drives pending_exception_count in ops_health_summary
    const { data: ex, error: exErr } = await db
        .from("ops_agent_exceptions")
        .select("id,status,created_at,agent_name")
        .eq("status", "pending")
        .lt("created_at", exceptionCutoff)
        .limit(200);

    if (exErr) {
        console.log(JSON.stringify({ ops_agent_exceptions: "skip", error: exErr.message }));
    } else {
        const rows = (ex || []) as Array<{ id: string; agent_name?: string }>;
        console.log(
            JSON.stringify({
                exceptions_stale_count: rows.length,
                cutoff: exceptionCutoff,
                dryRun,
                sample: rows.slice(0, 5),
            }),
        );
        if (!dryRun && rows.length > 0) {
            const { error: uerr } = await db
                .from("ops_agent_exceptions")
                .update({
                    status: "resolved",
                    resolved_at: new Date().toISOString(),
                    resolution_notes: "auto-resolved stale pending after local-db recovery",
                })
                .in(
                    "id",
                    rows.map((r) => r.id),
                );
            if (uerr) {
                // fallback without optional columns
                const { error: u2 } = await db
                    .from("ops_agent_exceptions")
                    .update({ status: "resolved" })
                    .in(
                        "id",
                        rows.map((r) => r.id),
                    );
                if (u2) throw u2;
            }
            console.log(JSON.stringify({ exceptions_resolved: rows.length }));
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
