/**
 * @file    src/cli/inspect-exceptions.ts
 * @purpose List pending ops_agent_exceptions; optional --resolve-all to clear.
 * @author  Hermia
 * @created 2026-07-13
 * @deps    dotenv, ../lib/db
 * @env     .env.local
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "../lib/db";

const resolveAll = process.argv.includes("--resolve-all");

async function main() {
    const db = createClient();
    if (!db) throw new Error("no db");

    const { data, error } = await db
        .from("ops_agent_exceptions")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(50);

    if (error) throw error;
    const rows = (data || []) as Array<Record<string, unknown>>;
    console.log(
        JSON.stringify(
            {
                count: rows.length,
                rows: rows.map((r) => ({
                    id: r.id,
                    agent_name: r.agent_name,
                    created_at: r.created_at,
                    summary: r.summary || r.message || r.error_message || r.title,
                    keys: Object.keys(r),
                })),
            },
            null,
            2,
        ),
    );

    if (resolveAll && rows.length > 0) {
        const ids = rows.map((r) => r.id as string);
        const payload: Record<string, unknown> = {
            status: "resolved",
        };
        // try optional columns
        const sample = rows[0];
        if ("resolved_at" in sample) payload.resolved_at = new Date().toISOString();
        if ("resolution_notes" in sample) {
            payload.resolution_notes =
                "auto-resolved: local PostgREST recovery cleanup 2026-07-13";
        }
        const { error: uerr } = await db
            .from("ops_agent_exceptions")
            .update(payload)
            .in("id", ids);
        if (uerr) {
            const { error: u2 } = await db
                .from("ops_agent_exceptions")
                .update({ status: "resolved" })
                .in("id", ids);
            if (u2) throw u2;
        }
        console.log(JSON.stringify({ resolved: ids.length }));
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
