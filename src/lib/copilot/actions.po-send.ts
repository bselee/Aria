/**
 * @file    src/lib/copilot/actions.po-send.ts
 * @purpose Shared PO send action wrapper with structured result statuses.
 *
 *          Wraps commitAndSendPO() from po-sender.ts and converts raw
 *          outcomes (throw, partial email failure, success) into the
 *          shared ActionResult shape so callers never need try/catch.
 *
 *          Session persistence is backed by `copilot_action_sessions` with an
 *          in-memory cache layered on top for same-process reuse.
 */

import { getPendingPOSend, commitAndSendPO } from "../purchasing/po-sender";
import { makeActionResult } from "./actions";
import type { ActionResult } from "./types";

// ── executePOSendAction ───────────────────────────────────────────────────────

export interface POSendActionInput {
    sendId:       string;
    triggeredBy?: "telegram" | "dashboard";
    skipEmail?:   boolean;
}

/**
 * Execute a PO send by sendId.
 *
 * Status semantics:
 *   success         — Finale committed + email sent
 *   partial_success — Finale committed, email failed or skipped (no vendor email)
 *   failed          — session not found / expired / Finale commit failed
 *
 * Never throws — all errors are converted to ActionResult.
 */
export async function executePOSendAction(input: POSendActionInput): Promise<ActionResult> {
    const { sendId, triggeredBy = "telegram", skipEmail = false } = input;

    // Guard: empty or obviously invalid sendId
    if (!sendId) {
        return makeActionResult(
            "failed",
            "No send ID provided — cannot execute PO send.",
            { retryAllowed: false, safeToRetry: false }
        );
    }

    // Guard: session must exist and be fresh
    const pending = await getPendingPOSend(sendId);
    if (!pending) {
        return makeActionResult(
            "failed",
            "This PO send session has expired or was not found. " +
            "Please re-initiate the PO review to generate a fresh send request.",
            { retryAllowed: false, safeToRetry: false }
        );
    }

    try {
        const result = await commitAndSendPO(sendId, triggeredBy, skipEmail);

        // Partial success: Finale committed but email was skipped or unavailable
        if (result.emailSkipped) {
            return makeActionResult(
                "partial_success",
                `PO #${result.orderId} committed in Finale. ` +
                `Email was not sent (${result.sentTo ? "skipped" : "no vendor email on file"}).`,
                {
                    retryAllowed:  false,
                    safeToRetry:   false,
                    actionRef:     `po_send:${result.orderId}`,
                    details:       result,
                }
            );
        }

        return makeActionResult(
            "success",
            `PO #${result.orderId} committed and emailed to ${result.sentTo}.`,
            {
                retryAllowed:  false,
                safeToRetry:   false,
                actionRef:     `po_send:${result.orderId}`,
                details:       result,
            }
        );

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Distinguish email failure from Finale failure where possible
        const isEmailFailure = message.toLowerCase().includes("gmail") ||
                               message.toLowerCase().includes("email") ||
                               message.toLowerCase().includes("send");

        if (isEmailFailure) {
            return makeActionResult(
                "partial_success",
                `PO may have been committed but the email send failed: ${message}. ` +
                `Check Finale and resend manually if needed.`,
                { retryAllowed: false, safeToRetry: false }
            );
        }

        return makeActionResult(
            "failed",
            `PO send failed: ${message}`,
            { retryAllowed: false, safeToRetry: false }
        );
    }
}
