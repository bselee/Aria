/**
 * @file    src/lib/copilot/channels/telegram-callbacks.ts
 * @purpose Telegram callback recovery for PO send and other action sessions.
 *
 *          After a bot restart, in-memory pending sessions are gone.
 *          This handler intercepts stale/expired callback payloads and
 *          returns clean user-facing recovery messages instead of silently
 *          failing or throwing.
 *
 *          Hot path (warm session): falls through to existing callback handlers
 *          in start-bot.ts unchanged — this module only handles the recovery case.
 */

import { getPendingPOSend } from "../../purchasing/po-sender";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TelegramCallbackInput {
    callbackData: string;
}

export interface TelegramCallbackResult {
    /** true if the callback was recovered and re-routed to a fresh action */
    recovered:    boolean;
    /** Message to send back to the user */
    userMessage:  string;
}

// ── Known callback prefixes ───────────────────────────────────────────────────

const PO_CONFIRM_SEND_PREFIX = "po_confirm_send_";
const PO_CANCEL_SEND_PREFIX  = "po_cancel_send_";

// ── handleTelegramCallback ────────────────────────────────────────────────────

/**
 * Inspect a Telegram callback payload and return a recovery result.
 *
 * Scenarios handled:
 *   - po_confirm_send_{id}: check if session is alive; if not, return recovery message
 *   - po_cancel_send_{id}: same check
 *   - anything else: return clean unknown-callback message
 *
 * Never throws.
 */
export async function handleTelegramCallback(
    input: TelegramCallbackInput
): Promise<TelegramCallbackResult> {
    const { callbackData } = input;

    try {
        if (!callbackData) {
            return {
                recovered:   false,
                userMessage: "Empty callback received — nothing to do.",
            };
        }

        // ── PO send confirm/cancel ────────────────────────────────────────────
        const isPOConfirm = callbackData.startsWith(PO_CONFIRM_SEND_PREFIX);
        const isPOCancel  = callbackData.startsWith(PO_CANCEL_SEND_PREFIX);

        if (isPOConfirm || isPOCancel) {
            const sendId = isPOConfirm
                ? callbackData.slice(PO_CONFIRM_SEND_PREFIX.length)
                : callbackData.slice(PO_CANCEL_SEND_PREFIX.length);

            const pending = getPendingPOSend(sendId);

            if (!pending) {
                return {
                    recovered:   false,
                    userMessage: "This PO send session has expired (the bot may have restarted). " +
                                 "Please re-initiate the review with `/review_po` or `review and send PO` " +
                                 "to generate a fresh request.",
                };
            }

            // Session is alive — caller handles the warm path
            return {
                recovered:   true,
                userMessage: "",
            };
        }

        // ── Unknown callback ──────────────────────────────────────────────────
        return {
            recovered:   false,
            userMessage: "Unrecognized callback. If this button was from an older session it may have expired — try re-initiating the action.",
        };

    } catch {
        return {
            recovered:   false,
            userMessage: "Something went wrong handling that callback. Please try again.",
        };
    }
}
