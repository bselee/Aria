// src/lib/intelligence/agent-task-closure.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createClient: createClientMock }));

import { evaluateClosure, closesWhenFor } from "./agent-task-closure";
import type { AgentTask } from "./agent-task";

function fakeTask(overrides: Partial<AgentTask> = {}): AgentTask {
    return {
        id: "t1",
        type: "control_command",
        source_table: "ops_control_requests",
        source_id: "src1",
        goal: "test",
        status: "PENDING",
        owner: "aria",
        priority: 2,
        parent_task_id: null,
        requires_approval: false,
        approval_decision: null,
        approval_decided_by: null,
        approval_decided_at: null,
        inputs: {},
        outputs: {},
        cost_cents: 0,
        retry_count: 0,
        max_retries: 0,
        deadline_at: null,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        updated_at: new Date().toISOString(),
        claimed_at: null,
        claimed_by: null,
        completed_at: null,
        ...overrides,
    } as AgentTask;
}

describe("evaluateClosure", () => {
    beforeEach(() => createClientMock.mockReset());

    it("agent_boot_after: true when heartbeat is newer than task", async () => {
        const heartbeatAt = new Date().toISOString();
        const single = vi.fn().mockResolvedValue({
            data: { heartbeat_at: heartbeatAt, status: "healthy" },
            error: null,
        });
        createClientMock.mockReturnValue({
            from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: single }) }) }) }),
        });

        const t = fakeTask({
            closes_when: { kind: "agent_boot_after", agent: "aria-bot" } as any,
            created_at: new Date(Date.now() - 600_000).toISOString(),
        });

        await expect(evaluateClosure(t)).resolves.toBe(true);
    });

    it("agent_boot_after: false when no heartbeat row", async () => {
        const single = vi.fn().mockResolvedValue({ data: null, error: null });
        createClientMock.mockReturnValue({
            from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: single }) }) }) }),
        });
        const t = fakeTask({ closes_when: { kind: "agent_boot_after", agent: "aria-bot" } as any });
        await expect(evaluateClosure(t)).resolves.toBe(false);
    });

    it("deadline: true when older than max_age_hours", async () => {
        const t = fakeTask({
            closes_when: { kind: "deadline", max_age_hours: 1 } as any,
            created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        });
        await expect(evaluateClosure(t)).resolves.toBe(true);
    });

    it("deadline: false when within window", async () => {
        const t = fakeTask({
            closes_when: { kind: "deadline", max_age_hours: 24 } as any,
            created_at: new Date(Date.now() - 3600_000).toISOString(),
        });
        await expect(evaluateClosure(t)).resolves.toBe(false);
    });

    it("spoke_status: true when downstream row matches value_in", async () => {
        const single = vi.fn().mockResolvedValue({ data: { status: "approved" }, error: null });
        createClientMock.mockReturnValue({
            from: () => ({ select: () => ({ eq: () => ({ maybeSingle: single }) }) }),
        });
        const t = fakeTask({
            closes_when: {
                kind: "spoke_status",
                table: "ap_pending_approvals",
                value_in: ["approved", "rejected"],
            } as any,
        });
        await expect(evaluateClosure(t)).resolves.toBe(true);
    });

    it("returns false for unknown predicate kind", async () => {
        const t = fakeTask({ closes_when: { kind: "nonsense" } as any });
        await expect(evaluateClosure(t)).resolves.toBe(false);
    });

    it("returns false when closes_when is null", async () => {
        const t = fakeTask({ closes_when: null as any });
        await expect(evaluateClosure(t)).resolves.toBe(false);
    });
});

describe("closesWhenFor", () => {
    it("maps restart_bot control_command to agent_boot_after", () => {
        expect(closesWhenFor({ type: "control_command", inputs: { command: "restart_bot" } }))
            .toEqual({ kind: "agent_boot_after", agent: "aria-bot" });
    });

    it("maps approval to spoke_status", () => {
        const r = closesWhenFor({ type: "approval", sourceTable: "ap_pending_approvals" });
        expect(r?.kind).toBe("spoke_status");
        expect(r?.table).toBe("ap_pending_approvals");
    });

    it("falls back to 24h deadline", () => {
        expect(closesWhenFor({ type: "manual" })).toEqual({ kind: "deadline", max_age_hours: 24 });
    });
});

import { closeFinishedTasks } from "./agent-task-closure";

describe("closeFinishedTasks", () => {
    beforeEach(() => createClientMock.mockReset());

    it("closes a deadline-expired task", async () => {
        const expired = {
            id: "expired-id",
            type: "manual",
            source_table: null,
            source_id: null,
            goal: "g",
            status: "PENDING",
            owner: "aria",
            priority: 2,
            parent_task_id: null,
            requires_approval: false,
            approval_decision: null,
            approval_decided_by: null,
            approval_decided_at: null,
            inputs: {},
            outputs: {},
            cost_cents: 0,
            retry_count: 0,
            max_retries: 0,
            deadline_at: null,
            created_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
            updated_at: new Date().toISOString(),
            claimed_at: null,
            claimed_by: null,
            completed_at: null,
            closes_when: { kind: "deadline", max_age_hours: 24 },
        };
        const updateEq = vi.fn().mockResolvedValue({ error: null });
        const updateUpdate = vi.fn(() => ({ eq: updateEq }));
        createClientMock.mockReturnValue({
            from: () => ({
                select: () => ({
                    in: () => ({
                        not: vi.fn().mockResolvedValue({ data: [expired], error: null }),
                    }),
                }),
                update: updateUpdate,
            }),
        });

        const closed = await closeFinishedTasks();
        expect(closed).toBe(1);
        expect(updateUpdate).toHaveBeenCalledOnce();
    });

    it("returns 0 when no open tasks have closes_when", async () => {
        createClientMock.mockReturnValue({
            from: () => ({
                select: () => ({
                    in: () => ({
                        not: vi.fn().mockResolvedValue({ data: [], error: null }),
                    }),
                }),
            }),
        });

        const closed = await closeFinishedTasks();
        expect(closed).toBe(0);
    });
});
