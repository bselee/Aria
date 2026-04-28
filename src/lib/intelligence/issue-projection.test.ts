import { describe, expect, it } from "vitest";
import { businessFlowKey, groupTasksByFlow, deriveIssueState } from "./issue-projection";
import type { AgentTask } from "./agent-task";

const baseTask: any = {
    id: "t1",
    type: "approval",
    source_table: "ap_pending_approvals",
    source_id: "src-1",
    goal: "x",
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
    max_retries: 3,
    deadline_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    claimed_at: null,
    claimed_by: null,
    completed_at: null,
};

describe("businessFlowKey", () => {
    it("uses vendor + invoice_number when both present", () => {
        const t = { ...baseTask, inputs: { vendor_name: "Colorado Worm Co.", invoice_number: "124618" } } as AgentTask;
        expect(businessFlowKey(t)).toBe("colorado-worm-co.|inv:124618");
    });

    it("uses vendor + po_number when invoice missing", () => {
        const t = { ...baseTask, inputs: { vendor_name: "ULINE", po_number: "12345" } } as AgentTask;
        expect(businessFlowKey(t)).toBe("uline|po:12345");
    });

    it("uses vendor + order_id when invoice + PO missing", () => {
        const t = { ...baseTask, inputs: { vendor_name: "FedEx", order_id: "ord-9" } } as AgentTask;
        expect(businessFlowKey(t)).toBe("fedex|ord:ord-9");
    });

    it("falls back to source_table:source_id when no vendor present", () => {
        const t = { ...baseTask, inputs: {} } as AgentTask;
        expect(businessFlowKey(t)).toBe("ap_pending_approvals:src-1");
    });

    it("returns null for manual tasks (no source, no vendor)", () => {
        const t = { ...baseTask, source_table: null, source_id: null, inputs: {} } as AgentTask;
        expect(businessFlowKey(t)).toBeNull();
    });
});

describe("groupTasksByFlow", () => {
    it("groups tasks with the same business_flow_key", () => {
        const tasks = [
            { ...baseTask, id: "t1", inputs: { vendor_name: "ULINE", invoice_number: "INV-1" } },
            { ...baseTask, id: "t2", inputs: { vendor_name: "ULINE", invoice_number: "INV-1" } },
            { ...baseTask, id: "t3", inputs: { vendor_name: "FedEx", invoice_number: "INV-2" } },
        ] as AgentTask[];
        const groups = groupTasksByFlow(tasks);
        expect(groups.size).toBe(2);
        expect(groups.get("uline|inv:INV-1")?.length).toBe(2);
        expect(groups.get("fedex|inv:INV-2")?.length).toBe(1);
    });

    it("skips tasks where businessFlowKey returns null", () => {
        const tasks = [
            { ...baseTask, id: "t1", source_table: null, source_id: null, inputs: {} },
            { ...baseTask, id: "t2", inputs: { vendor_name: "ULINE", invoice_number: "INV-1" } },
        ] as AgentTask[];
        const groups = groupTasksByFlow(tasks);
        expect(groups.size).toBe(1);
    });
});

describe("deriveIssueState", () => {
    it("returns working when at least one task is open", () => {
        const tasks = [
            { ...baseTask, status: "SUCCEEDED" },
            { ...baseTask, status: "PENDING" },
        ] as AgentTask[];
        const s = deriveIssueState(tasks);
        expect(s.lifecycle_state).toBe("working");
    });

    it("returns complete when all tasks terminal-success", () => {
        const tasks = [
            { ...baseTask, status: "SUCCEEDED", completed_at: new Date().toISOString() },
        ] as AgentTask[];
        const s = deriveIssueState(tasks);
        expect(s.lifecycle_state).toBe("complete");
    });

    it("does NOT mark blocked just because the latest task is FAILED", () => {
        const tasks = [{ ...baseTask, status: "FAILED" }] as AgentTask[];
        const s = deriveIssueState(tasks);
        // Phase 1 projection never sets blocked — that's reserved for explicit
        // setBlocker() calls. Failed tasks are still 'working' / retrying.
        expect(s.lifecycle_state).toBe("working");
        expect(s.autonomy_state).toBe("retrying");
    });

    it("returns triaging when only one task and it's PENDING with no claim", () => {
        const tasks = [{ ...baseTask, status: "PENDING", claimed_at: null }] as AgentTask[];
        const s = deriveIssueState(tasks);
        expect(s.lifecycle_state).toBe("triaging");
    });

    it("retrying when open + at least one failed", () => {
        const tasks = [
            { ...baseTask, status: "FAILED" },
            { ...baseTask, status: "PENDING" },
        ] as AgentTask[];
        const s = deriveIssueState(tasks);
        expect(s.autonomy_state).toBe("retrying");
    });
});
