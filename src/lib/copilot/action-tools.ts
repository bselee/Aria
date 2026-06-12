/**
 * @file    src/lib/copilot/action-tools.ts
 * @purpose Write/action tools exposed to the conversational copilot (Telegram + Dashboard).
 *          These wrap the gated executors in actions.ts and actions.po-send.ts.
 *          All destructive actions go through validateWriteIntent confirmation.
 *
 * @author  Hermia
 * @created 2026-06-12
 */

import { tool } from "ai";
import { z } from "zod";
import {
  validateWriteIntent,
  executePOSendAction,
  type ExecutePOSendActionInput,
} from "./actions";

/**
 * Action tool definitions for the copilot.
 * These are the tools the Telegram agent can now call to solve problems.
 */
export function getCopilotActionTools(opts?: { threadId?: string }) {
  return {
    /**
     * Commit and send a purchase order.
     * Requires explicit user intent + single target.
     */
    commit_and_send_po: tool({
      description: "Commit a draft PO in Finale and optionally email it to the vendor. Use when the user explicitly wants to approve and send an order.",
      inputSchema: z.object({
        sendId: z.string().describe("The send session ID or PO identifier to commit"),
        skipEmail: z.boolean().optional().describe("Skip vendor email (default false)"),
      }),
      execute: async ({ sendId, skipEmail }) => {
        // The actual execution is gated by validateWriteIntent in the core turn.
        // This tool is only callable after confirmation.
        const result = await executePOSendAction({
          sendId,
          triggeredBy: "telegram",
          skipEmail: skipEmail ?? false,
        });

        return result.userMessage;
      },
    }),

    /**
     * Placeholder for future action tools (approve task, create draft, escalate, etc.)
     * Add new ones here as we wire more autonomy actions.
     */
  };
}
