/**
 * @file    restart-stale-pm2-proc.ts
 * @purpose Self-heal playbook — when an agent's heartbeat goes stale and
 *          the heartbeat-watcher writes an `agent_exception` task, run
 *          `pm2 restart <name>` and let normal heartbeat recovery confirm.
 *
 *          No DB writes — only a child process call. Always allowed
 *          (no env gate). Retryable on transient pm2 socket flakes.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Playbook } from "./types";

const execAsync = promisify(exec);

type Params = { procName: string };

// Only restart processes we explicitly know about. Defense against a
// malicious or buggy task row injecting `; rm -rf /` style payloads.
const ALLOWED_PROCS = new Set(["aria-bot", "aria-slack"]);

export const restartStalePm2Proc: Playbook<Params> = {
    kind: "restart_stale_pm2_proc",
    description: "pm2 restart on stale heartbeat",

    match(task) {
        if (task.type !== "agent_exception") return null;
        if (task.source_table !== "agent_heartbeats") return null;
        const inputs = task.inputs as { agent?: unknown; staleness?: unknown };
        if (typeof inputs.agent !== "string") return null;
        if (inputs.staleness !== "stale" && inputs.staleness !== "missing") return null;
        if (!ALLOWED_PROCS.has(inputs.agent)) return null;
        return { procName: inputs.agent };
    },

    async attempt(params, ctx) {
        try {
            const { stdout } = await execAsync(`pm2 restart ${params.procName}`);
            ctx.log(`pm2 restart ${params.procName} ok`, { stdout: stdout.slice(0, 200) });
            return {
                ok: true,
                summary: `pm2 restarted ${params.procName}`,
                detail: { stdout },
            };
        } catch (err) {
            return {
                ok: false,
                retryable: true, // pm2 socket flakes are transient
                error: err instanceof Error ? err.message : String(err),
            };
        }
    },
};
