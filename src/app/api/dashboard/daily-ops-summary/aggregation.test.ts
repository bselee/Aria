/**
 * @file    daily-ops-summary-aggregation.test.ts
 * @purpose Unit tests for the cron-run aggregation logic in the
 *          daily-ops-summary API route.  Extracted as a pure function
 *          so it can be tested without Next.js runtime.
 * @author  Hermia
 * @created 2026-07-30
 * @deps    vitest
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Aggregation logic — mirrors src/app/api/dashboard/daily-ops-summary/route.ts
// ---------------------------------------------------------------------------
interface CronRun {
    task_name: string;
    status: string;
    id: number;
}

interface CronSummary {
    totalRuns: number;
    failedJobs: string[];
    successJobs: number;
    unknownRuns: number;
}

function aggregateCronRuns(data: CronRun[]): CronSummary {
    /**
     * Status vocabulary: running, succeeded, failed, cancelled, skipped,
     * plus legacy success/error, plus 'unknown' (fabricated telemetry from
     * an old unfiltered-UPDATE bug — NOT a real failure).
     */
    const cronFails: string[] = [];
    const cronSuccess = new Set<string>();
    let cronUnknown = 0;

    for (const run of data) {
        const s = run.status;
        if (s === "failed" || s === "error") {
            cronFails.push(run.task_name);
        } else if (s === "succeeded" || s === "success") {
            cronSuccess.add(run.task_name);
        } else if (s === "unknown") {
            cronUnknown++;
        }
        // running, cancelled, skipped → excluded from totals
    }

    return {
        totalRuns: data.length,
        failedJobs: [...new Set(cronFails)],
        successJobs: cronSuccess.size,
        unknownRuns: cronUnknown,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aggregateCronRuns", () => {

    it("counts succeeded runs as successes", () => {
        const runs: CronRun[] = [
            { task_name: "check-email", status: "succeeded", id: 1 },
            { task_name: "process-ap", status: "succeeded", id: 2 },
        ];
        const result = aggregateCronRuns(runs);
        expect(result.totalRuns).toBe(2);
        expect(result.successJobs).toBe(2);
        expect(result.failedJobs).toEqual([]);
        expect(result.unknownRuns).toBe(0);
    });

    it("counts failed runs as failures", () => {
        const runs: CronRun[] = [
            { task_name: "check-email", status: "failed", id: 1 },
            { task_name: "process-ap", status: "error", id: 2 },
        ];
        const result = aggregateCronRuns(runs);
        expect(result.totalRuns).toBe(2);
        expect(result.failedJobs).toEqual(["check-email", "process-ap"]);
        expect(result.successJobs).toBe(0);
        expect(result.unknownRuns).toBe(0);
    });

    it("deduplicates repeated failures of the same job", () => {
        const runs: CronRun[] = [
            { task_name: "check-email", status: "failed", id: 1 },
            { task_name: "check-email", status: "failed", id: 2 },
        ];
        const result = aggregateCronRuns(runs);
        expect(result.failedJobs).toEqual(["check-email"]);
        expect(result.successJobs).toBe(0);
    });

    it("deduplicates repeated successes of the same job", () => {
        const runs: CronRun[] = [
            { task_name: "check-email", status: "succeeded", id: 1 },
            { task_name: "check-email", status: "succeeded", id: 2 },
        ];
        const result = aggregateCronRuns(runs);
        expect(result.successJobs).toBe(1);
        expect(result.failedJobs).toEqual([]);
    });

    it("treats legacy 'success'/'error' statuses correctly", () => {
        const runs: CronRun[] = [
            { task_name: "check-email", status: "success", id: 1 },
            { task_name: "process-ap", status: "error", id: 2 },
        ];
        const result = aggregateCronRuns(runs);
        expect(result.successJobs).toBe(1);
        expect(result.failedJobs).toEqual(["process-ap"]);
        expect(result.unknownRuns).toBe(0);
    });

    it("excludes unknown status from both success and failure counts", () => {
        const runs: CronRun[] = [
            { task_name: "check-email", status: "unknown", id: 1 },
            { task_name: "process-ap", status: "unknown", id: 2 },
        ];
        const result = aggregateCronRuns(runs);
        expect(result.totalRuns).toBe(2);
        expect(result.successJobs).toBe(0);
        expect(result.failedJobs).toEqual([]);
        expect(result.unknownRuns).toBe(2);
    });

    it("excludes running, cancelled, skipped from success/failure counts", () => {
        const runs: CronRun[] = [
            { task_name: "check-email", status: "running", id: 1 },
            { task_name: "process-ap", status: "cancelled", id: 2 },
            { task_name: "nightly-cleanup", status: "skipped", id: 3 },
        ];
        const result = aggregateCronRuns(runs);
        expect(result.totalRuns).toBe(3);
        expect(result.successJobs).toBe(0);
        expect(result.failedJobs).toEqual([]);
        expect(result.unknownRuns).toBe(0);
    });

    it("handles a realistic mixed workload", () => {
        const runs: CronRun[] = [
            { task_name: "check-email", status: "succeeded", id: 1 },
            { task_name: "check-email", status: "succeeded", id: 2 },
            { task_name: "process-ap", status: "failed", id: 3 },
            { task_name: "nightly-cleanup", status: "unknown", id: 4 },
            { task_name: "nightly-cleanup", status: "unknown", id: 5 },
            { task_name: "vendor-poll", status: "running", id: 6 },
            { task_name: "vendor-poll", status: "succeeded", id: 7 },
            { task_name: "process-ap", status: "succeeded", id: 8 },
        ];
        const result = aggregateCronRuns(runs);
        expect(result.totalRuns).toBe(8);
        expect(result.successJobs).toBe(3); // check-email, vendor-poll, process-ap
        expect(result.failedJobs).toEqual(["process-ap"]);
        expect(result.unknownRuns).toBe(2);
    });

    it("handles empty input", () => {
        const result = aggregateCronRuns([]);
        expect(result.totalRuns).toBe(0);
        expect(result.successJobs).toBe(0);
        expect(result.failedJobs).toEqual([]);
        expect(result.unknownRuns).toBe(0);
    });

});
