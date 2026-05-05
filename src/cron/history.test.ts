import { describe, it, expect, vi, beforeEach } from "vitest";

const fromMock = vi.fn();

vi.mock("../lib/supabase", () => ({
    createClient: () => ({ from: fromMock }),
}));

beforeEach(() => {
    fromMock.mockReset();
});

describe("cron history", () => {
    it("recordStart inserts task_name, status=running, invoked_by, metadata, returns id", async () => {
        const single = vi.fn().mockResolvedValue({ data: { id: 99 }, error: null });
        const select = vi.fn().mockReturnValue({ single });
        const insert = vi.fn().mockReturnValue({ select });
        fromMock.mockReturnValue({ insert });

        const { recordStart } = await import("./history");
        const id = await recordStart({ jobName: "x", invokedBy: "cron", correlationId: "abc" });

        expect(id).toBe(99);
        expect(fromMock).toHaveBeenCalledWith("cron_runs");
        expect(insert).toHaveBeenCalledWith(expect.objectContaining({
            task_name: "x",
            status: "running",
            invoked_by: "cron",
        }));
        const insertedRow = insert.mock.calls[0][0];
        expect(insertedRow.metadata_jsonb).toMatchObject({ correlationId: "abc" });
    });

    it("recordEnd updates status, finished_at, duration_ms, error_message, failure_reason", async () => {
        const eq = vi.fn().mockResolvedValue({ data: null, error: null });
        const update = vi.fn().mockReturnValue({ eq });
        fromMock.mockReturnValue({ update });

        const { recordEnd } = await import("./history");
        await recordEnd({
            id: 99,
            status: "failed",
            durationMs: 1234,
            failureReason: "duration-exceeded",
            failureMessage: "boom",
        });

        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            status: "failed",
            duration_ms: 1234,
            error_message: "boom",
            failure_reason: "duration-exceeded",
        }));
        const updatedRow = update.mock.calls[0][0];
        expect(updatedRow.finished_at).toBeDefined();
        expect(eq).toHaveBeenCalledWith("id", 99);
    });

    it("recordEnd is a no-op when id is null", async () => {
        const { recordEnd } = await import("./history");
        await recordEnd({ id: null, status: "succeeded" });
        expect(fromMock).not.toHaveBeenCalled();
    });

    it("recordStart returns null when supabase reports an error (does not throw)", async () => {
        const single = vi.fn().mockResolvedValue({ data: null, error: { message: "nope" } });
        const select = vi.fn().mockReturnValue({ single });
        const insert = vi.fn().mockReturnValue({ select });
        fromMock.mockReturnValue({ insert });

        const { recordStart } = await import("./history");
        const id = await recordStart({ jobName: "x", invokedBy: "cron", correlationId: "abc" });
        expect(id).toBeNull();
    });

    it("lastRun returns the most recent row for the named job", async () => {
        const maybeSingle = vi.fn().mockResolvedValue({
            data: { id: 7, started_at: "2026-05-05T10:00:00Z", finished_at: null, status: "succeeded", duration_ms: 100, error_message: null },
            error: null,
        });
        const limit = vi.fn().mockReturnValue({ maybeSingle });
        const order = vi.fn().mockReturnValue({ limit });
        const eq = vi.fn().mockReturnValue({ order });
        const select = vi.fn().mockReturnValue({ eq });
        fromMock.mockReturnValue({ select });

        const { lastRun } = await import("./history");
        const result = await lastRun("x");
        expect(result?.status).toBe("succeeded");
        expect(eq).toHaveBeenCalledWith("task_name", "x");
        expect(order).toHaveBeenCalledWith("started_at", { ascending: false });
    });
});
