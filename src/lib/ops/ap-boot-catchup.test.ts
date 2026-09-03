/**
 * @file    src/lib/ops/ap-boot-catchup.test.ts
 * @purpose Unit tests for sparse ap-polling window skip detection + boot catch-up.
 * @author  Hermia
 * @created 2026-08-07
 */
import { describe, expect, it, vi } from "vitest";
import {
    denverLocalToUtc,
    isApPollingWindowSkipped,
    mostRecentApPollingWindow,
    runApBootCatchup,
} from "./ap-boot-catchup";

describe("mostRecentApPollingWindow", () => {
    it("picks 7:30 Denver on a morning after 7:30", () => {
        // 2026-08-07 09:30 MDT = 15:30 UTC (MDT = UTC-6)
        const now = new Date("2026-08-07T15:30:00.000Z");
        const w = mostRecentApPollingWindow(now);
        expect(w.toISOString()).toBe(denverLocalToUtc(2026, 8, 7, 7, 30).toISOString());
    });

    it("picks 7:30 Denver at 7:40, not yesterday 17:00", () => {
        const now = new Date("2026-08-07T13:40:00.000Z"); // 07:40 MDT
        const w = mostRecentApPollingWindow(now);
        expect(w.toISOString()).toBe(denverLocalToUtc(2026, 8, 7, 7, 30).toISOString());
    });

    it("picks 12:00 Denver after noon", () => {
        const now = new Date("2026-08-07T19:05:00.000Z"); // 13:05 MDT
        const w = mostRecentApPollingWindow(now);
        expect(w.toISOString()).toBe(denverLocalToUtc(2026, 8, 7, 12, 0).toISOString());
    });

    it("picks yesterday 17:00 when before first window", () => {
        const now = new Date("2026-08-07T13:00:00.000Z"); // 07:00 MDT
        const w = mostRecentApPollingWindow(now);
        expect(w.toISOString()).toBe(denverLocalToUtc(2026, 8, 6, 17, 0).toISOString());
    });
});

describe("isApPollingWindowSkipped", () => {
    it("flags missed 8am when last run was previous day", () => {
        const now = new Date("2026-08-07T15:10:00.000Z"); // 09:10 MDT
        const r = isApPollingWindowSkipped({
            now,
            lastRunStartedAt: "2026-08-06T23:00:00.000Z", // yesterday 17:00 MDT-ish
            catchUpHorizonMs: 5 * 60 * 60 * 1000,
        });
        expect(r.skipped).toBe(true);
        expect(r.reason).toMatch(/missed|no_prior/);
    });

    it("does not flag when last run is after the window", () => {
        const now = new Date("2026-08-07T15:10:00.000Z"); // 09:10 MDT
        const r = isApPollingWindowSkipped({
            now,
            lastRunStartedAt: "2026-08-07T14:05:00.000Z", // 08:05 MDT
            catchUpHorizonMs: 5 * 60 * 60 * 1000,
        });
        expect(r.skipped).toBe(false);
        expect(r.reason).toBe("window_already_covered");
    });

    it("flags no prior run inside horizon", () => {
        const now = new Date("2026-08-07T15:10:00.000Z");
        const r = isApPollingWindowSkipped({
            now,
            lastRunStartedAt: null,
            catchUpHorizonMs: 5 * 60 * 60 * 1000,
        });
        expect(r.skipped).toBe(true);
        expect(r.reason).toBe("no_prior_run");
    });
});

describe("runApBootCatchup", () => {
    it("runs job once when window skipped", async () => {
        const runJob = vi.fn(async () => ({ status: "succeeded" }));
        const result = await runApBootCatchup({
            now: new Date("2026-08-07T15:10:00.000Z"),
            lastRun: async () => ({ started_at: "2026-08-06T23:00:00.000Z" }),
            runJob,
        });
        expect(result.ran).toBe(true);
        expect(runJob).toHaveBeenCalledWith("ap-polling", "manual");
        expect(result.jobStatus).toBe("succeeded");
    });

    it("no-ops when window already covered", async () => {
        const runJob = vi.fn(async () => ({ status: "succeeded" }));
        const result = await runApBootCatchup({
            now: new Date("2026-08-07T15:10:00.000Z"),
            lastRun: async () => ({ started_at: "2026-08-07T14:02:00.000Z" }),
            runJob,
        });
        expect(result.ran).toBe(false);
        expect(runJob).not.toHaveBeenCalled();
        expect(result.reason).toBe("window_already_covered");
    });
});
