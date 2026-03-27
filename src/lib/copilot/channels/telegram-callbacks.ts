import type { ActionResult } from "../types";
import { executePOSendAction } from "../actions";
import { getPendingPOSend, type PendingPOSend } from "../../purchasing/po-sender";

export interface TelegramPOSendCallbackInput {
    sendId: string;
}

export interface TelegramPOSendCallbackResult {
    pending?: PendingPOSend;
    action: ActionResult;
}

export async function handleTelegramPOSendCallback(
    input: TelegramPOSendCallbackInput,
): Promise<TelegramPOSendCallbackResult> {
    const pending = await getPendingPOSend(input.sendId);
    if (!pending) {
        return {
            action: {
                status: "failed",
                userMessage: 'Send session expired or not found. Please tap "Review & Send" again to re-initiate.',
                logMessage: "telegram callback hit stale or expired PO send session",
                retryAllowed: true,
                safeToRetry: false,
                actionRef: input.sendId,
            },
        };
    }

    const action = await executePOSendAction({
        sendId: input.sendId,
        triggeredBy: "telegram",
    });

    return { pending, action };
}
