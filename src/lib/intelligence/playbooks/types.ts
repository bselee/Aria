/**
 * @file    types.ts
 * @purpose Shared types for the self-healing playbook layer (Plan C).
 *
 *          A Playbook is a typed pair: `match(task) -> params | null` to
 *          extract the work, and `attempt(params, ctx) -> PlaybookResult`
 *          to do it. The runner queries queued tasks, dispatches each to
 *          its registered playbook, and records the outcome on the task.
 */

import type { AgentTask } from "../agent-task";

export type PlaybookSuccess = {
    ok: true;
    summary: string;
    detail?: Record<string, unknown>;
    /** PR URL if the fix opened one; else null. */
    prUrl?: string | null;
};

export type PlaybookFailure = {
    ok: false;
    error: string;
    /** True if the failure is recoverable on retry. False = escalate now. */
    retryable: boolean;
    detail?: Record<string, unknown>;
};

export type PlaybookResult = PlaybookSuccess | PlaybookFailure;

export type PlaybookContext = {
    /** Logger that already prefixes [playbook=kind task=id] for traceability. */
    log: (msg: string, extra?: Record<string, unknown>) => void;
    /** Permission flags read from env (PLAYBOOK_ALLOW_*). */
    allow: {
        dbWrite: boolean;
        forcePush: boolean;
    };
};

export type Playbook<T> = {
    /** The playbook_kind string. Must match the column value verbatim. */
    kind: string;
    /** Short description used in the runner log. */
    description: string;
    /** Pull params from a task row. Return null if this task does not match. */
    match: (task: AgentTask) => T | null;
    /** Run the playbook. Throw only on programmer errors; expected failures should return PlaybookFailure. */
    attempt: (params: T, ctx: PlaybookContext) => Promise<PlaybookResult>;
};
