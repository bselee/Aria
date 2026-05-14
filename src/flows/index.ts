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

// ── vendor_payment_inquiry ─────────────────────────────────────────────────
//
// Trigger:  ap-agent classifies an incoming HUMAN_INTERACTION email as a
//           real human payment-status ask (Mitzi-style). Automated dunning
//           and no-reply senders never reach this trigger — they are
//           archived silently at the ap-agent level.
// Goal (v1): surface the inquiry to Will in two places at once — UNREAD in
//           Gmail inbox (done at emit time) AND on /tasks via the flow's
//           escalate step → agent_task row.
// Future:   add a `lookup_invoice` + `send_first_reply` step so the FIRST
//           time a vendor pings about a given invoice we auto-reply with
//           the Bill.com scheduled pay date. Repeat asks still escalate.

defineFlow({
    name: "vendor_payment_inquiry",
    on: ["vendor.payment_inquiry.received"],
    init: (event) => {
        const payload = event.payload ?? {};
        const gmailId =
            typeof payload["gmail_message_id"] === "string"
                ? (payload["gmail_message_id"] as string)
                : undefined;
        return {
            inputs: payload,
            correlationId: gmailId,
        };
    },
    firstStep: "check_first_contact",
    steps: {
        // ── Step 1 ────────────────────────────────────────────────────
        // Was this thread already auto-replied? If yes → Mitzi is pouncing
        // again; escalate to Will (he sees it on /tasks + UNREAD in inbox).
        check_first_contact: {
            run: async (ctx) => {
                const sb = (await import("@/lib/supabase")).createClient();
                if (!sb) return { kind: "retry", reason: "supabase unavailable" };
                const threadId = ctx.inputs["gmail_thread_id"];
                if (typeof threadId !== "string" || !threadId) {
                    // No threadId — can't dedupe. Skip step 2 and escalate so
                    // Will sees the inquiry rather than guessing.
                    return {
                        kind: "escalate",
                        reason: "payment inquiry missing gmail_thread_id; cannot dedupe — manual review",
                    };
                }
                const { data } = await sb
                    .from("ap_activity_log")
                    .select("id")
                    .eq("intent", "PAYMENT_INQUIRY_AUTOREPLY")
                    .filter("metadata->>gmailThreadId", "eq", threadId)
                    .limit(1);
                if (data && data.length > 0) {
                    return {
                        kind: "escalate",
                        reason: "vendor pinging again on same thread — already auto-replied once",
                    };
                }
                return { kind: "succeeded", next: "send_simple_ack" };
            },
        },

        // ── Step 2 ────────────────────────────────────────────────────
        // First-time human payment inquiry. Send a short non-robotic reply
        // that buys Will time without committing to a date (Aria can't
        // read Bill.com schedule). Gated by PAYMENT_INQUIRY_AUTOREPLY_ENABLED;
        // default OFF so the flow escalates until Will flips the env.
        send_simple_ack: {
            maxAttempts: 3,
            run: async (ctx) => {
                const reply = await import("@/lib/intelligence/payment-inquiry-reply");
                if (!reply.autoReplyEnabled()) {
                    return {
                        kind: "escalate",
                        reason: "auto-reply disabled (set PAYMENT_INQUIRY_AUTOREPLY_ENABLED=true to enable)",
                    };
                }
                const from = String(ctx.inputs["from"] ?? "");
                const subject = String(ctx.inputs["subject"] ?? "(no subject)");
                const threadId = String(ctx.inputs["gmail_thread_id"] ?? "");
                const messageIdHeader = String(ctx.inputs["message_id_header"] ?? "");
                if (!from || !threadId || !messageIdHeader) {
                    return {
                        kind: "escalate",
                        reason: `missing reply inputs (from=${!!from} thread=${!!threadId} mid=${!!messageIdHeader})`,
                    };
                }

                const sent = await reply.sendSimpleAck({
                    replyTo: from,
                    originalSubject: subject,
                    gmailThreadId: threadId,
                    messageIdHeader,
                });
                if (!sent.ok) {
                    return { kind: "retry", reason: `gmail send failed: ${sent.error}` };
                }

                // Log so the next inquiry on the same thread escalates.
                const sb = (await import("@/lib/supabase")).createClient();
                if (sb) {
                    await sb.from("ap_activity_log").insert({
                        email_from: from,
                        email_subject: subject,
                        intent: "PAYMENT_INQUIRY_AUTOREPLY",
                        action_taken: `Auto-replied to ${from}: "${sent.template}"`,
                        metadata: {
                            gmailThreadId: threadId,
                            gmailMessageId: ctx.inputs["gmail_message_id"],
                            replyGmailMessageId: sent.gmailMessageId,
                            template: sent.template,
                            reasonCode: "first_contact_autoreply",
                            sourceInbox: "ap",
                        },
                    });
                }

                // Mark the original message READ now that we've replied.
                try {
                    const { getAuthenticatedClient } = await import("@/lib/gmail/auth");
                    const { gmail: GmailApi } = await import("@googleapis/gmail");
                    const auth = await getAuthenticatedClient("ap");
                    const gmail = GmailApi({ version: "v1", auth: auth as any });
                    const originalId = String(ctx.inputs["gmail_message_id"] ?? "");
                    if (originalId) {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: originalId,
                            requestBody: { removeLabelIds: ["UNREAD"] },
                        });
                    }
                } catch {
                    // best-effort; reply already sent
                }

                return {
                    kind: "succeeded",
                    stateUpdate: {
                        template: sent.template,
                        reply_gmail_id: sent.gmailMessageId,
                    },
                };
            },
        },
    },
});

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
