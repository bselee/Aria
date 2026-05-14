/**
 * @file    src/flows/types.ts
 * @purpose Shared types for the flow substrate.
 *
 * Escalation principle: a step that cannot resolve must explicitly choose
 * its outcome — retry, wait for an external event, or escalate to Will.
 * Silent stalls are not possible because every step result is one of:
 *   - succeeded  (done; optionally hop to a next step)
 *   - retry      (try again next tick; bumps run.attempts; auto-escalates
 *                 after maxAttempts)
 *   - waiting    (do nothing; an inbound event must advance this run)
 *   - escalate   (BREACH the run; surface to Will via agent_task)
 */

export type FlowRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "BREACHED";

export interface FlowEventRow {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    correlation_id: string | null;
    emitted_at: string;
    processed_at: string | null;
}

export interface FlowRunRow {
    id: string;
    flow_name: string;
    status: FlowRunStatus;
    current_step: string | null;
    triggered_by_event: string | null;
    correlation_id: string | null;
    inputs: Record<string, unknown>;
    state: Record<string, unknown>;
    attempts: number;
    deadline_at: string | null;
    failure_reason: string | null;
    escalated_task_id: string | null;
    started_at: string;
    updated_at: string;
    completed_at: string | null;
}

export type StepResult =
    | { kind: "succeeded"; stateUpdate?: Record<string, unknown>; next?: string }
    | { kind: "retry"; reason: string; stateUpdate?: Record<string, unknown> }
    | { kind: "waiting"; reason?: string; stateUpdate?: Record<string, unknown> }
    | { kind: "escalate"; reason: string; stateUpdate?: Record<string, unknown> };

export interface StepCtx {
    runId: string;
    flowName: string;
    inputs: Record<string, unknown>;
    state: Record<string, unknown>;
    event: FlowEventRow | null;
    attempts: number;
}

export interface StepDef {
    /** Max attempts before auto-escalate. Default 3. */
    maxAttempts?: number;
    run: (ctx: StepCtx) => Promise<StepResult>;
}

export interface FlowDef {
    name: string;
    /** Event types that spawn a NEW run of this flow. */
    on: string[];
    /** Map event payload → initial run state. */
    init: (event: FlowEventRow) => {
        inputs: Record<string, unknown>;
        correlationId?: string;
        deadlineMs?: number;
    };
    firstStep: string;
    steps: Record<string, StepDef>;
}
