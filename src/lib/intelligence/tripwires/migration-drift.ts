/**
 * @file    migration-drift.ts
 * @purpose Tripwire: detect Supabase migrations on disk that have not been
 *          applied to the live database.
 *
 *          Pure function — caller injects the two list sources so we can
 *          unit test without hitting fs/Supabase. Default factory wires the
 *          real fs + supabase_migrations.schema_migrations table.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@/lib/supabase";

export type TripwireResult = {
    tripwire: string;
    ok: boolean;
    /** Human-readable summary used as the agent_task goal. */
    summary: string;
    /** Structured detail copied into agent_task.inputs. */
    detail: Record<string, unknown>;
    ranAt: string;
    /** Convenience for migration-drift specifically; empty when ok or on a crash. */
    unapplied: string[];
};

export type MigrationDriftDeps = {
    listOnDisk: () => Promise<string[]>;
    listApplied: () => Promise<string[]>;
};

export async function detectMigrationDrift(
    deps: MigrationDriftDeps = defaultMigrationDriftDeps(),
): Promise<TripwireResult> {
    const ranAt = new Date().toISOString();
    let onDisk: string[];
    let applied: string[];
    try {
        [onDisk, applied] = await Promise.all([deps.listOnDisk(), deps.listApplied()]);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            tripwire: "migration-drift",
            ok: false,
            summary: `tripwire crashed: ${msg}`,
            detail: { error: msg },
            ranAt,
            unapplied: [],
        };
    }

    const appliedSet = new Set(applied);
    const unapplied = onDisk.filter(f => !appliedSet.has(f)).sort();
    const ok = unapplied.length === 0;
    const head = unapplied.slice(0, 3).join(", ");
    const summary = ok
        ? "All migrations applied"
        : `${unapplied.length} migration(s) on disk not applied: ${head}${unapplied.length > 3 ? " …" : ""}`;
    return {
        tripwire: "migration-drift",
        ok,
        summary,
        detail: { unapplied },
        ranAt,
        unapplied,
    };
}

function defaultMigrationDriftDeps(): MigrationDriftDeps {
    return {
        listOnDisk: async () => {
            const dir = path.join(process.cwd(), "supabase", "migrations");
            const entries = await readdir(dir);
            return entries.filter(e => e.endsWith(".sql")).sort();
        },
        listApplied: async () => {
            const supabase = createClient();
            if (!supabase) throw new Error("Supabase not configured");
            const { data, error } = await supabase
                .schema("supabase_migrations")
                .from("schema_migrations")
                .select("version");
            if (error) throw error;
            // schema_migrations.version is the migration filename without
            // extension by Supabase convention. Reconstruct .sql names.
            return (data ?? []).map(r => `${(r as { version: string }).version}.sql`).sort();
        },
    };
}
