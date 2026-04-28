/**
 * @file    issue-projection.ts
 * @purpose Pure logic to group agent_task rows under business-flow keys
 *          and derive an issue's lifecycle/autonomy from its tasks.
 *
 *          The projection cron (issue-projection-cron.ts) wires these
 *          helpers to live data. These functions take and return plain
 *          values so they can be unit-tested without DB mocks.
 *
 *          Behavioral guardrail (Will, 2026-04-28): `blocked` is reserved
 *          for explicit setBlocker() calls — the projection never sets it
 *          based on FAILED task status alone. A failed task means
 *          `working` / autonomy_state = `retrying` until retry budget
 *          exhausts, at which point a real blocker will be set elsewhere.
 */

import type { AgentTask } from "./agent-task";
import type { IssueLifecycleState, IssueAutonomyState } from "./agent-issue";

const OPEN_TASK_STATUSES = new Set(["PENDING", "CLAIMED", "RUNNING", "NEEDS_APPROVAL"]);
const TERMINAL_SUCCESS = new Set(["SUCCEEDED", "APPROVED"]);

function slugify(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.\-]/g, "");
}

/**
 * Compute the business-flow key for a task. Returns null when the task is
 * not groupable (no source, no vendor) — the caller should drop it.
 */
export function businessFlowKey(task: AgentTask): string | null {
    const inputs = task.inputs as Record<string, unknown>;
    const vendor = typeof inputs?.vendor_name === "string" ? slugify(inputs.vendor_name as string) : null;
    const invoice = typeof inputs?.invoice_number === "string" ? inputs.invoice_number : null;
    const po = typeof inputs?.po_number === "string" ? inputs.po_number : null;
    const orderId = typeof inputs?.order_id === "string" ? inputs.order_id : null;

    if (vendor && invoice) return `${vendor}|inv:${invoice}`;
    if (vendor && po) return `${vendor}|po:${po}`;
    if (vendor && orderId) return `${vendor}|ord:${orderId}`;

    if (task.source_table && task.source_id) {
        return `${task.source_table}:${task.source_id}`;
    }
    return null;
}

export function groupTasksByFlow(tasks: AgentTask[]): Map<string, AgentTask[]> {
    const groups = new Map<string, AgentTask[]>();
    for (const t of tasks) {
        const key = businessFlowKey(t);
        if (!key) continue;
        const arr = groups.get(key) ?? [];
        arr.push(t);
        groups.set(key, arr);
    }
    return groups;
}

export type DerivedIssueState = {
    lifecycle_state: IssueLifecycleState;
    autonomy_state: IssueAutonomyState;
    title: string;
    owner: string;
    digest: Record<string, unknown>;
};

export function deriveIssueState(tasks: AgentTask[]): DerivedIssueState {
    if (tasks.length === 0) {
        return { lifecycle_state: "detected", autonomy_state: "working", title: "", owner: "aria", digest: {} };
    }
    const sorted = [...tasks].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    const latest = sorted[0];

    const hasOpen = tasks.some(t => OPEN_TASK_STATUSES.has(t.status));
    const allTerminalSuccess = tasks.every(t => TERMINAL_SUCCESS.has(t.status));
    const anyFailed = tasks.some(t => t.status === "FAILED");

    let lifecycle_state: IssueLifecycleState = "working";
    let autonomy_state: IssueAutonomyState = "working";

    if (allTerminalSuccess) {
        lifecycle_state = "complete";
        autonomy_state = "resolved";
    } else if (hasOpen) {
        if (tasks.length === 1 && latest.status === "PENDING" && !latest.claimed_at) {
            lifecycle_state = "triaging";
            autonomy_state = "waiting";
        } else if (anyFailed) {
            lifecycle_state = "working";
            autonomy_state = "retrying";
        } else {
            lifecycle_state = "working";
            autonomy_state = "working";
        }
    } else if (anyFailed) {
        // All tasks terminal but at least one failed and none succeeded → retrying.
        // Phase 1 still does NOT set blocked here; explicit setBlocker is the only path.
        lifecycle_state = "working";
        autonomy_state = "retrying";
    }

    return {
        lifecycle_state,
        autonomy_state,
        title: latest.goal,
        owner: latest.owner ?? "aria",
        digest: {
            task_count: tasks.length,
            statuses: Array.from(new Set(tasks.map(t => t.status))),
            latest_task_id: latest.id,
            latest_status: latest.status,
        },
    };
}
