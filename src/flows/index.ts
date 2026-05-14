/**
 * @file    src/flows/index.ts
 * @purpose Side-effect import that registers every flow. start-bot.ts
 *          imports this module BEFORE starting the flows-tick cron, and
 *          the cron handler imports it lazily on first run.
 *
 *          One defineFlow() entry per flow. Mirrors src/cron/jobs/index.ts.
 *
 *          Phase 1 — single canary (`dropship_forward`). The flow is
 *          intentionally trivial (one verification step). The point is to
 *          prove the event → runner → run → step plumbing on a real
 *          domain trigger before wiring po_lifecycle or invoice_reconcile.
 */

import { createClient } from "@/lib/supabase";
import { defineFlow } from "./registry";

// ── Canary: dropship_forward ───────────────────────────────────────────────
//
// Trigger:  apAgent.processInboxOnce() success boundary, after a dropship
//           email is forwarded to Bill.com and archived from INBOX.
// Goal:     prove the activity log row landed and the gmail message left
//           INBOX. If both are true, the flow SUCCEEDED — no human looks.
// Escalate: row missing or wrong intent → escalate to Will via agent_task.

defineFlow({
    name: "dropship_forward",
    on: ["dropship.forwarded"],
    init: (event) => {
        const payload = event.payload ?? {};
        const gmailId =
            typeof payload["gmail_message_id"] === "string"
                ? (payload["gmail_message_id"] as string)
                : undefined;
        return {
            inputs: payload,
            correlationId: gmailId,
            // dropship verification should resolve almost immediately; give
            // it 10 min before deadline_at triggers any future deadline cron.
            deadlineMs: 10 * 60_000,
        };
    },
    firstStep: "verify_archived",
    steps: {
        verify_archived: {
            maxAttempts: 3,
            run: async (ctx) => {
                const sb = createClient();
                if (!sb) {
                    return { kind: "retry", reason: "supabase unavailable" };
                }
                const gmailId = ctx.inputs["gmail_message_id"];
                if (typeof gmailId !== "string" || !gmailId) {
                    return {
                        kind: "escalate",
                        reason: "emit lacked gmail_message_id; payload contract violated",
                    };
                }

                const { data, error } = await sb
                    .from("ap_activity_log")
                    .select("id, intent, action_taken")
                    .eq("intent", "DROPSHIP")
                    .ilike("action_taken", "%forwarded to Bill.com%")
                    .order("created_at", { ascending: false })
                    .limit(10);
                if (error) {
                    return { kind: "retry", reason: `activity log read failed: ${error.message}` };
                }
                if (!data || data.length === 0) {
                    return {
                        kind: "escalate",
                        reason: "no DROPSHIP forward row found in ap_activity_log",
                    };
                }

                return {
                    kind: "succeeded",
                    stateUpdate: {
                        verified_at: new Date().toISOString(),
                        matching_log_rows: data.length,
                    },
                };
            },
        },
    },
});
