import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineJob, _resetRegistry } from "./registry";

vi.mock("./history", () => ({
    recordStart: vi.fn().mockResolvedValue(1),
    recordEnd: vi.fn().mockResolvedValue(undefined),
    lastRun: vi.fn().mockResolvedValue({ status: "succeeded", started_at: new Date().toISOString() }),
    isSuccessStatus: (s: string) => s === "succeeded" || s === "success",
}));

// Re-import after mocks are set up so the module sees them.
async function freshRunner() {
    const mod = await import("./runner");
    return mod;
}

describe("runner.runJobOnce", () => {
    beforeEach(() => {
        _resetRegistry();
        vi.clearAllMocks();
    });

    it("invokes the handler and reports succeeded", async () => {
        const handler = vi.fn().mockResolvedValue(undefined);
        defineJob({ name: "ok", schedule: "* * * * *", handler });
        const { runJobOnce } = await freshRunner();
        const result = await runJobOnce("ok", "manual");
        expect(result.status).toBe("succeeded");
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("captures handler errors and reports failed with onFail=log", async () => {
        const handler = vi.fn().mockRejectedValue(new Error("boom"));
        defineJob({ name: "boom", schedule: "* * * * *", handler, onFail: "log" });
        const { runJobOnce } = await freshRunner();
        const result = await runJobOnce("boom", "manual");
        expect(result.status).toBe("failed");
        expect(result.failureMessage).toContain("boom");
    });

    it("aborts the handler if budget.durationMs is exceeded", async () => {
        const handler = vi.fn().mockImplementation((ctx: any) =>
            new Promise<void>((_, reject) => {
                ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
            })
        );
        defineJob({ name: "slow", schedule: "* * * * *", handler, budget: { durationMs: 50 } });
        const { runJobOnce } = await freshRunner();
        const result = await runJobOnce("slow", "manual");
        expect(result.status).toBe("failed");
        expect(result.failureReason).toBe("duration-exceeded");
    });

    it("dependsOn: skips with status=skipped when upstream's last run did not succeed", async () => {
        const { lastRun } = await import("./history");
        (lastRun as any).mockResolvedValueOnce({ status: "failed", started_at: new Date().toISOString() });
        defineJob({ name: "dep-job", schedule: "* * * * *", handler: async () => {}, dependsOn: ["upstream"] });
        const { runJobOnce } = await freshRunner();
        const result = await runJobOnce("dep-job", "cron");
        expect(result.status).toBe("skipped");
        expect(result.failureReason).toBe("dependency-not-succeeded");
    });

    it("dependsOn: accepts legacy 'success' status as a successful upstream", async () => {
        const { lastRun } = await import("./history");
        (lastRun as any).mockResolvedValueOnce({ status: "success", started_at: new Date().toISOString() });
        const handler = vi.fn().mockResolvedValue(undefined);
        defineJob({ name: "dep-legacy", schedule: "* * * * *", handler, dependsOn: ["upstream"] });
        const { runJobOnce } = await freshRunner();
        const result = await runJobOnce("dep-legacy", "cron");
        expect(result.status).toBe("succeeded");
        expect(handler).toHaveBeenCalled();
    });

    it("returns status=skipped if job is disabled", async () => {
        const handler = vi.fn();
        defineJob({ name: "off", schedule: "* * * * *", handler, enabled: false });
        const { runJobOnce } = await freshRunner();
        const result = await runJobOnce("off", "cron");
        expect(result.status).toBe("skipped");
        expect(result.failureReason).toBe("disabled");
        expect(handler).not.toHaveBeenCalled();
    });

    it("throws if job name not registered", async () => {
        const { runJobOnce } = await freshRunner();
        await expect(runJobOnce("missing", "manual")).rejects.toThrow(/not registered/);
    });

    it("manual invocation passes invokedBy='manual' to the handler ctx", async () => {
        const captured: { invokedBy?: string } = {};
        defineJob({
            name: "ctx-test",
            schedule: "* * * * *",
            handler: async (ctx) => { captured.invokedBy = ctx.invokedBy; },
        });
        const { runJobOnce } = await freshRunner();
        await runJobOnce("ctx-test", "manual");
        expect(captured.invokedBy).toBe("manual");
    });
});
