/**
 * Verifies that the side-effect import of jobs/index.ts registers every
 * expected job with a valid 5-field cron schedule and the default
 * America/Denver timezone.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { _resetRegistry, listJobs, getJob } from "../registry";

const EXPECTED_JOBS = [
    "ap-polling",
    "build-risk",
    "daily-summary",
    "weekly-summary",
    "nightshift-enqueue",
    "housekeeping",
    "stat-indexing",
    "po-sync",
    "qty-calibration",
    // KAIZEN #5: po-sweep folded into ap-polling as post-pass
    "build-completion-watcher",
    "po-receiving-watcher",
    "purchasing-calendar-sync",
    "missing-reconciliation-watchdog",
    "close-finished-tasks",
    "migration-tripwire",
    "task-self-healer",
    "issue-projection",
    "issue-orchestrator",
    "expire-stale-approvals",
    "vendor-lead-time-tracker",
];

beforeAll(async () => {
    _resetRegistry();
    await import("./index");
});

describe("cron/jobs/index registration", () => {
    it("registers every expected job", () => {
        const names = listJobs().map(j => j.name).sort();
        for (const expected of EXPECTED_JOBS) {
            expect(names, `missing job: ${expected}`).toContain(expected);
        }
    });

    it("every job has a valid 5-field cron schedule", () => {
        for (const job of listJobs()) {
            const exprs = Array.isArray(job.schedule) ? job.schedule : [job.schedule];
            expect(exprs.length, `${job.name} has no schedule`).toBeGreaterThan(0);
            for (const expr of exprs) {
                const fields = expr.trim().split(/\s+/);
                expect(fields, `bad schedule for ${job.name}: "${expr}"`).toHaveLength(5);
            }
        }
    });

    it("ap-polling morning window is 7:30 Denver; noon and 5pm stay on the hour", () => {
        expect(getJob("ap-polling")?.schedule).toEqual(["30 7 * * *", "0 12,17 * * *"]);
    });

    it("every job uses America/Denver tz", () => {
        for (const job of listJobs()) {
            expect(job.tz, `wrong tz for ${job.name}`).toBe("America/Denver");
        }
    });

    it("kaizen #4: po-sync runs every 4 hours", () => {
        expect(getJob("po-sync")?.schedule).toBe("0 */4 * * *");
    });

    it("kaizen #6: missing-reconciliation-watchdog is Mon-Fri only", () => {
        expect(getJob("missing-reconciliation-watchdog")?.schedule).toBe("0 9 * * 1-5");
    });
});
