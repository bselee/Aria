import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TripwireResult } from "./tripwires";
import { applyTripwireResults } from "./tripwire-runner";

vi.mock("@/lib/intelligence/agent-task", () => ({
    incrementOrCreate: vi.fn().mockResolvedValue({ id: "task-uuid" }),
    updateBySource: vi.fn().mockResolvedValue(undefined),
    getBySource: vi.fn().mockResolvedValue(null),
    complete: vi.fn().mockResolvedValue(undefined),
}));

import * as agentTask from "@/lib/intelligence/agent-task";

const mockGetBySource = vi.mocked(agentTask.getBySource);
const mockIncrementOrCreate = vi.mocked(agentTask.incrementOrCreate);
const mockComplete = vi.mocked(agentTask.complete);

function failingResult(overrides: Partial<TripwireResult> = {}): TripwireResult {
    return {
        tripwire: "migration-drift",
        ok: false,
        summary: "1 migration not applied: 20260606_x.sql",
        detail: { unapplied: ["20260606_x.sql"] },
        ranAt: new Date().toISOString(),
        unapplied: ["20260606_x.sql"],
        ...overrides,
    };
}

function passingResult(overrides: Partial<TripwireResult> = {}): TripwireResult {
    return {
        tripwire: "migration-drift",
        ok: true,
        summary: "All migrations applied",
        detail: {},
        ranAt: new Date().toISOString(),
        unapplied: [],
        ...overrides,
    };
}

describe("applyTripwireResults", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetBySource.mockResolvedValue(null);
    });

    it("creates a tripwire_violation task when result.ok is false", async () => {
        await applyTripwireResults([failingResult()]);
        expect(mockIncrementOrCreate).toHaveBeenCalledTimes(1);
        const args = mockIncrementOrCreate.mock.calls[0][0];
        expect(args.type).toBe("tripwire_violation");
        expect(args.sourceTable).toBe("tripwires");
        expect(args.sourceId).toBe("migration-drift");
        expect(args.owner).toBe("aria");
        expect(args.requiresApproval).toBe(false);
        expect(args.inputs).toMatchObject({ tripwire: "migration-drift" });
    });

    it("auto-closes existing open task when result.ok is true", async () => {
        mockGetBySource.mockResolvedValueOnce({
            id: "open-task",
            status: "PENDING",
            type: "tripwire_violation",
        } as never);
        await applyTripwireResults([passingResult()]);
        expect(mockComplete).toHaveBeenCalledWith(
            "open-task",
            expect.objectContaining({ auto_handled_by: "tripwire-runner" }),
        );
        expect(mockIncrementOrCreate).not.toHaveBeenCalled();
    });

    it("no-ops when result.ok is true and no open task exists", async () => {
        await applyTripwireResults([passingResult()]);
        expect(mockIncrementOrCreate).not.toHaveBeenCalled();
        expect(mockComplete).not.toHaveBeenCalled();
    });

    it("does not auto-close already-resolved tasks (status SUCCEEDED/FAILED)", async () => {
        mockGetBySource.mockResolvedValueOnce({
            id: "old-task",
            status: "SUCCEEDED",
            type: "tripwire_violation",
        } as never);
        await applyTripwireResults([passingResult()]);
        expect(mockComplete).not.toHaveBeenCalled();
    });

    it("processes multiple tripwire results in one call", async () => {
        await applyTripwireResults([
            failingResult({ tripwire: "a" }),
            failingResult({ tripwire: "b" }),
        ]);
        expect(mockIncrementOrCreate).toHaveBeenCalledTimes(2);
        const sourceIds = mockIncrementOrCreate.mock.calls.map(c => c[0].sourceId);
        expect(sourceIds.sort()).toEqual(["a", "b"]);
    });

    it("survives a hub write failure for one tripwire and continues with the next", async () => {
        mockIncrementOrCreate
            .mockRejectedValueOnce(new Error("hub down"))
            .mockResolvedValueOnce({ id: "ok" } as never);
        await applyTripwireResults([
            failingResult({ tripwire: "a" }),
            failingResult({ tripwire: "b" }),
        ]);
        expect(mockIncrementOrCreate).toHaveBeenCalledTimes(2);
    });
});
