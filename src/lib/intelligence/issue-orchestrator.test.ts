import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentIssue } from "./agent-issue";

// ── Mock chain ──────────────────────────────────────────────────────────────
const supabaseMock: any = {
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
};
function resetChain() {
    supabaseMock.from.mockReturnValue(supabaseMock);
    supabaseMock.select.mockReturnValue(supabaseMock);
    supabaseMock.eq.mockReturnValue(supabaseMock);
    supabaseMock.in.mockReturnValue(supabaseMock);
    supabaseMock.update.mockReturnValue(supabaseMock);
    supabaseMock.insert.mockReturnValue(supabaseMock);
}
vi.mock("@/lib/db", () => ({ createClient: () => supabaseMock }));

// Mock listIssues so evaluateIssue tests stay isolated.
const listIssuesMock = vi.hoisted(() => vi.fn());
const incrementOrCreateMock = vi.hoisted(() => vi.fn());

vi.mock("./agent-issue", async () => {
    const actual = await vi.importActual<typeof import("./agent-issue")>("./agent-issue");
    return {
        ...actual,
        listIssues: listIssuesMock,
    };
});

vi.mock("./agent-task", () => ({
    incrementOrCreate: incrementOrCreateMock,
}));

import { evaluateIssue, runIssueOrchestratorOnce } from "./issue-orchestrator";

function mockIssue(overrides: Partial<AgentIssue> & { control?: any } = {}): AgentIssue {
    const { control, ...rest } = overrides;
    const inputs = control ? { control, ...((rest.inputs as any) ?? {}) } : (rest.inputs ?? {});
    return {
        id: rest.id ?? "iss-test",
        title: rest.title ?? "Test issue",
        source_table: rest.source_table ?? null,
        source_id: rest.source_id ?? null,
        business_flow_key: rest.business_flow_key ?? "test|key",
        lifecycle_state: rest.lifecycle_state ?? "working",
        autonomy_state: rest.autonomy_state ?? "working",
        current_handler: rest.current_handler ?? null,
        blocker_reason: rest.blocker_reason ?? null,
        next_action: rest.next_action ?? null,
        priority: rest.priority ?? 2,
        owner: rest.owner ?? "aria",
        created_at: rest.created_at ?? "2026-04-30T00:00:00.000Z",
        updated_at: rest.updated_at ?? "2026-04-30T00:00:00.000Z",
        completed_at: rest.completed_at ?? null,
        inputs,
        outputs: rest.outputs ?? {},
    } as AgentIssue;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    supabaseMock.maybeSingle.mockResolvedValue({ data: null, error: null });
});

describe("evaluateIssue — control mode gates", () => {
    it("does not enqueue work in observe_only mode", async () => {
        const issue = mockIssue({
            lifecycle_state: "working",
            owner: "aria",
            source_table: null,
            control: { mode: "observe_only", updatedAt: "now" },
        });
        const result = await evaluateIssue(issue);
        expect(result.action.kind).toBe("ask_will");
        expect(result.enqueuedTaskId).toBeNull();
    });

    it("skips paused issues entirely", async () => {
        const issue = mockIssue({
            lifecycle_state: "working",
            control: { mode: "autonomous", paused: true, updatedAt: "now" },
        });
        const result = await evaluateIssue(issue);
        expect(result.skipped).toBe(true);
        expect(result.enqueuedTaskId).toBeNull();
    });

    it("complete issues evaluate to action.kind=none and skip", async () => {
        const issue = mockIssue({ lifecycle_state: "complete" });
        const result = await evaluateIssue(issue);
        expect(result.action.kind).toBe("none");
        expect(result.skipped).toBe(true);
    });
});

describe("evaluateIssue — decision rules", () => {
    it("blocked + human_approval_required → ask_will", async () => {
        const issue = mockIssue({
            lifecycle_state: "blocked",
            blocker_reason: "human_approval_required",
        });
        const r = await evaluateIssue(issue);
        expect(r.action.kind).toBe("ask_will");
    });

    it("waiting_external → wait_external (no work)", async () => {
        const issue = mockIssue({ lifecycle_state: "waiting_external" });
        const r = await evaluateIssue(issue);
        expect(r.action.kind).toBe("wait_external");
    });

    it("AP source with no linked task → create_task requiring approval", async () => {
        const issue = mockIssue({
            lifecycle_state: "working",
            source_table: "ap_pending_approvals",
            source_id: "ap-1",
        });
        const r = await evaluateIssue(issue);
        expect(r.action.kind).toBe("create_task");
        if (r.action.kind === "create_task") {
            expect(r.action.requiresApproval).toBe(true);
        }
    });

    it("issue with playbook_kind in inputs → run_playbook", async () => {
        const issue = mockIssue({
            lifecycle_state: "working",
            inputs: { playbook_kind: "apply_pending_migration" } as any,
        });
        const r = await evaluateIssue(issue);
        expect(r.action.kind).toBe("run_playbook");
        if (r.action.kind === "run_playbook") {
            expect(r.action.playbookKind).toBe("apply_pending_migration");
        }
    });

    it("unknown / no match → ask_will (safe default)", async () => {
        const issue = mockIssue({
            lifecycle_state: "working",
            owner: "aria",
            source_table: null,
        });
        const r = await evaluateIssue(issue);
        expect(r.action.kind).toBe("ask_will");
    });
});

describe("runIssueOrchestratorOnce — execution paths", () => {
    it("suggest mode: patches next_action only, does not create a task", async () => {
        listIssuesMock.mockResolvedValueOnce([
            mockIssue({
                id: "iss-suggest",
                lifecycle_state: "blocked",
                blocker_reason: "human_approval_required",
                control: { mode: "suggest", updatedAt: "now" },
            }),
        ]);
        const summary = await runIssueOrchestratorOnce({ limit: 5 });
        expect(summary.evaluated).toBe(1);
        expect(summary.tasksCreated).toBe(0);
        expect(incrementOrCreateMock).not.toHaveBeenCalled();
    });

    it("act_with_approval: creates a task with requiresApproval=true for AP-source issues", async () => {
        listIssuesMock.mockResolvedValueOnce([
            mockIssue({
                id: "iss-ap",
                lifecycle_state: "working",
                source_table: "ap_pending_approvals",
                source_id: "ap-1",
                control: { mode: "act_with_approval", updatedAt: "now" },
            }),
        ]);
        incrementOrCreateMock.mockResolvedValueOnce({ id: "task-new" });
        const summary = await runIssueOrchestratorOnce({ limit: 5 });
        expect(incrementOrCreateMock).toHaveBeenCalledTimes(1);
        const args = incrementOrCreateMock.mock.calls[0][0];
        expect(args.requiresApproval).toBe(true);
        expect(summary.tasksCreated).toBe(1);
    });

    it("observe_only: writes a proposal event, does not create or update", async () => {
        listIssuesMock.mockResolvedValueOnce([
            mockIssue({
                id: "iss-observe",
                lifecycle_state: "working",
                control: { mode: "observe_only", updatedAt: "now" },
            }),
        ]);
        const summary = await runIssueOrchestratorOnce({ limit: 5 });
        expect(incrementOrCreateMock).not.toHaveBeenCalled();
        expect(summary.proposed).toBeGreaterThanOrEqual(1);
    });

    it("respects limit cap (does not evaluate more than N)", async () => {
        listIssuesMock.mockResolvedValueOnce(
            Array.from({ length: 50 }, (_, i) =>
                mockIssue({
                    id: `iss-${i}`,
                    lifecycle_state: "working",
                    control: { mode: "observe_only", updatedAt: "now" },
                }),
            ),
        );
        const summary = await runIssueOrchestratorOnce({ limit: 10 });
        expect(summary.evaluated).toBe(10);
    });

    it("single-flight: a second concurrent run returns 'already-running'", async () => {
        listIssuesMock.mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 30));
            return [];
        });
        const [a, b] = await Promise.all([
            runIssueOrchestratorOnce({ limit: 5 }),
            runIssueOrchestratorOnce({ limit: 5 }),
        ]);
        // One actually ran, the other reported single-flight refusal.
        const skipped = [a, b].find(r => r.alreadyRunning === true);
        expect(skipped).toBeTruthy();
    });

    it("paused issues are skipped without contributing to tasksCreated", async () => {
        listIssuesMock.mockResolvedValueOnce([
            mockIssue({
                id: "iss-paused",
                control: { mode: "autonomous", paused: true, updatedAt: "now" },
            }),
        ]);
        const summary = await runIssueOrchestratorOnce({ limit: 5 });
        expect(summary.skipped).toBeGreaterThanOrEqual(1);
        expect(summary.tasksCreated).toBe(0);
    });
});
