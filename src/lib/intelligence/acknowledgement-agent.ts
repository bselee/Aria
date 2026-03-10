import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { unifiedObjectGeneration } from "./llm";
import { createClient } from "../supabase";
import { z } from "zod";
import { recall } from "./memory";

/**
 * @file acknowledgement-agent.ts
 * @purpose Scans inbox for routine informational emails (order confirmations, PO updates, tracking, invoices)
 *          that don't require human action, sends a polite "Thanks!" reply if applicable, and archives them.
 * @author Antigravity
 */
export class AcknowledgementAgent {
    private tokenIdentifier: string;

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

    private isNoReply(from: string): boolean {
        const lowerFrom = from.toLowerCase();
        return lowerFrom.includes("noreply") ||
            lowerFrom.includes("no-reply") ||
            lowerFrom.includes("donotreply") ||
            lowerFrom.includes("postmaster") ||
            lowerFrom.includes("system@");
    }

    private async classifyEmailIntent(subject: string, from: string, snippet: string): Promise<string> {
        const schema = z.object({
            intent: z.enum([
                "ROUTINE_INFO",
                "REQUIRES_HUMAN",
                "PROMOTIONAL"
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
                const rfcMessageId = m.rfc_message_id;
                const threadId = m.thread_id || m.gmail_message_id;
                const gmailMessageId = m.gmail_message_id;
                const hasPdf = m.has_pdf;

                // Guardrail 1: Do not process our own sent emails
                if (senderEmail === myEmail || senderEmail.endsWith("@buildasoil.com")) {
                    console.log(`     -> Skipping internal email (${subject}).`);
                    continue;
                }

                console.log(`   Evaluating: "${subject}" from ${senderEmail}`);

                // Guardrail 2: Classify intent
                const intent = await this.classifyEmailIntent(subject, senderEmail, snippet);

                if (intent === "ROUTINE_INFO") {
                    // It's routine! Let's handle it.
                    const isNoRep = this.isNoReply(senderEmail);
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
                        } catch (replyErr: any) {
                            console.error(`     ❌ Failed to send reply:`, replyErr.message);
                        }
                    } else if (isNoRep) {
                        console.log(`     -> Sender is no-reply, skipping response but will archive.`);
                    }

                    // Archiving logic
                    try {
                        if (hasPdf) {
                            // If has PDF, it might be an invoice for the AP Agent.
                            // Leave it unread in the inbox so AP Identifier can process it.
                            console.log(`     📄 Has PDF — left UNREAD in INBOX for AP-Agent.`);
                        } else {
                            // Normal behavior: archive and mark as read
                            await gmail.users.messages.modify({
                                userId: "me",
                                id: gmailMessageId,
                                requestBody: {
                                    removeLabelIds: ["INBOX", "UNREAD"]
                                }
                            });
                            console.log(`     📦 Archived and marked as read.`);
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
                } else {
                    console.log(`     ⚠️ Requires human attention. Leaving in inbox.`);
                }
            }

            console.log(`🏁 [Acknowledgement-Agent] Finished. Processed ${processedCount} routine emails.`);

        } catch (err: any) {
            console.error("❌ [Acknowledgement-Agent] Error scanning inbox:", err.message);
        }
    }
}
