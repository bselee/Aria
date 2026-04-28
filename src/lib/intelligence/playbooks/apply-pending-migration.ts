/**
 * @file    apply-pending-migration.ts
 * @purpose Self-heal playbook — when migration-drift tripwire fires with
 *          a list of unapplied filenames, run each through the project's
 *          existing _run_migration.js script.
 *
 *          Operates on the live DB. Gated on PLAYBOOK_ALLOW_DB_WRITE=1.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { Playbook, PlaybookResult } from "./types";

type Params = { filenames: string[] };

export const applyPendingMigration: Playbook<Params> = {
    kind: "apply_pending_migration",
    description: "Apply migration files surfaced by the migration-drift tripwire",

    match(task) {
        if (task.type !== "tripwire_violation") return null;
        if (task.source_id !== "migration-drift") return null;
        const unapplied = (task.inputs as { unapplied?: unknown }).unapplied;
        if (!Array.isArray(unapplied) || unapplied.length === 0) return null;
        const filenames = unapplied.filter((x): x is string => typeof x === "string");
        if (filenames.length === 0) return null;
        return { filenames };
    },

    async attempt(params, ctx) {
        if (!ctx.allow.dbWrite) {
            return {
                ok: false,
                retryable: false,
                error: "PLAYBOOK_ALLOW_DB_WRITE must be set to run this playbook",
            };
        }
        const applied: string[] = [];
        for (const f of params.filenames) {
            const fullPath = path.join("supabase", "migrations", f);
            const result = await runMigrationScript(fullPath);
            ctx.log(`migration ${f}: ${result.ok ? "applied" : "failed"}`, { stderr: result.stderr.slice(0, 200) });
            if (!result.ok) {
                return {
                    ok: false,
                    retryable: false, // SQL errors don't fix themselves on retry
                    error: `Migration ${f} failed: ${result.stderr.slice(0, 200)}`,
                    detail: { applied, failed: f, stderr: result.stderr },
                };
            }
            applied.push(f);
        }
        return {
            ok: true,
            summary: `Applied ${applied.length} migration(s)`,
            detail: { applied },
        };
    },
};

async function runMigrationScript(file: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        const child = spawn(process.execPath, ["_run_migration.js", file], {
            cwd: process.cwd(),
            env: process.env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", d => { stdout += d.toString(); });
        child.stderr?.on("data", d => { stderr += d.toString(); });
        child.on("close", code => resolve({ ok: code === 0, stdout, stderr }));
    });
}
