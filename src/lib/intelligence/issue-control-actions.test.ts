import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────
const supabaseMock: any = {
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
};
function resetChain() {
    supabaseMock.from.mockReturnValue(supabaseMock);
    supabaseMock.select.mockReturnValue(supabaseMock);
    supabaseMock.eq.mockReturnValue(supabaseMock);
    supabaseMock.update.mockReturnValue(supabaseMock);
    supabaseMock.insert.mockReturnValue(supabaseMock);
}
vi.mock("@/lib/db", () => ({ createClient: () => supabaseMock }));

// Mock agent-issue helpers so action routing is observable.
const recordHandoffMock = vi.hoisted(() => vi.fn());
const setBlockerMock = vi.hoisted(() => vi.fn());
const clearBlockerMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
const getByIdMock = vi.hoisted(() => vi.fn());
vi.mock("./agent-issue", async () => {
    const actual = await vi.importActual<typeof import("./agent-issue")>("./agent-issue");
    return {
        ...actual,
        recordHandoff: recordHandoffMock,
        setBlocker: setBlockerMock,
        clearBlocker: clearBlockerMock,
        complete: completeMock,
        getById: getByIdMock,
    };
});

// Mock orchestrator so run_next_step has a stub to call.
const orchestratorMock = vi.hoisted(() => vi.fn());
vi.mock("./issue-orchestrator", async () => {
    const actual = await vi.importActual<typeof import("./issue-orchestrator")>("./issue-orchestrator");
    return {
        ...actual,
        evaluateIssue: actual.evaluateIssue,
        runIssueOrchestratorOnce: orchestratorMock,
    };
});

import { applyIssueControlAction } from "./issue-control-actions";
import type { AgentIssue } from "./agent-issue";

function fakeIssue(overrides: Partial<AgentIssue> = {}): AgentIssue {
    return {
        id: overrides.id ?? "iss-1",
        title: "T",
        source_table: null,
        source_id: null,
        business_flow_key: "x",
        lifecycle_state: overrides.lifecycle_state ?? "working",
        autonomy_state: "working",
        current_handler: overrides.current_handler ?? null,
        blocker_reason: overrides.blocker_reason ?? null,
        next_action: null,
        priority: 2,
        owner: overrides.owner ?? "aria",
        created_at: "2026-04-30T00:00:00.000Z",
        updated_at: "2026-04-30T00:00:00.000Z",
        completed_at: null,
        inputs: overrides.inputs ?? {},
        outputs: {},
    } as AgentIssue;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    supabaseMock.maybeSingle.mockResolvedValue({ data: null, error: null });
    supabaseMock.single.mockResolvedValue({ data: { id: "iss-1" }, error: null });
});

describe("applyIssueControlAction — set_control_mode", () => {
    it("patches inputs.control.mode and returns ok", async () => {
        getByIdMock.mockResolvedValueOnce(fakeIssue());
        supabaseMock.single.mockResolvedValueOnce({
            data: { id: "iss-1", inputs: { control: { mode: "autonomous", updatedAt: "x" } } },
            error: null,
        });
        const r = await applyIssueControlAction("iss-1", {
            action: "set_control_mode",
            mode: "autonomous",
            actor: "will-telegram",
            reason: "safe read-only",
        });
        expect(r.ok).toBe(true);
        // The patch goes through inputs.control via patchIssueControlProfile,
        // which calls supabase.update with inputs in payload.
        const updateArg = supabaseMock.update.mock.calls.find((c: any[]) => c[0]?.inputs?.control)?.[0];
        expect(updateArg?.inputs?.control?.mode).toBe("autonomous");
    });
});

describe("applyIssueControlAction — assign_handler", () => {
    it("calls recordHandoff with the new handler", async () => {
        getByIdMock.mockResolvedValueOnce(fakeIssue({ current_handler: "ap-reconciler" }));
        const r = await applyIssueControlAction("iss-1", {
            action: "assign_handler",
            handler: "will",
            actor: "will-telegram",
            reason: "human review",
        });
        expect(r.ok).toBe(true);
        expect(recordHandoffMock).toHaveBeenCalledWith("iss-1", "ap-reconciler", "will", "human review");
    });
});

describe("applyIssueControlAction — pause / resume", () => {
    it("pause sets inputs.control.paused = true", async () => {
        getByIdMock.mockResolvedValueOnce(fakeIssue());
        const r = await applyIssueControlAction("iss-1", { action: "pause", actor: "will-telegram" });
        expect(r.ok).toBe(true);
        const updateArg = supabaseMock.update.mock.calls.find((c: any[]) => c[0]?.inputs?.control)?.[0];
        expect(updateArg?.inputs?.control?.paused).toBe(true);
    });

    it("resume clears the paused flag", async () => {
        getByIdMock.mockResolvedValueOnce(fakeIssue({
            inputs: { control: { mode: "autonomous", paused: true, updatedAt: "now" } } as any,
        }));
        const r = await applyIssueControlAction("iss-1", { action: "resume", actor: "will-telegram" });
        expect(r.ok).toBe(true);
        const updateArg = supabaseMock.update.mock.calls.find((c: any[]) => c[0]?.inputs?.control)?.[0];
        expect(updateArg?.inputs?.control?.paused).toBe(false);
    });
});

describe("applyIssueControlAction — set_blocker / clear_blocker", () => {
    it("set_blocker calls agent-issue.setBlocker with correct args", async () => {
        getByIdMock.mockResolvedValueOnce(fakeIssue());
        const r = await applyIssueControlAction("iss-1", {
            action: "set_blocker",
            reason: "policy_required",
            nextAction: "Will: confirm policy",
            actor: "will-dashboard",
        });
        expect(r.ok).toBe(true);
        expect(setBlockerMock).toHaveBeenCalledWith("iss-1", "policy_required", "Will: confirm policy");
    });

    it("clear_blocker calls agent-issue.clearBlocker with optional resumeState", async () => {
        getByIdMock.mockResolvedValueOnce(fakeIssue({ lifecycle_state: "blocked", blocker_reason: "policy_required" }));
        const r = await applyIssueControlAction("iss-1", {
            action: "clear_blocker",
            actor: "will-telegram",
            resumeState: "triaging",
        });
        expect(r.ok).toBe(true);
        expect(clearBlockerMock).toHaveBeenCalledWith("iss-1", "triaging");
    });
});

describe("applyIssueControlAction — run_next_step", () => {
    it("invokes runIssueOrchestratorOnce", async () => {
        getByIdMock.mockResolvedValueOnce(fakeIssue());
        orchestratorMock.mockResolvedValueOnce({ evaluated: 1, skipped: 0, proposed: 0, suggested: 0, tasksCreated: 0, errors: 0 });
        const r = await applyIssueControlAction("iss-1", { action: "run_next_step", actor: "will-telegram" });
        expect(r.ok).toBe(true);
        expect(orchestratorMock).toHaveBeenCalled();
    });
});

describe("applyIssueControlAction — complete", () => {
    it("calls agent-issue.complete with resolution outputs", async () => {
        getByIdMock.mockResolvedValueOnce(fakeIssue());
        const r = await applyIssueControlAction("iss-1", {
            action: "complete",
            actor: "will-telegram",
            resolution: "manually resolved",
        });
        expect(r.ok).toBe(true);
        expect(completeMock).toHaveBeenCalledWith("iss-1", expect.objectContaining({ resolution: "manually resolved" }));
    });
});

describe("applyIssueControlAction — error paths", () => {
    it("returns ok=false when issue not found", async () => {
        getByIdMock.mockResolvedValueOnce(null);
        const r = await applyIssueControlAction("missing", { action: "pause", actor: "x" });
        expect(r.ok).toBe(false);
    });
});
