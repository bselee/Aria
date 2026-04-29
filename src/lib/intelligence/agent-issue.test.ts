import { describe, expect, it, vi, beforeEach } from "vitest";

// Supabase chain mock that's also awaitable (resolves to {error: null} by
// default) so `await supabase.from(...).insert({...})` works in addition to
// `.insert(...).select().single()`. Each terminal method (single, maybeSingle)
// queues its own resolved value via mockResolvedValueOnce.
let terminalAwaitValue: any = { error: null };

const supabaseMock: any = {
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    maybeSingle: vi.fn(),
    single: vi.fn(),
    then: (resolve: any) => resolve(terminalAwaitValue),
};

function resetChain() {
    terminalAwaitValue = { error: null };
    supabaseMock.from.mockReturnValue(supabaseMock);
    supabaseMock.select.mockReturnValue(supabaseMock);
    supabaseMock.eq.mockReturnValue(supabaseMock);
    supabaseMock.in.mockReturnValue(supabaseMock);
    supabaseMock.upsert.mockReturnValue(supabaseMock);
    supabaseMock.update.mockReturnValue(supabaseMock);
    supabaseMock.insert.mockReturnValue(supabaseMock);
}

vi.mock("@/lib/supabase", () => ({ createClient: () => supabaseMock }));

import { createOrAdvance, getCurrentlyHandlingCounts, findLinkedOpenTask } from "./agent-issue";

// Helper: override what the chained supabase mock resolves to next time.
function setNextChainResult(value: any) {
    terminalAwaitValue = value;
}

describe("createOrAdvance", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetChain();
    });

    it("creates a new issue when no row exists for the business_flow_key", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({ data: null });
        supabaseMock.single.mockResolvedValueOnce({
            data: {
                id: "new-id",
                title: "Invoice 124618 — Colorado Worm Co.",
                business_flow_key: "colorado-worm-co|inv:124618",
                lifecycle_state: "detected",
                autonomy_state: "working",
            },
            error: null,
        });
        const issue = await createOrAdvance({
            businessFlowKey: "colorado-worm-co|inv:124618",
            title: "Invoice 124618 — Colorado Worm Co.",
            sourceTable: "ap_inbox_queue",
            sourceId: "msg-id-123",
        });

        expect(issue?.id).toBe("new-id");
        expect(issue?.lifecycle_state).toBe("detected");
    });

    it("advances an existing open issue without changing its title", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: {
                id: "existing-id",
                title: "Invoice 124618 — Colorado Worm Co.",
                business_flow_key: "colorado-worm-co|inv:124618",
                lifecycle_state: "detected",
            },
        });
        supabaseMock.single.mockResolvedValueOnce({
            data: {
                id: "existing-id",
                title: "Invoice 124618 — Colorado Worm Co.",
                lifecycle_state: "working",
                current_handler: "ap-agent",
            },
            error: null,
        });

        const issue = await createOrAdvance({
            businessFlowKey: "colorado-worm-co|inv:124618",
            lifecycleState: "working",
            currentHandler: "ap-agent",
        });

        expect(issue?.id).toBe("existing-id");
        expect(issue?.lifecycle_state).toBe("working");
        expect(supabaseMock.update).toHaveBeenCalled();
    });

    it("returns null when HUB_TASKS_ENABLED is off", async () => {
        process.env.HUB_TASKS_ENABLED = "false";
        const issue = await createOrAdvance({
            businessFlowKey: "k",
            title: "t",
        });
        expect(issue).toBeNull();
        delete process.env.HUB_TASKS_ENABLED;
    });

    it("returns null on first-create when title is missing (caller bug)", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({ data: null });
        const issue = await createOrAdvance({
            businessFlowKey: "k-no-title",
            // title intentionally omitted
        });
        expect(issue).toBeNull();
    });

    it("recordHandoff updates current_handler and writes ledger event", async () => {
        terminalAwaitValue = { error: null };
        const { recordHandoff } = await import("./agent-issue");
        let appliedPatch: any = null;
        supabaseMock.update.mockImplementationOnce((p: any) => {
            appliedPatch = p;
            return supabaseMock;
        });
        await recordHandoff("i1", "email-agent", "ap-agent", "Email classified as INVOICE");
        expect(appliedPatch?.current_handler).toBe("ap-agent");
    });

    it("setBlocker transitions lifecycle to blocked + sets reason + next_action", async () => {
        const { setBlocker } = await import("./agent-issue");
        let appliedPatch: any = null;
        supabaseMock.update.mockImplementationOnce((p: any) => {
            appliedPatch = p;
            return supabaseMock;
        });
        await setBlocker("i1", "missing_receipt", "Wait for warehouse to confirm receipt");
        expect(appliedPatch).toEqual(expect.objectContaining({
            lifecycle_state: "blocked",
            blocker_reason: "missing_receipt",
            next_action: "Wait for warehouse to confirm receipt",
            autonomy_state: "waiting",
        }));
    });

    it("setBlocker uses needs_policy autonomy for human_approval_required", async () => {
        const { setBlocker } = await import("./agent-issue");
        let appliedPatch: any = null;
        supabaseMock.update.mockImplementationOnce((p: any) => {
            appliedPatch = p;
            return supabaseMock;
        });
        await setBlocker("i1", "human_approval_required", "Will to approve");
        expect(appliedPatch?.autonomy_state).toBe("needs_policy");
    });

    it("clearBlocker resumes to working by default", async () => {
        const { clearBlocker } = await import("./agent-issue");
        let appliedPatch: any = null;
        supabaseMock.update.mockImplementationOnce((p: any) => {
            appliedPatch = p;
            return supabaseMock;
        });
        await clearBlocker("i1");
        expect(appliedPatch).toEqual(expect.objectContaining({
            lifecycle_state: "working",
            blocker_reason: null,
            autonomy_state: "working",
        }));
    });

    it("complete sets lifecycle complete + completed_at", async () => {
        const { complete } = await import("./agent-issue");
        let appliedPatch: any = null;
        supabaseMock.update.mockImplementationOnce((p: any) => {
            appliedPatch = p;
            return supabaseMock;
        });
        await complete("i1", { resolution: "AP approved" });
        expect(appliedPatch?.lifecycle_state).toBe("complete");
        expect(appliedPatch?.autonomy_state).toBe("resolved");
        expect(typeof appliedPatch?.completed_at).toBe("string");
    });

    it("linkTask updates agent_task.issue_id", async () => {
        const { linkTask } = await import("./agent-issue");
        let appliedPatch: any = null;
        supabaseMock.update.mockImplementationOnce((p: any) => {
            appliedPatch = p;
            return supabaseMock;
        });
        await linkTask("task-id", "issue-id");
        expect(supabaseMock.from).toHaveBeenCalledWith("agent_task");
        expect(appliedPatch).toEqual({ issue_id: "issue-id" });
    });

    it("preserves explicit blocked state — projection cannot revert it", async () => {
        // The existing issue was explicitly blocked by setBlocker().
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: {
                id: "blocked-id",
                title: "Existing",
                business_flow_key: "k",
                lifecycle_state: "blocked",
                blocker_reason: "missing_receipt",
                next_action: "Wait for warehouse",
            },
        });
        // Capture the patch handed to update(...).
        let appliedPatch: Record<string, unknown> | null = null;
        supabaseMock.update.mockImplementationOnce((p: Record<string, unknown>) => {
            appliedPatch = p;
            return supabaseMock;
        });
        supabaseMock.single.mockResolvedValueOnce({
            data: { id: "blocked-id", lifecycle_state: "blocked" },
            error: null,
        });

        await createOrAdvance({
            businessFlowKey: "k",
            // Projection-shaped input that WOULD normally move us back to working:
            lifecycleState: "working",
            autonomyState: "working",
            currentHandler: "ap-agent",
            nextAction: "Try again",
            // Projection trying to flip owner back to aria — also blocked.
            owner: "aria",
            // ...and a safe metadata bump that SHOULD apply:
            priority: 1,
            inputs: { task_count: 4 },
        });

        expect(appliedPatch).not.toBeNull();
        // Lifecycle / autonomy / handler / next_action / owner MUST be omitted.
        expect(appliedPatch).not.toHaveProperty("lifecycle_state");
        expect(appliedPatch).not.toHaveProperty("autonomy_state");
        expect(appliedPatch).not.toHaveProperty("current_handler");
        expect(appliedPatch).not.toHaveProperty("next_action");
        // Owner preservation: a blocked issue assigned to Will must not be
        // flipped back to aria by the next projection cycle.
        expect(appliedPatch).not.toHaveProperty("owner");
        // Safe metadata DID apply.
        expect(appliedPatch).toHaveProperty("priority", 1);
        expect(appliedPatch).toHaveProperty("inputs");
    });
});

describe("getCurrentlyHandlingCounts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetChain();
    });

    it("groups open issues by current_handler with state breakdown", async () => {
        setNextChainResult({
            data: [
                { current_handler: "ap-agent", lifecycle_state: "working" },
                { current_handler: "ap-agent", lifecycle_state: "working" },
                { current_handler: "ap-agent", lifecycle_state: "blocked" },
                { current_handler: "will", lifecycle_state: "blocked" },
                { current_handler: "ap-reconciler", lifecycle_state: "waiting_external" },
                { current_handler: "ap-reconciler", lifecycle_state: "detected" },
            ],
            error: null,
        });

        const counts = await getCurrentlyHandlingCounts();

        expect(counts["ap-agent"]).toEqual({ working: 2, waitingExternal: 0, blocked: 1, total: 3 });
        expect(counts["will"]).toEqual({ working: 0, waitingExternal: 0, blocked: 1, total: 1 });
        expect(counts["ap-reconciler"]).toEqual({ working: 1, waitingExternal: 1, blocked: 0, total: 2 });
    });

    it("silently drops rows where current_handler is null", async () => {
        setNextChainResult({
            data: [
                { current_handler: null, lifecycle_state: "working" },
                { current_handler: "ap-agent", lifecycle_state: "working" },
            ],
            error: null,
        });

        const counts = await getCurrentlyHandlingCounts();

        expect(Object.keys(counts)).toEqual(["ap-agent"]);
        expect(counts["ap-agent"].total).toBe(1);
    });

    it("returns an empty map on query failure (best-effort, dashboard renders without overlay)", async () => {
        setNextChainResult({ data: null, error: { message: "boom" } });
        const counts = await getCurrentlyHandlingCounts();
        expect(counts).toEqual({});
    });

    it("buckets detected/triaging/working all into 'working' (caller doesn't need 5-state breakdown)", async () => {
        setNextChainResult({
            data: [
                { current_handler: "x", lifecycle_state: "detected" },
                { current_handler: "x", lifecycle_state: "triaging" },
                { current_handler: "x", lifecycle_state: "working" },
            ],
            error: null,
        });
        const counts = await getCurrentlyHandlingCounts();
        expect(counts["x"]).toEqual({ working: 3, waitingExternal: 0, blocked: 0, total: 3 });
    });
});

describe("findLinkedOpenTask", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetChain();
    });

    it("prefers NEEDS_APPROVAL over in-flight tasks", async () => {
        setNextChainResult({
            data: [
                { id: "t-running", status: "RUNNING", source_table: null, source_id: null },
                { id: "t-approval", status: "NEEDS_APPROVAL", source_table: "ap_pending_approvals", source_id: "ap-1" },
                { id: "t-pending", status: "PENDING", source_table: null, source_id: null },
            ],
            error: null,
        });
        const linked = await findLinkedOpenTask("iss-1");
        expect(linked?.id).toBe("t-approval");
        expect(linked?.source_table).toBe("ap_pending_approvals");
    });

    it("returns null when no actionable tasks linked", async () => {
        setNextChainResult({ data: [], error: null });
        const linked = await findLinkedOpenTask("iss-empty");
        expect(linked).toBeNull();
    });

    it("returns null on query failure (best-effort, callers fall back to issue-level resolve)", async () => {
        setNextChainResult({ data: null, error: { message: "boom" } });
        const linked = await findLinkedOpenTask("iss-x");
        expect(linked).toBeNull();
    });

    it("falls through to in-flight when no NEEDS_APPROVAL is linked", async () => {
        setNextChainResult({
            data: [
                { id: "t-pending", status: "PENDING", source_table: null, source_id: null },
                { id: "t-running", status: "RUNNING", source_table: null, source_id: null },
            ],
            error: null,
        });
        const linked = await findLinkedOpenTask("iss-2");
        // First in the array after rank-stable sort — PENDING was first, both rank=1
        expect(linked?.status).toBe("PENDING");
    });
});
