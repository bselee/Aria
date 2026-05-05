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
    "reconcile-axiom",
    "reconcile-fedex",
    "reconcile-teraganix",
    "reconcile-uline",
    "build-completion-watcher",
    "po-receiving-watcher",
    "purchasing-calendar-sync",
    "missing-reconciliation-watchdog",
    "close-finished-tasks",
    "migration-tripwire",
    "task-self-healer",
    "issue-projection",
    "issue-orchestrator",
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
            const fields = job.schedule.trim().split(/\s+/);
            expect(fields, `bad schedule for ${job.name}: "${job.schedule}"`).toHaveLength(5);
        }
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
