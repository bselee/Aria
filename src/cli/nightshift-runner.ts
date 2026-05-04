/**
 * @file    nightshift-runner.ts
 * @purpose CLI entry point for the nightshift pre-classification loop.
 *          Runs one batch per cycle, sleeps POLL_MS between cycles.
 *          Uses hosted Haiku; no local LLM service is required.
 *
 * Usage:
 *   node --import tsx src/cli/nightshift-runner.ts [--dry-run]
 *
 * Env vars:
 *   NIGHTSHIFT_POLL_MS       — poll interval in ms (default: 300000 = 5 min)
 *   NIGHTSHIFT_BATCH_SIZE    — tasks per cycle (default: 30)
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { runNightshiftLoop } from "../lib/intelligence/nightshift-agent";

const POLL_MS   = parseInt(process.env.NIGHTSHIFT_POLL_MS ?? String(5 * 60 * 1000));
const DRY_RUN   = process.argv.includes("--dry-run");
const BATCH     = parseInt(process.env.NIGHTSHIFT_BATCH_SIZE ?? "30");

const pollMin   = (POLL_MS / 60_000).toFixed(0);

console.log(`[nightshift-runner] Starting (dry-run=${DRY_RUN}). Poll=${pollMin}m, batch=${BATCH}, classifier=haiku`);

let running = true;
process.once("SIGTERM", () => {
    console.log("[nightshift-runner] SIGTERM received — stopping after current cycle");
    running = false;
});
process.once("SIGINT", () => {
    console.log("[nightshift-runner] SIGINT received — stopping after current cycle");
    running = false;
});

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    while (running) {
        try {
            await runNightshiftLoop({ dryRun: DRY_RUN });
        } catch (err: any) {
            console.error("[nightshift-runner] Unhandled error in loop (continuing):", err?.message ?? err);
        }

        if (!running) break;
        console.log(`[nightshift-runner] Sleeping ${pollMin}m until next cycle...`);
        await sleep(POLL_MS);
    }
    console.log("[nightshift-runner] Stopped.");
}

main().catch(err => {
    console.error("[nightshift-runner] Fatal:", err);
    process.exit(1);
});
