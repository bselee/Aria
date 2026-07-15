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

import { createClient } from "@/lib/db";
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
        // Was this thread already auto-replied?
        //   no  → next: send_first_ack (Friday-cycle reply)
        //   yes → next: notify_internal_ap (Slack ping to AP team)
        //
        // Note: we only dedupe against Aria's own auto-replies
        // (PAYMENT_INQUIRY_AUTOREPLY). If Will replied manually, Aria may
        // still auto-ack the next ping on this thread. Acceptable for now;
        // upgrade path is to query Gmail thread for our prior sends.
        check_first_contact: {
            run: async (ctx) => {
                const sb = (await import("@/lib/supabase")).createClient();
                if (!sb) return { kind: "retry", reason: "database unavailable" };
                const threadId = ctx.inputs["gmail_thread_id"];
                if (typeof threadId !== "string" || !threadId) {
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
                    return { kind: "succeeded", next: "notify_internal_ap" };
                }
                return { kind: "succeeded", next: "send_first_ack" };
            },
        },

        // ── Step 2a (first contact) ───────────────────────────────────
        // Reply with the Friday-cycle line. Gated by
        // PAYMENT_INQUIRY_AUTOREPLY_ENABLED — default OFF, escalates
        // until Will flips it on.
        send_first_ack: {
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

        // ── Step 2b (second contact) ──────────────────────────────────
        // Vendor pinged again on the same thread after our Friday-cycle
        // reply. Aria can't read Bill.com schedules, so we ping internal
        // AP via Slack with vendor + invoice # + Gmail thread link. The
        // AP team replies with a real status. No agent_task — this lives
        // in Slack so Will isn't pulled in unless AP can't resolve.
        notify_internal_ap: {
            maxAttempts: 3,
            run: async (ctx) => {
                const reply = await import("@/lib/intelligence/payment-inquiry-reply");
                const from = String(ctx.inputs["from"] ?? "");
                const subject = String(ctx.inputs["subject"] ?? "(no subject)");
                const threadId = String(ctx.inputs["gmail_thread_id"] ?? "");
                const snippet = typeof ctx.inputs["snippet"] === "string"
                    ? (ctx.inputs["snippet"] as string)
                    : undefined;
                if (!threadId) {
                    return {
                        kind: "escalate",
                        reason: "second-contact ping has no thread id — manual review",
                    };
                }
                const slacked = await reply.notifyInternalAPSlack({
                    from,
                    subject,
                    gmailThreadId: threadId,
                    snippet,
                });
                if (!slacked.ok) {
                    return { kind: "retry", reason: `slack post failed: ${slacked.error}` };
                }

                // Audit row so the second-contact path is queryable later.
                const sb = (await import("@/lib/supabase")).createClient();
                if (sb) {
                    await sb.from("ap_activity_log").insert({
                        email_from: from,
                        email_subject: subject,
                        intent: "PAYMENT_INQUIRY_AP_PING",
                        action_taken: `Vendor pinged again — Slack message posted to AP channel`,
                        metadata: {
                            gmailThreadId: threadId,
                            gmailMessageId: ctx.inputs["gmail_message_id"],
                            slackTs: slacked.slackTs,
                            reasonCode: "second_contact_ap_ping",
                            sourceInbox: "ap",
                        },
                    });
                }

                return {
                    kind: "succeeded",
                    stateUpdate: {
                        slack_ts: slacked.slackTs,
                        outcome: "second_contact_ap_ping",
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
                    return { kind: "retry", reason: "database unavailable" };
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
