/**
 * @file    src/cli/run-stale-crons.ts
 * @purpose Manually kick the stale Aria crons after local-DB recovery.
 * @author  Hermia
 * @created 2026-07-13
 * @deps    dotenv, cron/jobs (side-effect register), cron/runner
 * @env     .env.local
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import "../cron/jobs";
import { runJobOnce } from "../cron/runner";

const JOBS = [
    "ap-polling",
    "po-sync",
    "purchasing-calendar-sync",
    "stat-indexing",
];

async function main() {
    for (const name of JOBS) {
        const started = Date.now();
        try {
            const result = await runJobOnce(name, "manual");
            console.log(
                JSON.stringify({
                    job: name,
                    status: result.status,
                    durationMs: result.durationMs ?? Date.now() - started,
                    failureReason: result.failureReason ?? null,
                    failureMessage: result.failureMessage ?? null,
                }),
            );
        } catch (err: any) {
            console.log(
                JSON.stringify({
                    job: name,
                    status: "error",
                    durationMs: Date.now() - started,
                    failureMessage: err?.message || String(err),
                }),
            );
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
