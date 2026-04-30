/**
 * @file    issue-state-machine.ts
 * @purpose Centralized issue lifecycle transition guard. Prevents the
 *          orchestrator, Telegram, dashboard, and projection cron from
 *          each inventing their own transition rules. The orchestrator
 *          (Task 4) and the issue-control service (Task 5) consult this
 *          before any lifecycle write.
 *
 *          Plan task 2 (docs/plans/2026-04-30-agentic-issue-orchestrator-control.md).
 */

import type { IssueLifecycleState } from "./agent-issue";

export type IssueTransitionIntent =
    | "projection"        // backfill cron — never sets blocked / clears blocked
    | "set_blocker"       // explicit blocker write (only path INTO blocked)
    | "clear_blocker"     // explicit blocker clear (only path OUT of blocked)
    | "handoff"           // human or agent reassignment, lifecycle stays
    | "complete"          // terminal close
    | "manual_control"    // Will overriding via Telegram or dashboard
    | "orchestrator";     // automated runtime decision

export type IssueTransitionCheck = {
    from: IssueLifecycleState;
    to: IssueLifecycleState;
    intent: IssueTransitionIntent;
    actor: string;        // e.g. "issue-projection", "will-telegram", "ap-reconciler"
    force?: boolean;      // overrides specific guards when true (human actor only)
};

export type IssueTransitionResult =
    | { ok: true }
    | { ok: false; reason: string };

/**
 * Decide whether a lifecycle transition is legal.
 *
 * Rules (in order — first match wins):
 *   1. Same-state writes (from === to) are always ok (idempotent).
 *   2. Reopening complete requires force=true.
 *   3. Leaving blocked requires intent=clear_blocker, OR
 *      intent=complete with force=true AND a human actor (will-* prefix).
 *   4. Entering blocked requires intent=set_blocker.
 *   5. All other open-state transitions are allowed.
 */
export function canTransitionIssue(input: IssueTransitionCheck): IssueTransitionResult {
    if (input.from === input.to) return { ok: true };

    if (input.from === "complete" && !input.force) {
        return { ok: false, reason: "complete issues cannot be reopened without force" };
    }

    if (input.from === "blocked" && input.to !== "blocked") {
        if (input.intent === "clear_blocker") return { ok: true };
        // Allow direct blocked → complete only when a human forces it.
        if (input.intent === "complete" && input.force === true && input.actor.startsWith("will-")) {
            return { ok: true };
        }
        return { ok: false, reason: "blocked issues require clear_blocker before lifecycle advance" };
    }

    if (input.to === "blocked") {
        return input.intent === "set_blocker"
            ? { ok: true }
            : { ok: false, reason: "blocked requires set_blocker intent" };
    }

    return { ok: true };
}
