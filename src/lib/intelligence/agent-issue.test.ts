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

import { createOrAdvance } from "./agent-issue";

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
            // ...and a safe metadata bump that SHOULD apply:
            priority: 1,
            inputs: { task_count: 4 },
        });

        expect(appliedPatch).not.toBeNull();
        // Lifecycle / autonomy / handler / next_action MUST be omitted from the patch.
        expect(appliedPatch).not.toHaveProperty("lifecycle_state");
        expect(appliedPatch).not.toHaveProperty("autonomy_state");
        expect(appliedPatch).not.toHaveProperty("current_handler");
        expect(appliedPatch).not.toHaveProperty("next_action");
        // Safe metadata DID apply.
        expect(appliedPatch).toHaveProperty("priority", 1);
        expect(appliedPatch).toHaveProperty("inputs");
    });
});
