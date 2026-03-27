import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { unifiedObjectGeneration } from "./llm";
import { createClient } from "../supabase";
import { z } from "zod";
import { recall } from "./memory";
import { applyMessageLabelPolicy } from "./gmail-policy";
import { recordHumanFollowUpRequired, recordSimpleAutoReply } from "./email-feedback";

/**
 * @file acknowledgement-agent.ts
 * @purpose Scans inbox for routine informational emails (order confirmations, PO updates, tracking, invoices)
 *          that don't require human action, sends a polite "Thanks!" reply if applicable, and archives them.
 * @author Antigravity
 * @updated 2026-03-13 — cost-data upgrade guard + full body text for inline invoices (PO #124462 fix)
 */
export class AcknowledgementAgent {
    private tokenIdentifier: string;
    private labelCache = new Map<string, string>();

    // Random variations for a natural feel
    private responses = [
        "Thanks! Appreciate the help!",
        "Thanks!",
        "Got it, thanks!",
        "Received, thank you!",
        "Perfect, thanks for the update!",
        "Thanks for sending this over!"
    ];

    constructor(tokenIdentifier: string = "default") {
        this.tokenIdentifier = tokenIdentifier;
    }

    // DECISION(2026-03-24): System sender addresses that ARIA should never auto-reply to.
    // These are internal pipeline senders (Stockie alerts, etc.) that feed ARIA data
    // but should not receive "Thanks!" or follow-up responses.
    private static SYSTEM_SENDERS = [
        'dev@plutonian.io',   // Stockie Low Stock Alert — triggers OOS report pipeline
    ];

    // DECISION(2026-03-24): Subject patterns for ARIA's own outbound reports.
    // These should never get auto-replies, follow-ups, or any processing.
    private static SYSTEM_SUBJECT_PATTERNS = [
        /^OOS Report\b/i,             // ARIA's OOS report emails
        /^Out Of Stock\b/i,           // Stockie alert subject
    ];

    private isSystemSender(from: string): boolean {
        const lowerFrom = from.toLowerCase();
        return AcknowledgementAgent.SYSTEM_SENDERS.some(s => lowerFrom.includes(s));
    }

    private isSystemSubject(subject: string): boolean {
        return AcknowledgementAgent.SYSTEM_SUBJECT_PATTERNS.some(p => p.test(subject));
    }

    private isNoReply(from: string): boolean {
        const lowerFrom = from.toLowerCase();
        return lowerFrom.includes("noreply") ||
            lowerFrom.includes("no-reply") ||
            lowerFrom.includes("donotreply") ||
            lowerFrom.includes("postmaster") ||
            lowerFrom.includes("system@") ||
            lowerFrom.includes("mailer-daemon") ||
            lowerFrom.includes("bounce") ||
            lowerFrom.includes("@send.");
    }

    private async addMessageLabels(gmail: any, gmailMessageId: string, labelNames: string[]): Promise<void> {
        await applyMessageLabelPolicy({
            gmail,
            gmailMessageId,
            addLabels: labelNames,
            labelCache: this.labelCache,
        });
    }

    private looksLikeConversationThread(subject: string, bodyText: string): boolean {
        if (/^re:/i.test(subject) && /\n\s*(on .+ wrote:|from:|sent:|subject:)/i.test(bodyText)) {
            return true;
        }

        if (/\n>\s*\S+/.test(bodyText)) {
            return true;
        }

        if (/\?/.test(bodyText) && /\n/.test(bodyText)) {
            return true;
        }

        return false;
    }

    private async classifyEmailIntent(subject: string, from: string, snippet: string): Promise<string> {
        const schema = z.object({
            intent: z.enum([
                "ROUTINE_INFO",
                "REQUIRES_HUMAN",
                "PROMOTIONAL",
                "INLINE_INVOICE"
            ]),
            reasoning: z.string().describe("Brief reason for classification")
        });

        // Retrieve memory to check if the sender has specific quirks or rules we learned previously
        const memories = await recall(`Communication pattern rules for vendor ${from} subject ${subject}`, { topK: 3, minScore: 0.55 });
        let memoryContext = "";
        if (memories.length > 0) {
            memoryContext = "\n\nPast Vendor Experiences & Rules:\n" + memories.map(m => `- [${m.category}] ${m.content}`).join("\n");
        }

        const prompt = `Classify this incoming email.
From: ${from}
Subject: ${subject}
Snippet: ${snippet}
${memoryContext}

Labels:
ROUTINE_INFO - Standard vendor updates: order confirmations, tracking numbers, invoice deliveries, or PO acknowledgements. Contains NO questions or issues requiring human input.
REQUIRES_HUMAN - The sender is asking a question, reporting a problem (backorder, price change, out of stock), requesting payment/approval, or needs dialogue.
PROMOTIONAL - Marketing, spam, newsletters.
INLINE_INVOICE - The email body contains cost breakdowns, dollar amounts, totals, freight charges, or other invoice-like data but NO PDF is attached. This is a structured cost breakdown (not a casual price mention).

NOTE: If you are even slightly unsure if human attention is needed, choose REQUIRES_HUMAN.`;

        try {
            const res = await unifiedObjectGeneration({
                system: "You are an email triage assistant for a purchasing department. Use maximum caution: if an email might need human attention, flag it as REQUIRES_HUMAN.",
                prompt,
                schema,
                schemaName: "EmailAcknowledgementIntent"
            }) as { intent: string; reasoning: string };

            console.log(`     [LLM] Intent: ${res.intent} | Reason: ${res.reasoning}`);
            return res.intent;
        } catch (err) {
            console.error("     [LLM] Failed classification, defaulting to REQUIRES_HUMAN", err);
            return "REQUIRES_HUMAN";
        }
    }

    private getRandomResponse(): string {
        const index = Math.floor(Math.random() * this.responses.length);
        return this.responses[index];
    }

    private createReplyRaw(to: string, from: string, originalSubject: string, messageId: string, threadId: string, bodyText: string): string {
        // Ensure Subject has Re:
        const subject = originalSubject.toLowerCase().startsWith("re:") ? originalSubject : `Re: ${originalSubject}`;

        const messageParts = [
            `To: ${to}`,
            `From: ${from}`,
            `Subject: ${subject}`,
            `In-Reply-To: ${messageId}`,
            `References: ${messageId}`,
            `MIME-Version: 1.0`,
            `Content-Type: text/plain; charset="UTF-8"`,
            ``,
            bodyText
        ];

        return Buffer.from(messageParts.join('\r\n')).toString("base64url");
    }

    /**
     * Polls the Supabase email queue for unacknowledged emails, determines if they are routine, 
     * and replies/archives them directly in Gmail.
     */
    async processUnreadEmails(maxResults: number = 20) {
        console.log(`🤖 [Acknowledgement-Agent] Checking email queue for routine emails...`);
        try {
            const auth = await getAuthenticatedClient(this.tokenIdentifier);
            const gmail = GmailApi({ version: "v1", auth });
            const supabase = createClient();

            if (!supabase) {
                console.error("❌ [Acknowledgement-Agent] Supabase client unavailable — check env vars.");
                return;
            }

            const profile = await gmail.users.getProfile({ userId: "me" });
            const myEmail = profile.data.emailAddress;

            // Fetch unprocessed rows
            const { data: messages, error } = await supabase
                .from('email_inbox_queue')
                .select('*')
                .eq('processed_by_ack', false)
                .eq('source_inbox', this.tokenIdentifier)
                .limit(maxResults);

            if (error) throw error;

            if (!messages || messages.length === 0) {
                return;
            }

            console.log(`   Found ${messages.length} email(s) in queue to evaluate.`);

            let processedCount = 0;

            for (const m of messages) {
                // Lock row for ACK agent so we don't process it twice if the script restarts mid-loop
                await supabase.from('email_inbox_queue')
                    .update({ processed_by_ack: true })
                    .eq('id', m.id);

                const subject = m.subject || "No Subject";
                const senderEmail = m.from_email || "Unknown Sender";
                const snippet = m.body_snippet || "";
                const bodyText = m.body_text || snippet;
                const rfcMessageId = m.rfc_message_id;
                const threadId = m.thread_id || m.gmail_message_id;
                const gmailMessageId = m.gmail_message_id;
                const hasPdf = m.has_pdf;

                // Guardrail 1: Do not process our own sent emails
                if (senderEmail === myEmail || senderEmail.endsWith("@buildasoil.com")) {
                    console.log(`     -> Skipping internal email (${subject}).`);
                    continue;
                }

                // Guardrail 1b: Do not process system pipeline senders (e.g. Stockie alerts)
                // These emails feed ARIA's internal systems and should never get auto-replies.
                if (this.isSystemSender(senderEmail)) {
                    console.log(`     -> Skipping system sender (${senderEmail}): ${subject}`);
                    continue;
                }

                // Guardrail 1c: Do not process ARIA's own outbound reports
                // (e.g. OOS Report emails sent to ourselves)
                if (this.isSystemSubject(subject)) {
                    console.log(`     -> Skipping system report email: ${subject}`);
                    continue;
                }

                console.log(`   Evaluating: "${subject}" from ${senderEmail}`);

                // Guardrail 2: Classify intent
                let intent = await this.classifyEmailIntent(subject, senderEmail, snippet);
                let humanReviewReason = "llm_requires_human";

                if (intent === "ROUTINE_INFO" && this.looksLikeConversationThread(subject, bodyText)) {
                    console.log(`     -> Upgrading ROUTINE_INFO → REQUIRES_HUMAN (conversation thread detected)`);
                    intent = "REQUIRES_HUMAN";
                    humanReviewReason = "conversation_thread";
                }

                // DECISION(2026-03-13): Post-classification cost-data guard.
                // PO #124462 showed that the LLM classified Ed's cost breakdown
                // ("TOTAL $1140.77 BREAKDOWN...") as ROUTINE_INFO, which triggered an
                // auto-reply instead of routing to InlineInvoiceHandler.
                // If classified as ROUTINE_INFO but the email contains dollar amounts
                // AND invoice-like keywords, upgrade to INLINE_INVOICE.
                if (intent === "ROUTINE_INFO" && !hasPdf) {
                    const checkText = (m.body_text || snippet).toLowerCase();
                    const hasDollarAmount = /\$[\d,]+\.\d{2}/.test(checkText) || /\b\d{2,},?\d*\.\d{2}\b/.test(checkText);
                    const hasInvoiceSignals = /\b(total|breakdown|subtotal|amount\s+due|freight|invoice|plus\b.*\$)/.test(checkText);
                    if (hasDollarAmount && hasInvoiceSignals) {
                        console.log(`     -> Upgrading ROUTINE_INFO → INLINE_INVOICE (cost data detected in body)`);
                        intent = "INLINE_INVOICE";
                    }
                }

                // DECISION(2026-03-23): Vendor-specific intent override.
                // Credit-card-paid vendors (Colorful Packaging, Axiom Print) should
                // NEVER go to Bill.com or the AP Agent. Force INLINE_INVOICE so the
                // InlineInvoiceHandler processes them with vendor-specific logic.
                // This applies regardless of PDF attachment status.
                const creditCardVendorPatterns = [
                    /colorfulpackaging\.com/i,
                    /colorful\s*packaging/i,
                    /axiomprint\.com/i,
                    /axiom\s*print/i,
                    /uline\.com/i,
                    /uline/i,
                ];
                const senderAndBody = senderEmail + ' ' + subject + ' ' + (m.body_text || snippet);
                const isCreditCardVendor = creditCardVendorPatterns.some(p => p.test(senderAndBody));

                if (isCreditCardVendor && intent !== "INLINE_INVOICE") {
                    console.log(`     -> Overriding ${intent} → INLINE_INVOICE (credit-card vendor, never Bill.com)`);
                    intent = "INLINE_INVOICE";
                }

                if (intent === "ROUTINE_INFO") {
                    // It's routine! Let's handle it.
                    const isNoRep = this.isNoReply(senderEmail);
                    let replied = false;
                    if (!isNoRep && rfcMessageId && myEmail) {
                        try {
                            // Send reply
                            const replyBody = this.getRandomResponse();
                            const rawMessage = this.createReplyRaw(senderEmail, myEmail, subject, rfcMessageId, threadId, replyBody);

                            await gmail.users.messages.send({
                                userId: "me",
                                requestBody: {
                                    raw: rawMessage,
                                    threadId: threadId
                                }
                            });
                            console.log(`     ✅ Sent reply: "${replyBody}"`);
                            replied = true;
                            await recordSimpleAutoReply({
                                gmailMessageId,
                                threadId,
                                fromEmail: senderEmail,
                                subject,
                                replyBody,
                            });
                        } catch (replyErr: any) {
                            console.error(`     ❌ Failed to send reply:`, replyErr.message);
                        }
                    } else if (isNoRep) {
                        console.log(`     -> Sender is no-reply, skipping response and leaving visible.`);
                    }

                    try {
                        if (replied) {
                            await this.addMessageLabels(gmail, gmailMessageId, ["Replied"]);
                            console.log(`     🏷️ Added Replied label and kept email visible.`);
                        } else if (hasPdf) {
                            console.log(`     📄 Has PDF — left visible for invoice handling.`);
                        } else {
                            console.log(`     👀 Routine update left visible for review.`);
                        }
                        processedCount++;
                    } catch (modErr: any) {
                        console.error(`     ❌ Failed to modify message labels:`, modErr.message);
                    }
                } else if (intent === "PROMOTIONAL") {
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: gmailMessageId,
                            requestBody: {
                                removeLabelIds: ["INBOX", "UNREAD"]
                            }
                        });
                        console.log(`     🗑️ Promoted/Spam archived.`);
                    } catch (e) { /* ignore */ }
                } else if (intent === "INLINE_INVOICE") {
                    // DECISION(2026-03-25): All paid (credit-card) invoices from the default
                    // inbox are enqueued to nightshift for overnight PO reconciliation.
                    // Previously these went to InlineInvoiceHandler (synchronous, inline).
                    //
                    // Why nightshift?
                    //   - These invoices are already paid — no urgency for immediate processing
                    //   - Extraction requires Haiku (qwen3 unreliable for structured data)
                    //   - The nightshift loop handles dedup, guardrails, Finale updates, and
                    //     morning handoff reporting in one consistent pipeline
                    //   - Guard 1 failures (no PO#) still fire Telegram alerts immediately
                    //     from within the worker, so nothing time-sensitive is lost
                    //
                    // These emails should NEVER go to Bill.com — they are already paid.
                    // Bill.com forwarding is exclusively the AP inbox's job.
                    try {
                        const { enqueueDefaultInboxInvoice } = await import('./nightshift-agent');
                        await enqueueDefaultInboxInvoice(gmailMessageId, senderEmail, subject, bodyText);
                        console.log(`     📥 Paid invoice queued for overnight reconciliation: "${subject}"`);
                        processedCount++;
                    } catch (err: any) {
                        console.error(`     ❌ Failed to enqueue paid invoice:`, err.message);
                    }
                } else {
                    try {
                        await this.addMessageLabels(gmail, gmailMessageId, ["Follow Up"]);
                        console.log(`     🏷️ Added Follow Up label.`);
                        await recordHumanFollowUpRequired({
                            gmailMessageId,
                            threadId,
                            fromEmail: senderEmail,
                            subject,
                            reason: humanReviewReason,
                        });
                    } catch (labelErr: any) {
                        console.error(`     ❌ Failed to add Follow Up label:`, labelErr.message);
                    }
                    console.log(`     ⚠️ Requires human attention. Leaving in inbox.`);
                }
            }

            console.log(`🏁 [Acknowledgement-Agent] Finished. Processed ${processedCount} routine emails.`);

        } catch (err: any) {
            console.error("❌ [Acknowledgement-Agent] Error scanning inbox:", err.message);
        }
    }
}
