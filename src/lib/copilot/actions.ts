/**
 * @file    src/lib/copilot/actions.ts
 * @purpose Write-gating rules for the shared copilot action layer.
 *
 *          Writes may only execute when BOTH conditions are met:
 *            1. The user uses an explicit action verb (create, approve, send, etc.)
 *            2. The request is bound to exactly ONE concrete target
 *
 *          If either condition fails, return needs_confirmation with a
 *          user-readable message explaining what is missing.
 *
 *          This replaces vague "intent confidence" with testable execution rules.
 */

import type { ActionResult } from "./types";
import { commitAndSendPO } from "../purchasing/po-sender";

// ── Write verbs ───────────────────────────────────────────────────────────────

const WRITE_VERBS = [
    /\bcreate\b/i,
    /\bapprove\b/i,
    /\bcommit\b/i,
    /\bsend\b/i,
    /\bdismiss\b/i,
    /\badd to po\b/i,
    /\badd these\b/i,
    /\badd those\b/i,
    /\bupdate\b/i,
    /\bconfirm\b/i,
    /\bdraft\b/i,
];

// ── Types ─────────────────────────────────────────────────────────────────────

export type WriteIntentStatus = "allowed" | "needs_confirmation" | "no_write";

export interface WriteIntentResult {
    status:      WriteIntentStatus;
    userMessage: string;
    /** The single confirmed target ID when status === "allowed" */
    targetId?:   string;
}

export interface WriteIntentInput {
    text:             string;
    /** Resolved candidate target IDs from context (0 = unbound, 1 = allowed, 2+ = ambiguous) */
    candidateTargets: string[];
}

// ── validateWriteIntent ───────────────────────────────────────────────────────

/**
 * Gate write execution.
 *
 * Rules:
 *   - No explicit verb         → no_write     (read path handles it)
 *   - Explicit verb + 1 target → allowed
 *   - Explicit verb + 0 target → needs_confirmation  (nothing to act on)
 *   - Explicit verb + N target → needs_confirmation  (ambiguous — which one?)
 */
export async function validateWriteIntent(input: WriteIntentInput): Promise<WriteIntentResult> {
    const { text, candidateTargets } = input;

    const hasVerb = WRITE_VERBS.some(re => re.test(text));

    if (!hasVerb) {
        return {
            status:      "no_write",
            userMessage: "",
        };
    }

    if (candidateTargets.length === 1) {
        return {
            status:      "allowed",
            userMessage: "",
            targetId:    candidateTargets[0],
        };
    }

    if (candidateTargets.length === 0) {
        return {
            status:      "needs_confirmation",
            userMessage: "I can see you want to take an action, but I need a specific target to act on. " +
                         "Which PO, approval, or item did you have in mind?",
        };
    }

    // Multiple candidates — ask which one
    return {
        status:      "needs_confirmation",
        userMessage: `I found ${candidateTargets.length} possible targets for that action. ` +
                     "Can you be more specific about which one you mean?",
    };
}

// ── makeActionResult ──────────────────────────────────────────────────────────

/** Convenience factory for structured action results */
export function makeActionResult(
    status: ActionResult["status"],
    userMessage: string,
    opts: Partial<Omit<ActionResult, "status" | "userMessage">> = {}
): ActionResult {
    return {
        status,
        userMessage,
        logMessage:   opts.logMessage   ?? userMessage,
        retryAllowed: opts.retryAllowed ?? false,
        safeToRetry:  opts.safeToRetry  ?? false,
        actionRef:    opts.actionRef,
        details:      opts.details,
    };
}

export interface ExecutePOSendActionInput {
    sendId: string;
    triggeredBy: "telegram" | "dashboard";
    skipEmail?: boolean;
}

export async function executePOSendAction(input: ExecutePOSendActionInput): Promise<ActionResult> {
    try {
        const result = await commitAndSendPO(
            input.sendId,
            input.triggeredBy,
            input.skipEmail ?? false,
        );

        if (result.emailError) {
            return makeActionResult(
                "partial_success",
                `PO #${result.orderId} committed in Finale, but vendor email failed: ${result.emailError}`,
                {
                    actionRef: input.sendId,
                    retryAllowed: false,
                    safeToRetry: false,
                    details: result,
                },
            );
        }

        return makeActionResult(
            "success",
            `PO #${result.orderId} committed in Finale${result.sentTo ? ` and emailed to ${result.sentTo}` : ""}`,
            {
                actionRef: input.sendId,
                retryAllowed: false,
                safeToRetry: false,
                details: result,
            },
        );
    } catch (err: any) {
        const userMessage = /expired|not found/i.test(err.message)
            ? "Send session expired or not found — start a new review."
            : `Failed to commit/send PO: ${err.message}`;

        return makeActionResult("failed", userMessage, {
            actionRef: input.sendId,
            retryAllowed: /expired|not found/i.test(err.message),
            safeToRetry: false,
            details: { error: err.message },
        });
    }
}
