/**
 * @file    register-gmail-tools.ts
 * @purpose Phase 2 (cont'd): register Gmail operations with the Aria-wide
 *          tool registry so they show in the catalog and can be wrapped
 *          by withToolAudit at call sites. Initial migration covers the
 *          highest-leverage call (forwardToBillCom — the email that
 *          triggers vendor payment); the 11 messages.modify calls in
 *          ap-agent.ts will be migrated as separate commits.
 */

import { registerTool } from "./tool-registry";

let registered = false;

export function ensureGmailToolsRegistered(): void {
    if (registered) return;

    // ── Reads ───────────────────────────────────────────────────────────────
    registerTool({
        name: "gmail_list_messages",
        description: "List unread or filtered messages from a Gmail inbox.",
        category: "gmail",
        scope: "read",
        agentScope: [],
    });
    registerTool({
        name: "gmail_get_message",
        description: "Fetch a single Gmail message by id (headers + body + attachments).",
        category: "gmail",
        scope: "read",
        agentScope: [],
    });
    registerTool({
        name: "gmail_get_attachment",
        description: "Fetch a single attachment payload from a Gmail message.",
        category: "gmail",
        scope: "read",
        agentScope: [],
    });
    registerTool({
        name: "gmail_list_labels",
        description: "List all labels in a Gmail account.",
        category: "gmail",
        scope: "read",
        agentScope: [],
    });

    // ── Writes (gated to AP agent + AP reconciler) ──────────────────────────
    registerTool({
        name: "gmail_modify_labels",
        description: "Add/remove labels on a Gmail message (mark read, archive, file).",
        category: "gmail",
        scope: "write",
        agentScope: ["ap-agent", "ap-reconciler"],
    });
    registerTool({
        name: "gmail_create_label",
        description: "Create a new Gmail label.",
        category: "gmail",
        scope: "write",
        agentScope: ["ap-agent"],
    });
    registerTool({
        name: "gmail_send_message",
        description: "Send an outbound email (used to forward invoices to bill.com).",
        category: "gmail",
        scope: "write",
        agentScope: ["ap-agent"],
    });

    registered = true;
}

/** TEST ONLY — reset the idempotency latch. */
export function __resetGmailToolsLatchForTests(): void {
    registered = false;
}
