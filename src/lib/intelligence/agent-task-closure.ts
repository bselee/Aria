/**
 * @file    agent-task-closure.ts
 * @purpose Closure-predicate registry + 5-min cron entrypoint that auto-resolves
 *          agent_task rows whose downstream state proves the work is done.
 *
 *          Closure predicates run from the cron set up in OpsManager. Each predicate
 *          kind is a pure async function that returns true ⇒ task is closeable.
 *
 *          Spec: .agents/plans/2026-04-27-task-learning-loop.md §4.2
 */
import { createClient } from "@/lib/supabase";
import { appendEvent, type AgentTask } from "./agent-task";

export type ClosurePredicate =
    | { kind: "agent_boot_after"; agent: string }
    | { kind: "spoke_status"; table: string; value_in: string[] }
    | { kind: "deadline"; max_age_hours: number };

const PREDICATES: Record<string, (task: AgentTask) => Promise<boolean>> = {
    agent_boot_after: async (task) => {
        const cw = task.closes_when as ClosurePredicate & { kind: "agent_boot_after" };
        const supabase = createClient();
        if (!supabase) return false;
        const { data } = await supabase
            .from("agent_heartbeats")
            .select("heartbeat_at, status")
            .eq("agent_name", cw.agent)
            .eq("status", "healthy")
            .maybeSingle();
        if (!data?.heartbeat_at) return false;
        return new Date(data.heartbeat_at) > new Date(task.created_at);
    },

    spoke_status: async (task) => {
        const cw = task.closes_when as ClosurePredicate & { kind: "spoke_status" };
        if (!task.source_id) return false;
        const supabase = createClient();
        if (!supabase) return false;
        const { data } = await supabase
            .from(cw.table)
            .select("status")
            .eq("id", task.source_id)
            .maybeSingle();
        if (!data?.status) return false;
        return cw.value_in.includes(data.status);
    },

    deadline: async (task) => {
        const cw = task.closes_when as ClosurePredicate & { kind: "deadline" };
        const ageMs = Date.now() - new Date(task.created_at).getTime();
        return ageMs > cw.max_age_hours * 3600 * 1000;
    },
};

export async function evaluateClosure(task: AgentTask): Promise<boolean> {
    const cw = task.closes_when as ClosurePredicate | null;
    if (!cw || !cw.kind) return false;
    const fn = PREDICATES[cw.kind];
    if (!fn) return false;
    try {
        return await fn(task);
    } catch {
        return false;
    }
}

export function closesWhenFor(args: {
    type: string;
    sourceTable?: string;
    inputs?: Record<string, unknown>;
}): ClosurePredicate | null {
    if (args.type === "control_command" && args.inputs?.command === "restart_bot") {
        return { kind: "agent_boot_after", agent: "aria-bot" };
    }
    if (
        ["approval", "po_send_confirm", "dropship_forward"].includes(args.type) &&
        args.sourceTable
    ) {
        return {
            kind: "spoke_status",
            table: args.sourceTable,
            value_in: ["approved", "rejected", "completed", "sent", "done"],
        };
    }
    if (args.type === "stuck_source") {
        return { kind: "deadline", max_age_hours: 168 };
    }
    return null;
}

/**
 * Cron-tick entrypoint. Pages every open task with a closes_when predicate,
 * evaluates each, marks SUCCEEDED if true. Returns count of tasks closed.
 *
 * Registered in OpsManager at 5-minute cadence.
 */
export async function closeFinishedTasks(): Promise<number> {
    const supabase = createClient();
    if (!supabase) return 0;
    const { data, error } = await supabase
        .from("agent_task")
        .select("*")
        .in("status", ["PENDING", "NEEDS_APPROVAL", "RUNNING", "CLAIMED"])
        .not("closes_when", "is", null);
    if (error || !data) return 0;

    let closed = 0;
    for (const task of data as AgentTask[]) {
        if (await evaluateClosure(task)) {
            const resolvedStatus = task.closes_when?.kind === "deadline" ? "EXPIRED" : "SUCCEEDED";
            const autoHandledBy = `closure_cron:${task.closes_when?.kind ?? "unknown"}`;
            const { error: upErr } = await supabase
                .from("agent_task")
                .update({
                    status: resolvedStatus,
                    completed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    auto_handled_by: autoHandledBy,
                })
                .eq("id", task.id);
            if (!upErr) {
                closed++;
                await appendEvent(task.id, resolvedStatus === "EXPIRED" ? "expired" : "succeeded", {
                    task_type: task.type,
                    output_summary: `${task.goal} auto-closed`,
                    closes_when: task.closes_when,
                    auto_handled_by: autoHandledBy,
                });
            }
        }
    }
    return closed;
}
