import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { unifiedObjectGeneration } from "./llm";
import { createClient } from "../db";
import { z } from "zod";
import { recall } from "./memory";
import { applyMessageLabelPolicy } from "./gmail-policy";
import { recordHumanReviewRequired, recordEmailDraftPrepared } from "./email-feedback";
import { summarizeThreadCommunication, ThreadCommunicationSummary } from "./po-correlator";
import { isObviousPromotionalEmail } from "./promotional-email";
import { markEmailQueueOutcome, type EmailQueueStatus } from "./email-queue-status";
import {
    buildReplyDraftRaw,
    composeOpportunityDraft,
    detectVendorOpportunity,
} from "./vendor-opportunity";
import { notifyViaTask } from "./notify-via-task";
import {
    composeHumanEscalationDraftStub,
    isSimpleVendorConfirmation,
    composeRoutineDraftBody,
    resolveEmailResponsePolicy,
} from "./email-response-policy";

/**
 * @file acknowledgement-agent.ts
 * @purpose Triage bill.selee@ inbox from email_inbox_queue. DECISION(2026-08-05):
 *          Never auto-send on reviewable mail — prepare Gmail drafts for Bill to
 *          edit/send. Promos archive. Invoices → nightshift. Opportunities + human
 *          questions escalate via email_needs_response tasks.
 * @author Antigravity
 * @updated 2026-08-05 — draft-only policy; BioChar-class opportunity path
 */
export class AcknowledgementAgent {
    private tokenIdentifier: string;
    private labelCache = new Map<string, string>();

    constructor(tokenIdentifier: string = "default") {
        this.tokenIdentifier = tokenIdentifier;
    }

    // DECISION(2026-03-24→2026-05-28): System sender addresses that ARIA should never auto-reply to.
    // Expanded beyond Stockie — any platform-level sender, notification-only service,
    // or internal tool that should not receive "Thanks!" auto-replies.
    // These catch ~80% of noise before any LLM call.
    private static SYSTEM_SENDERS = [
        'dev@plutonian.io',       // Stockie Low Stock Alert — triggers OOS report pipeline
        '@notifications.google',  // Google Workspace notifications
        '@googlemail.l.google',   // Gmail system messages
        'noreply@google.com',     // Google Cloud, Calendar, etc.
        'no-reply@accounts.google', // Google account notifications
        'stripe.com',             // Stripe payment receipts
        'shopify.com',            // Shopify order confirmations
        'squarespace.com',        // Squarespace notifications
        'paypal.com',             // PayPal receipts
        'quickbooks.com',         // QuickBooks invoices
        'bill.com',               // Bill.com notifications  
        'buildasoilap@bill.com',  // Our own Bill.com AP inbox
        '@send.',                 // Generic ESP pattern
        '@email.',                // Generic ESP pattern
        '@notify.',               // Generic ESP pattern
        '@mail.',                 // Generic ESP pattern (sendgrid, etc.)
        'zendesk.com',            // Zendesk ticket notifications
        'freshdesk.com',          // Freshdesk notifications
        'intercom.io',            // Intercom notifications
        'docusign.com',           // DocuSign signature requests
        'hellosign.com',          // HelloSign
        'calendly.com',           // Calendly booking confirmations
        'hubspot.com',            // HubSpot notifications
        'jotform.com',            // JotForm submissions
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

    /**
     * Fast-path promotional/newsletter detection by subject line + sender.
     * Catches ~60% of incoming emails before the LLM call — saves tokens on obvious ads.
     * Returns true if the email is clearly promotional and can be archived without processing.
     */
    private isPromotionalFastPath(from: string, subject: string): boolean {
        const lowerSubject = subject.toLowerCase();
        const lowerFrom = from.toLowerCase();

        // Promotional subject patterns — high-confidence marketing signals
        const PROMO_SUBJECT_PATTERNS: RegExp[] = [
            /\b(?:sale|clearance|blowout|flash\s*sale|weekend\s*sale|end.of.season)\b/i,
            /\b(?:\d+%\s*off|save\s+\$?\d+|up\s+to\s+\d+%|take\s+\d+%)\b/i,
            /\b(?:coupon|promo\s*code|discount\s*code|offer\s*code|voucher)\b/i,
            /\b(?:limited\s*time|act\s*now|hurry|last\s*chance|don'?t\s*miss|exclusive\s*offer)\b/i,
            /\b(?:free\s*shipping|free\s*delivery|ships?\s*free|gratis)\b/i,
            /\b(?:new\s*arrival|just\s*in|now\s*available|pre.?order\s*now)\b/i,
            /\b(?:unsubscribe|opt.out|manage\s*preferences|email\s*preferences)\b/i,
            /\b(?:weekly\s*digest|newsletter|this\s*week'?s?\s*(deals|picks|highlights))\b/i,
            /\b(?:black\s*friday|cyber\s*monday|holiday\s*savings|seasonal\s*deals?)\b/i,
            /\b(?:buy\s+\d+\s*get|bundle\s*deal|special\s*pricing|member.?only)\b/i,
            /\b(?:you'?re\s*invited|join\s*us|webinar|event\s*registration)\b/i,
            /\b(?:refer\s*a\s*friend|earn\s*\$|rewards?\s*points?|loyalty\s*bonus)\b/i,
        ];

        if (PROMO_SUBJECT_PATTERNS.some(p => p.test(lowerSubject))) {
            return true;
        }

        // ESP/newsletter sender domains — almost always promotional
        const ESP_DOMAIN_PATTERNS: RegExp[] = [
            /mailchimp/i, /sendgrid/i, /constantcontact/i,
            /campaign-archive/i, /list-manage/i, /sendinblue/i,
            /brevo/i, /klaviyo/i, /iterable/i, /customer\.io/i,
            /em\.spotify/i, /e\.reddit/i, /email\.[a-z]+\.com/i,
            /news\.[a-z]+\.com/i, /newsletter\.[a-z]+\.com/i,
        ];

        if (ESP_DOMAIN_PATTERNS.some(p => p.test(lowerFrom))) {
            return true;
        }

        // Newsletter sender address patterns
        if (/^-?(newsletter|marketing|deals|promotions|offers|updates)\@/i.test(lowerFrom)) {
            return true;
        }

        // Subject starts with emoji + ALL CAPS (common promo pattern)
        if (/^[\uD83C-\uDBFF\uDC00-\uDFFF\u2600-\u27BF]\s*[A-Z\s\W]{15,}$/.test(subject)) {
            return true;
        }

        return false;
    }

    private isMarketplaceOrStatusSender(from: string, subject: string): boolean {
        const haystack = `${from} ${subject}`.toLowerCase();
        return [
            "amazon.com",
            "order-update@amazon.com",
            "alibaba.com",
            "notice.alibaba.com",
            "track package",
            "your order is on its way",
            "delivered:",
            "shipped",
            "delivery update",
            "view order",
        ].some(pattern => haystack.includes(pattern));
    }

    private looksLikePurchaseThread(subject: string, bodyText: string): boolean {
        const text = `${subject}\n${bodyText}`.toLowerCase();
        return /buildasoil\s+po\s*#?\s*\d+/.test(text)
            || /purchase\s+order/.test(text)
            || /\bpo\s*#?\s*\d{4,}\b/.test(text)
            || /\beta\b/.test(text)
            || /\btracking\b/.test(text);
    }

    private async getThreadCommunicationSummary(gmail: any, threadId: string) {
        try {
            const threadRes = await gmail.users.threads.get({
                userId: "me",
                id: threadId,
                format: "metadata",
                metadataHeaders: ["From"],
            });
            return summarizeThreadCommunication(threadRes.data.messages || []);
        } catch {
            return null;
        }
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
                "INLINE_INVOICE",
                "VENDOR_OPPORTUNITY",
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
ROUTINE_INFO - Standard vendor updates: order confirmations, tracking numbers, invoice deliveries, or PO acknowledgements. Contains NO questions, NO pricing proposals, NO call offers.
REQUIRES_HUMAN - The sender is asking a question, reporting a problem (backorder, price change, out of stock), requesting payment/approval, or needs dialogue.
VENDOR_OPPORTUNITY - Sales/sourcing reply: distributor pricing, quotes, tech sheets, product introductions, partnership pitches, or "schedule a call" after an inquiry. NEVER treat these as ROUTINE_INFO. Bare auto-thanks is wrong.
PROMOTIONAL - Marketing, spam, newsletters, % off blasts.
INLINE_INVOICE - The email body contains cost breakdowns, dollar amounts, totals, freight charges, or other invoice-like data but NO PDF is attached. This is a structured cost breakdown (not a casual price mention).

NOTE: If you are even slightly unsure if human attention is needed, choose REQUIRES_HUMAN.
NOTE: Inquiry responses with pricing docs or call offers = VENDOR_OPPORTUNITY.`;

        try {
            const res = await unifiedObjectGeneration({
                system: "You are an email triage assistant for a purchasing department. Use maximum caution: if an email might need human attention or is a vendor sales opportunity, do NOT choose ROUTINE_INFO.",
                prompt,
                schema,
                schemaName: "EmailAcknowledgementIntent",
                tier: "free",
                maxTokens: 150,
            }) as { intent: string; reasoning: string };

            console.log(`     [LLM] Intent: ${res.intent} | Reason: ${res.reasoning}`);
            return res.intent;
        } catch (err) {
            console.error("     [LLM] Failed classification, defaulting to REQUIRES_HUMAN", err);
            return "REQUIRES_HUMAN";
        }
    }

    /**
     * Stamp queue status for triage / retention. processed_by_ack is set early
     * as a lock; this finalizes the human-readable lifecycle status.
     */
    private async finalizeQueueStatus(
        rowId: string,
        status: EmailQueueStatus,
        errorMessage?: string | null,
    ): Promise<void> {
        await markEmailQueueOutcome({
            id: rowId,
            status,
            processedByAck: true,
            processedBy: "acknowledgement-agent",
            errorMessage,
        });
    }

    /**
     * Vendor opportunity path: NEVER auto-send "Thanks!".
     * Create a Gmail draft with business acumen + response-monitor task.
     */
    private async handleVendorOpportunity(args: {
        gmail: any;
        rowId: string;
        gmailMessageId: string;
        threadId: string;
        rfcMessageId: string | null;
        myEmail: string | null | undefined;
        senderEmail: string;
        subject: string;
        snippet: string;
        bodyText: string;
        hasPdf: boolean;
        pdfFilenames: string[] | null;
    }): Promise<void> {
        const {
            gmail, rowId, gmailMessageId, threadId, rfcMessageId, myEmail,
            senderEmail, subject, snippet, bodyText, hasPdf, pdfFilenames,
        } = args;

        const draft = await composeOpportunityDraft({
            from: senderEmail,
            subject,
            snippet,
            bodyText,
            hasPdf,
            pdfFilenames,
            gmailMessageId,
        });

        let draftId: string | null = null;
        if (myEmail) {
            try {
                const raw = buildReplyDraftRaw({
                    to: senderEmail,
                    from: myEmail,
                    subject,
                    inReplyTo: rfcMessageId,
                    bodyText: draft.draftBody,
                });
                const created = await gmail.users.drafts.create({
                    userId: "me",
                    requestBody: {
                        message: {
                            raw,
                            threadId,
                        },
                    },
                });
                draftId = created.data?.id ?? null;
                console.log(`     📝 Opportunity draft created${draftId ? ` (${draftId})` : ""}`);
            } catch (err: any) {
                console.error(`     ❌ Failed to create opportunity draft:`, err.message);
            }
        }

        try {
            await this.addMessageLabels(gmail, gmailMessageId, ["Needs Response", "Draft Ready"]);
        } catch { /* best effort */ }

        try {
            await recordHumanReviewRequired({
                gmailMessageId,
                threadId,
                fromEmail: senderEmail,
                subject,
                reason: "vendor_opportunity",
            });
        } catch { /* non-fatal */ }

        try {
            await recordEmailDraftPrepared({
                gmailMessageId,
                threadId,
                fromEmail: senderEmail,
                subject,
                replyBody: draft.draftBody,
                kind: "vendor_opportunity",
                draftId,
            });
        } catch { /* non-fatal */ }

        try {
            await notifyViaTask({
                sourceId: `email-opp:${gmailMessageId}`,
                type: "email_needs_response",
                goal: draft.summaryForBill,
                owner: "will",
                priority: 1,
                summaryLabel: "Email needs real response",
                inputs: {
                    from: senderEmail,
                    subject,
                    nextAction: draft.nextAction,
                    draftId,
                    gmailMessageId,
                    threadId,
                    kind: "vendor_opportunity",
                },
            });
        } catch (err: any) {
            console.warn(`     ⚠️ notifyViaTask failed: ${err.message}`);
        }

        await this.finalizeQueueStatus(rowId, "needs_response", draft.nextAction);
        console.log(`     🎯 VENDOR_OPPORTUNITY — draft ready, no auto-thanks. Next: ${draft.nextAction}`);
    }

    /**
     * Create an in-thread Gmail draft. Never sends.
     */
    private async createReplyDraft(args: {
        gmail: any;
        to: string;
        from: string;
        subject: string;
        inReplyTo?: string | null;
        threadId: string;
        bodyText: string;
    }): Promise<string | null> {
        try {
            const raw = buildReplyDraftRaw({
                to: args.to,
                from: args.from,
                subject: args.subject,
                inReplyTo: args.inReplyTo,
                bodyText: args.bodyText,
            });
            const created = await args.gmail.users.drafts.create({
                userId: "me",
                requestBody: {
                    message: {
                        raw,
                        threadId: args.threadId,
                    },
                },
            });
            return created.data?.id ?? null;
        } catch (err: any) {
            console.error(`     ❌ Draft create failed:`, err.message);
            return null;
        }
    }

    /**
     * Polls the Supabase email queue for unacknowledged emails and applies
     * the draft-only response policy (never auto-sends reviewable mail).
     */
    async processUnreadEmails(maxResults: number = 20) {
        console.log(`🤖 [Acknowledgement-Agent] Checking email queue for routine emails...`);
        try {
            const auth = await getAuthenticatedClient(this.tokenIdentifier);
            const gmail = GmailApi({ version: "v1", auth });
            const db = createClient();

            if (!db) {
                console.error("❌ [Acknowledgement-Agent] Supabase client unavailable — check env vars.");
                return;
            }

            const profile = await gmail.users.getProfile({ userId: "me" });
            const myEmail = profile.data.emailAddress;

            // DECISION(2026-06-10): Per-batch thread dedup guard.
            // When a vendor sends two emails in the same thread close together,
            // both land in the queue. After replying to the first, the Gmail API
            // hasn't indexed our sent message yet, so getThreadCommunicationSummary()
            // still shows buildasoilRepliedAfterVendor=false for the second row.
            // Fix: track threadIds we've already auto-replied to in THIS batch and
            // suppress any further replies for the same thread.
            const repliedThreadIds = new Set<string>();

            // Fetch unprocessed rows
            const { data: messages, error } = await db
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

            // Batch collector for REQUIRES_HUMAN notifications
            // Collect during processing, send ONE digest at the end to avoid spam
            const requiresHumanBatch: Array<{ from: string; subject: string; snippet: string }> = [];

            let processedCount = 0;

            for (const m of messages) {
                            // Lock row for ACK agent so we don't process it twice if the script restarts mid-loop
                            await db.from('email_inbox_queue')
                                .update({ processed_by_ack: true, status: 'processing', updated_at: new Date().toISOString() })
                                .eq('id', m.id);

                            const subject = m.subject || "No Subject";
                            const senderEmail = m.from_email || "Unknown Sender";
                            const snippet = m.body_snippet || "";
                            const bodyText = m.body_text || snippet;
                            const rfcMessageId = m.rfc_message_id;
                            const threadId = m.thread_id || m.gmail_message_id;
                            const gmailMessageId = m.gmail_message_id;
                            const hasPdf = m.has_pdf;
                            const pdfFilenames: string[] | null = Array.isArray(m.pdf_filenames)
                                ? m.pdf_filenames
                                : null;

                            // Guardrail 1: Do not process our own sent emails
                            if (senderEmail === myEmail || senderEmail.endsWith("@buildasoil.com")) {
                                console.log(`     -> Skipping internal email (${subject}).`);
                                await this.finalizeQueueStatus(m.id, "skipped");
                                continue;
                            }

                            // Guardrail 1b: Do not process system pipeline senders (e.g. Stockie alerts)
                            // These emails feed ARIA's internal systems and should never get auto-replies.
                            if (this.isSystemSender(senderEmail)) {
                                console.log(`     -> Skipping system sender (${senderEmail}): ${subject}`);
                                await this.finalizeQueueStatus(m.id, "system_noise");
                                continue;
                            }

                            // Guardrail 1c: Do not process ARIA's own outbound reports
                            // (e.g. OOS Report emails sent to ourselves)
                            if (this.isSystemSubject(subject)) {
                                console.log(`     -> Skipping system report email: ${subject}`);
                                await this.finalizeQueueStatus(m.id, "system_noise");
                                continue;
                            }

                            console.log(`   Evaluating: "${subject}" from ${senderEmail}`);

                            // Guardrail 2: REGEX FAST-PATH — skip LLM entirely for noreply/marketplace senders
                            // These are always PROMOTIONAL or routine status updates. No human action needed.
                            if (this.isNoReply(senderEmail)) {
                                console.log(`     -> Fast-path PROMOTIONAL (noreply sender: ${senderEmail})`);
                                try {
                                    await gmail.users.messages.modify({
                                        userId: "me", id: m.gmail_message_id,
                                        requestBody: { removeLabelIds: ["UNREAD"] }
                                    });
                                } catch { /* best effort */ }
                                await this.finalizeQueueStatus(m.id, "system_noise");
                                continue;
                            }

                            if (this.isMarketplaceOrStatusSender(senderEmail, subject)) {
                                console.log(`     -> Fast-path PROMOTIONAL (marketplace/status: ${senderEmail})`);
                                try {
                                    await gmail.users.messages.modify({
                                        userId: "me", id: m.gmail_message_id,
                                        requestBody: { removeLabelIds: ["UNREAD"] }
                                    });
                                } catch { /* best effort */ }
                                await this.finalizeQueueStatus(m.id, "system_noise");
                                continue;
                            }

                            // Guardrail 2c: Promotional subject fast-path — catches newsletters, ads, ESP blasts
                            // before the expensive LLM call. ~60% of incoming emails are clearly promotional.
                            // Also uses shared isObviousPromotionalEmail (Uline specials, Zoro, AeroPress, etc.).
                            if (
                                this.isPromotionalFastPath(senderEmail, subject)
                                || isObviousPromotionalEmail({ from: senderEmail, subject, snippet })
                            ) {
                                console.log(`     -> Fast-path PROMOTIONAL (subject/sender match: ${subject.slice(0, 60)})`);
                                try {
                                    await gmail.users.messages.modify({
                                        userId: "me", id: m.gmail_message_id,
                                        requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                                    });
                                } catch { /* best effort */ }
                                await this.finalizeQueueStatus(m.id, "promotional");
                                continue;
                            }

                            // DECISION(2026-08-05): Vendor opportunity pre-check BEFORE LLM.
                            // BioChar miss: Jessica sent tier-2 pricing + TDS + call offer; LLM/path
                            // treated it as ROUTINE_INFO and auto-sent "Received, thank you!".
                            // High-confidence commercial signals → draft + needs_response, never bare thanks.
                            const opportunity = detectVendorOpportunity({
                                from: senderEmail,
                                subject,
                                snippet,
                                bodyText,
                                hasPdf: !!hasPdf,
                                pdfFilenames,
                            });
                            if (opportunity.isOpportunity && opportunity.highConfidence) {
                                console.log(`     -> Fast-path VENDOR_OPPORTUNITY (${opportunity.reasons.slice(0, 4).join(", ")})`);
                                await this.handleVendorOpportunity({
                                    gmail,
                                    rowId: m.id,
                                    gmailMessageId,
                                    threadId,
                                    rfcMessageId,
                                    myEmail,
                                    senderEmail,
                                    subject,
                                    snippet,
                                    bodyText,
                                    hasPdf: !!hasPdf,
                                    pdfFilenames,
                                });
                                processedCount++;
                                continue;
                            }

                            // Guardrail 3: Classify intent (LLM call — expensive, only reached for real vendor emails)
                            let intent = await this.classifyEmailIntent(subject, senderEmail, snippet);
                            let humanReviewReason = "llm_requires_human";
                            let activeThreadSummary: ThreadCommunicationSummary | null = null;

                            // Soft opportunity signal can still upgrade LLM ROUTINE_INFO / PROMOTIONAL mistakes
                            if (opportunity.isOpportunity && (intent === "ROUTINE_INFO" || intent === "PROMOTIONAL")) {
                                console.log(`     -> Upgrading ${intent} → VENDOR_OPPORTUNITY (detector reasons: ${opportunity.reasons.slice(0, 3).join(", ")})`);
                                intent = "VENDOR_OPPORTUNITY";
                            }

                            if (intent === "ROUTINE_INFO" && this.looksLikeConversationThread(subject, bodyText)) {
                                // DECISION(2026-06-03): Ping-pong fix for active vendor confirmation threads.
                                // Symptom: Bill received repeated "1 email needs response" pings about the
                                // same vendor thread (e.g. "Re: Invico Worldwide PO 124392" from jade@invicoworldwide.com)
                                // every 15 min. Root cause: Gmail hands out a fresh `gmail_message_id` for
                                // every vendor reply, so the dedup-on-message_id never matches. Each new
                                // vendor "Re:" was re-escalated from ROUTINE_INFO → REQUIRES_HUMAN here.
                                //
                                // Fix: peek at the thread. If BuildASoil has already replied at least once
                                // in this thread, the conversation is active and Bill is aware — keep it
                                // as ROUTINE_INFO so the auto-reply branch archives it normally (and the
                                // extended `suppressAutoReply` below prevents sending a duplicate "Thanks!"
                                // on top of our own existing reply).
                                activeThreadSummary = await this.getThreadCommunicationSummary(gmail, threadId);
                                if (activeThreadSummary?.buildasoilRepliedAfterVendor) {
                                    console.log(`     -> Suppressing REQUIRES_HUMAN upgrade (active thread — ${activeThreadSummary.buildasoilReplyCount} BuildASoil reply, last actor: ${activeThreadSummary.lastActor})`);
                                    // Keep intent as ROUTINE_INFO. Auto-reply will be suppressed below.
                                } else {
                                    console.log(`     -> Upgrading ROUTINE_INFO → REQUIRES_HUMAN (conversation thread detected)`);
                                    intent = "REQUIRES_HUMAN";
                                    humanReviewReason = "conversation_thread";
                                }
                            }

                            // DECISION(2026-03-13): Post-classification cost-data guard.
                                                            // PO #124462 showed that the LLM classified Ed's cost breakdown
                                                            // ("TOTAL $1140.77 BREAKDOWN...") as ROUTINE_INFO, which triggered an
                                                            // auto-reply instead of routing to InlineInvoiceHandler.
                                                            // If classified as ROUTINE_INFO but the email contains dollar amounts
                                                            // AND invoice-like keywords, upgrade to INLINE_INVOICE.
                                                            if (intent === "ROUTINE_INFO" && !hasPdf) {
                                                                const checkText = (m.body_text || snippet).toLowerCase();
                                                                const hasDollarAmount = /\$[\d,]+\.\d{2}/.test(checkText) || /\b\d{2,}?,?\d*\.\d{2}\b/.test(checkText);
                                                                const hasInvoiceSignals = /\b(total|breakdown|subtotal|amount\s+due|freight|invoice|plus\b.*\$)/.test(checkText);
                                                                if (hasDollarAmount && hasInvoiceSignals) {
                                                                    console.log(`     -> Upgrading ROUTINE_INFO → INLINE_INVOICE (cost data detected in body)`);
                                                                    intent = "INLINE_INVOICE";
                                                                }
                                                            }

                                                            // DECISION(2026-08-05): Default-inbox PDF invoices are ALREADY PAID (CC).
                                                            // Draft-only policy must never swallow them — force nightshift reconciliation
                                                            // so invoices hit vendor_invoices / Finale price updates and don't get
                                                            // filed as a polite draft while money data is ignored.
                                                            // AP inbox (Bill.com / unpaid) is handled separately by AP Identifier.
                                                            if (
                                                                this.tokenIdentifier === "default"
                                                                && intent !== "INLINE_INVOICE"
                                                                && intent !== "VENDOR_OPPORTUNITY"
                                                                && intent !== "PROMOTIONAL"
                                                                && !!hasPdf
                                                            ) {
                                                                const invHay = `${subject}\n${bodyText}\n${(pdfFilenames || []).join(" ")}`.toLowerCase();
                                                                const looksInvoicePdf =
                                                                    /\binvoice\b/.test(invHay)
                                                                    || /\binv[#\s-]?\d/.test(invHay)
                                                                    || (pdfFilenames || []).some((f) => /inv|invoice|receipt|bill/i.test(f));
                                                                if (looksInvoicePdf) {
                                                                    console.log(`     -> Upgrading ${intent} → INLINE_INVOICE (default-inbox paid PDF invoice)`);
                                                                    intent = "INLINE_INVOICE";
                                                                }
                                                            }

                                                            // DECISION(2026-03-23): Vendor-specific intent override.
                                                            // Credit-card-paid vendors (Colorful Packaging, Axiom Print) should
                                                            // NEVER go to Bill.com or the AP Agent. Force INLINE_INVOICE so the
                                                            // InlineInvoiceHandler processes them with vendor-specific logic.
                                                            // This applies regardless of PDF attachment status.
                                                            // Exception: pure marketing from those domains stays promotional (already filtered).
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
                                                            const looksLikePaidInvoice =
                                                                hasPdf
                                                                || /\binvoice\b/i.test(subject + " " + bodyText)
                                                                || /\$[\d,]+\.\d{2}/.test(bodyText);

                                                            if (
                                                                isCreditCardVendor
                                                                && looksLikePaidInvoice
                                                                && intent !== "INLINE_INVOICE"
                                                                && intent !== "VENDOR_OPPORTUNITY"
                                                            ) {
                                                                console.log(`     -> Overriding ${intent} → INLINE_INVOICE (credit-card vendor, never Bill.com)`);
                                                                intent = "INLINE_INVOICE";
                                                            }

                            // Simple vendor confirms ("Sounds good — invoice when restocked") must never
                            // become the human-escalation stub ("looking into this" / Hi cs,).
                            if (
                                intent !== "PROMOTIONAL"
                                && intent !== "INLINE_INVOICE"
                                && intent !== "VENDOR_OPPORTUNITY"
                                && isSimpleVendorConfirmation({ subject, bodyText })
                            ) {
                                console.log(`     -> Simple vendor confirmation — Thanks! draft only`);
                                intent = "ROUTINE_INFO";
                            }

                            if (intent === "VENDOR_OPPORTUNITY") {
                                await this.handleVendorOpportunity({
                                    gmail,
                                    rowId: m.id,
                                    gmailMessageId,
                                    threadId,
                                    rfcMessageId,
                                    myEmail,
                                    senderEmail,
                                    subject,
                                    snippet,
                                    bodyText,
                                    hasPdf: !!hasPdf,
                                    pdfFilenames,
                                });
                                processedCount++;
                            } else if (intent === "ROUTINE_INFO") {
                                // DECISION(2026-08-05): Draft-only for PO/tracking/routine.
                                // Never auto-send — Bill reviews drafts before anything goes out.
                                const isNoRep = this.isNoReply(senderEmail);
                                const isMarketplaceStatus = this.isMarketplaceOrStatusSender(senderEmail, subject);
                                const isPurchaseThread = this.looksLikePurchaseThread(subject, bodyText);
                                const threadSummary = activeThreadSummary
                                    ?? (isPurchaseThread
                                        ? await this.getThreadCommunicationSummary(gmail, threadId)
                                        : null);
                                const isActiveConversationThread = activeThreadSummary?.buildasoilRepliedAfterVendor === true;
                                const alreadyRepliedThisBatch = repliedThreadIds.has(threadId);

                                const policy = resolveEmailResponsePolicy({
                                    intent: "ROUTINE_INFO",
                                    isNoReply: isNoRep,
                                    isMarketplace: isMarketplaceStatus,
                                    isPurchaseThread,
                                    alreadyRepliedThisBatch,
                                    buildasoilAlreadyRepliedInThread: !!threadSummary?.buildasoilRepliedAfterVendor,
                                    isActiveConversation: isActiveConversationThread,
                                });

                                // Hard guard — policy must never allow auto-send on routine mail
                                if (policy.allowAutoSend) {
                                    console.error("     ❌ Policy violation: allowAutoSend on ROUTINE_INFO blocked");
                                }

                                if (policy.createDraft && myEmail && rfcMessageId) {
                                    const draftBody = composeRoutineDraftBody({
                                        from: senderEmail,
                                        subject,
                                        bodyText,
                                    });
                                    const draftId = await this.createReplyDraft({
                                        gmail,
                                        to: senderEmail,
                                        from: myEmail,
                                        subject,
                                        inReplyTo: rfcMessageId,
                                        threadId,
                                        bodyText: draftBody,
                                    });
                                    if (draftId) {
                                        repliedThreadIds.add(threadId);
                                        console.log(`     📝 Routine draft ready (${draftId}) — not sent`);
                                        try {
                                            await recordEmailDraftPrepared({
                                                gmailMessageId,
                                                threadId,
                                                fromEmail: senderEmail,
                                                subject,
                                                replyBody: draftBody,
                                                kind: "routine",
                                                draftId,
                                            });
                                        } catch { /* non-fatal */ }
                                    }
                                } else if (policy.action === "SILENT") {
                                    console.log(`     -> Silent (${policy.reason}) — no draft/send.`);
                                }

                                try {
                                    if (policy.labels.length > 0) {
                                        await this.addMessageLabels(gmail, gmailMessageId, policy.labels);
                                        console.log(`     🏷️ Labels: ${policy.labels.join(", ")}`);
                                    } else if (hasPdf) {
                                        console.log(`     📄 Has PDF — left visible.`);
                                    } else {
                                        console.log(`     👀 Routine left visible for review.`);
                                    }
                                    processedCount++;
                                } catch (modErr: any) {
                                    console.error(`     ❌ Failed to modify message labels:`, modErr.message);
                                }
                                await this.finalizeQueueStatus(m.id, "completed", policy.reason);
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
                                await this.finalizeQueueStatus(m.id, "promotional");
                            } else if (intent === "INLINE_INVOICE") {
                                // DECISION(2026-03-25): All paid (credit-card) invoices from the default
                                // inbox are enqueued to nightshift for overnight PO reconciliation.
                                try {
                                    const { enqueueDefaultInboxInvoice } = await import('./nightshift-agent');
                                    await enqueueDefaultInboxInvoice(gmailMessageId, senderEmail, subject, bodyText);
                                    console.log(`     📥 Paid invoice queued for overnight reconciliation: "${subject}"`);
                                    processedCount++;
                                    await this.finalizeQueueStatus(m.id, "invoice_queued");
                                } catch (err: any) {
                                    console.error(`     ❌ Failed to enqueue paid invoice:`, err.message);
                                    await this.finalizeQueueStatus(m.id, "failed", err.message);
                                }
                            } else {
                                // REQUIRES_HUMAN — draft stub + escalate. Never auto-send.
                                const policy = resolveEmailResponsePolicy({ intent: "REQUIRES_HUMAN" });

                                if (policy.createDraft && myEmail && rfcMessageId) {
                                    const stub = composeHumanEscalationDraftStub({
                                        from: senderEmail,
                                        subject,
                                        bodyText,
                                    });
                                    const draftId = await this.createReplyDraft({
                                        gmail,
                                        to: senderEmail,
                                        from: myEmail,
                                        subject,
                                        inReplyTo: rfcMessageId,
                                        threadId,
                                        bodyText: stub,
                                    });
                                    if (draftId) {
                                        console.log(`     📝 Human-escalation draft stub (${draftId}) — not sent`);
                                        try {
                                            await recordEmailDraftPrepared({
                                                gmailMessageId,
                                                threadId,
                                                fromEmail: senderEmail,
                                                subject,
                                                replyBody: stub,
                                                kind: "human_escalation",
                                                draftId,
                                            });
                                        } catch { /* non-fatal */ }
                                    }
                                }

                                try {
                                    await recordHumanReviewRequired({
                                        gmailMessageId,
                                        threadId,
                                        fromEmail: senderEmail,
                                        subject,
                                        reason: humanReviewReason,
                                    });
                                } catch (humanReviewErr: any) {
                                    console.error(`     ❌ Failed to record human review signal:`, humanReviewErr.message);
                                }

                                try {
                                    await this.addMessageLabels(gmail, gmailMessageId, policy.labels.length ? policy.labels : ["Needs Response", "Draft Ready"]);
                                } catch { /* best effort */ }

                                try {
                                    await notifyViaTask({
                                        sourceId: `email-human:${gmailMessageId}`,
                                        type: "email_needs_response",
                                        goal: `${senderEmail}: ${subject.slice(0, 80)}`,
                                        owner: "will",
                                        priority: 1,
                                        summaryLabel: "Email needs real response",
                                        inputs: {
                                            from: senderEmail,
                                            subject,
                                            reason: humanReviewReason,
                                            gmailMessageId,
                                            threadId,
                                            kind: "requires_human",
                                            snippet: (snippet || "").slice(0, 120),
                                        },
                                    });
                                } catch { /* non-fatal */ }

                                requiresHumanBatch.push({
                                    from: senderEmail,
                                    subject,
                                    snippet: (snippet || "").slice(0, 120),
                                });
                                console.log(`     ⚠️ Requires human attention — draft stub + task. Leaving in inbox.`);
                                await this.finalizeQueueStatus(m.id, "needs_response", humanReviewReason);
                            }
                        }

            // ── Batch REQUIRES_HUMAN notification ──────────────────────────
            // Single digest message to Bill rather than spamming per-email.
            // Only fires during business hours to avoid 3am pings.
            if (requiresHumanBatch.length > 0) {
                const hour = new Date().getHours();
                const isBusinessHours = hour >= 6 && hour <= 22; // 6am - 10pm MT

                try {
                    const { sendTelegramNotify } = await import('./telegram-notify');
                    const lines: string[] = [];

                    if (requiresHumanBatch.length === 1) {
                        const e = requiresHumanBatch[0];
                        lines.push(`✉️ *Email needs your response*`);
                        lines.push(`━━━━━━━━━━━━━━━━━━━━`);
                        lines.push(`📩 *From:* ${e.from}`);
                        lines.push(`📋 *Re:* ${e.subject}`);
                        if (e.snippet) lines.push(`   _${e.snippet}_`);
                    } else {
                        lines.push(`✉️ *${requiresHumanBatch.length} emails need your response*`);
                        lines.push(`━━━━━━━━━━━━━━━━━━━━`);

                        for (const e of requiresHumanBatch.slice(0, 5)) {
                            lines.push(`📩 *${e.from}*`);
                            lines.push(`   ${e.subject}`);
                        }

                        if (requiresHumanBatch.length > 5) {
                            lines.push(`   _...and ${requiresHumanBatch.length - 5} more_`);
                        }
                    }

                    if (!isBusinessHours) {
                        lines.push(`\n🌙 _Off-hours: holding notification for morning digest._`);
                        // Queue for morning digest instead of sending now
                        try {
                            const { sendTelegramNotify: sendNow } = await import("@/lib/intelligence/telegram-notify");
                            if (db) {
                                // Write to agent_task for morning pickup
                                const { upsertTask } = await import("@/lib/command-board/task-actions");
                                await upsertTask({
                                    source: "ack-agent",
                                    source_id: `requires-human-${Date.now()}`,
                                    kind: "email_needs_response",
                                    title: `${requiresHumanBatch.length} email(s) need response`,
                                    details: requiresHumanBatch.map(e => `${e.from}: ${e.subject}`).join("\n"),
                                    priority: "medium",
                                });
                                console.log(`🌙 [Acknowledgement-Agent] Queued ${requiresHumanBatch.length} REQUIRES_HUMAN emails for morning digest.`);
                                return; // Skip immediate send
                            }
                        } catch { /* fall through to immediate notify */ }
                    }

                    await sendTelegramNotify(lines.join("\n"));
                    console.log(`📨 [Acknowledgement-Agent] Notified Bill: ${requiresHumanBatch.length} email(s) need response.`);
                } catch (notifyErr: any) {
                    console.warn(`⚠️ [Acknowledgement-Agent] Failed to send REQUIRES_HUMAN batch notification: ${notifyErr.message}`);
                }
            }

            console.log(`🏁 [Acknowledgement-Agent] Finished. Processed ${processedCount} routine emails.`);

        } catch (err: any) {
            console.error("❌ [Acknowledgement-Agent] Error scanning inbox:", err.message);
        }
    }
}
