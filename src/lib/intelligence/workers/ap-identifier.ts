/**
 * @file   ap-identifier.ts
 * @purpose Agent 1 of the decoupled AP pipeline (The "Eyes").
 *          Scans the AP inbox for unread PDFs, classifies their intent,
 *          uploads them to Supabase Storage, and queues them for Bill.com forwarding.
 *          Also handles PAID_INVOICE detection — extracts vendor/invoice/amount,
 *          cross-references with Finale POs, and creates draft POs when unmatched.
 *
 *          Pipeline flow:
 *            email_inbox_queue → AP Identifier → ap_inbox_queue (PENDING_FORWARD)
 *                                                → AP Forwarder → Bill.com
 *
 * @author  Antigravity / Aria
 * @updated 2026-03-20 — Added 3-layer safety net: sender blocklist, subject
 *          skip patterns, and PDF content scanning ("Do Not Pay", $0.00 balance,
 *          proforma, etc.) to prevent bad forwards to Bill.com.
 *          Previous: Fixed pipeline gap (PENDING_FORWARD vs PENDING_EXTRACTION),
 *          added cross-inbox dedup, tightened classification heuristics.
 */

import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../../gmail/auth";
import { createClient } from "../../supabase";
import { z } from "zod";
import { unifiedObjectGeneration, unifiedTextGeneration } from "../llm";
import { recall } from "../memory";
import { detectPaidInvoice, parsePaidInvoice } from "../inline-invoice-parser";
import { getPreClassification } from "../nightshift-agent";
import { FinaleClient } from "../../finale/client";
import { Telegraf } from "telegraf";
import { applyMessageLabelPolicy } from "../gmail-policy";
import { getInvoiceInboxPolicy } from "./ap-identifier-policy";
import { filterStatementInvoicePages } from "./ap-identifier-statement-filter";

// ── SENDER BLOCKLIST ──────────────────────────────────────────────
// DECISION(2026-03-20): Emails from these senders/domains must NEVER
// be forwarded to Bill.com. They are either internal, autopay leases,
// or system-generated bounces. Marked read + archived silently.
const SENDER_BLOCKLIST: Array<{ type: 'domain' | 'contains' | 'exact'; value: string; label: string }> = [
    // Internal — our own outbound emails should never be treated as invoices
    { type: 'exact', value: 'bill.selee@buildasoil.com', label: 'Internal (bill.selee)' },
    { type: 'exact', value: 'ap@buildasoil.com', label: 'Internal (ap)' },

    // Toyota Commercial Finance — lease autopay, PDF says "Do Not Pay"
    { type: 'contains', value: 'billtrust.com', label: 'Toyota/TICF (Autopay Lease)' },
    { type: 'contains', value: 'toyota', label: 'Toyota (Autopay Lease)' },

    // Bounce / NDR addresses — never invoices
    { type: 'contains', value: 'postmaster@', label: 'Postmaster (Bounce)' },
    { type: 'contains', value: 'mailer-daemon', label: 'Mailer Daemon (Bounce)' },
    { type: 'contains', value: 'noreply@google.com', label: 'Google System' },
];

// ── SUBJECT BLOCKLIST ──────────────────────────────────────────────
// Subjects matching these patterns are auto-archived, never forwarded.
// DECISION(2026-03-20): Keep this list TIGHT. Only skip emails that are
// 100% system-generated junk. Vendor communications about payment status
// (remittance advice, late notices, etc.) must NOT be skipped — they need
// human review to cross-check Bill.com.
const SUBJECT_SKIP_PATTERNS: RegExp[] = [
    /undeliverable/i,
    /delivery.*failed/i,
    /returned.*mail/i,
    /auto[-\s]?reply/i,
    /out of office/i,
];

// ── PDF CONTENT BLOCKLIST ─────────────────────────────────────────
// If the first ~2KB of extracted PDF text matches any of these, the
// invoice is blocked from Bill.com forwarding.
//
// DECISION(2026-03-20): Keep this list EXTREMELY conservative.
// Only patterns that are 100% guaranteed non-payable. When in doubt,
// let it through for human review.
//
// NOT blocked (intentionally — need human review):
//   - Proforma invoices (can be payable)
//   - Quotations (vendor may update to invoice)
//   - Remittance advice (need to verify against Bill.com)
//   - "Your invoice is late" (need to check Bill.com)
const PDF_BLOCK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /do\s*not\s*pay/i, reason: 'PDF contains "Do Not Pay"' },
    { pattern: /this\s+is\s+not\s+a\s+bill/i, reason: 'PDF states "This is not a bill"' },
    { pattern: /informational\s+purposes\s+only/i, reason: 'PDF is informational only' },
    { pattern: /already\s+paid/i, reason: 'PDF says "Already Paid"' },
    { pattern: /balance\s*:?\s*\$?\s*0\.00/i, reason: 'PDF shows $0.00 balance' },
    { pattern: /paid\s+in\s+full/i, reason: 'PDF says "Paid in Full"' },
    // DECISION(2026-03-23): Added after Dash invoice (DASH-032026-16581) was forwarded
    // to Bill.com despite prominently displaying "PAID" as a status marker. Paid invoices
    // with zero balance should never reach Bill.com — they are payment confirmations.
    { pattern: /payment\s+terms[\s\S]*\bPAID\b/i, reason: 'PDF shows "PAID" near payment terms' },
    { pattern: /(?:^|\n)\s*PAID\s*(?:\n|$)/m, reason: 'PDF has standalone "PAID" status marker' },
    { pattern: /\bamount\s+paid\b[\s\S]{0,120}\$[\d,]+\.\d{2}[\s\S]*\b(?:balance|due)\b[\s\S]{0,120}\$?\s*0\.00/i, reason: 'PDF shows amount paid with $0.00 balance' },
];

// ── MULTI-INVOICE STATEMENT VENDORS ──────────────────────────────
// DECISION(2026-03-23): Some vendors send "statements" that are actually
// bundles of 3-6 individual invoices mixed with BOLs and cover letters.
// When these are classified as STATEMENT, we must split them into
// individual invoice PDFs and queue each for Bill.com forwarding.
const MULTI_INVOICE_STATEMENT_VENDORS: Array<{
    senderMatch: RegExp;
    filenameMatch?: RegExp;
    label: string;
}> = [
    {
        senderMatch: /aaa\s*cooper/i,
        filenameMatch: /ACT_STMD/i,
        label: 'AAA Cooper',
    },
];

export class APIdentifierAgent {

    private bot: Telegraf | null;

    constructor(bot?: Telegraf) {
        this.bot = bot || null;
    }

    private async classifyEmailIntent(subject: string, from: string, snippet: string): Promise<string> {
        const schema = z.object({
            intent: z.enum(["INVOICE", "STATEMENT", "ADVERTISEMENT", "HUMAN_INTERACTION", "PAID_INVOICE"]),
        });

        // Recall rules to see if this vendor has specific handling instructions
        const memories = await recall(`Accounts Payable routing rules for vendor ${from} subject ${subject}`, { topK: 3, minScore: 0.5 });
        let memoryContext = "";
        if (memories.length > 0) {
            memoryContext = "\n\nPast Experiences & Specific Vendor Rules:\n" + memories.map(m => `- [${m.category}] ${m.content}`).join("\n");
        }

        const prompt = `Classify this AP inbox email. Reply with the single intent label only.
From: ${from}
Subject: ${subject}
Snippet: ${snippet}
${memoryContext}

INVOICE - Standard vendor bill (may or may not have a PO).
STATEMENT - Account statement or aging summary.
ADVERTISEMENT - Marketing, spam, or newsletter.
HUMAN_INTERACTION - Payment question, order issue, or anything requiring a human reply.
PAID_INVOICE - Payment confirmation for an invoice that has been paid (e.g. "Invoice INV___ paid $___", "payment successful", "balance $0.00").`;

        try {
            const res = await unifiedObjectGeneration({
                system: "AP routing engine. Return the intent label only.",
                prompt,
                schema,
                schemaName: "EmailIntent"
            }) as { intent: string };

            return res.intent;
        } catch (err) {
            console.error("   Failed to classify intent, defaulting to HUMAN_INTERACTION", err);
            return "HUMAN_INTERACTION";
        }
    }

    private async getOrCreateLabel(gmail: any, labelName: string): Promise<string> {
        const res = await gmail.users.labels.list({ userId: "me" });
        const existing = res.data.labels?.find((l: any) => l.name?.toLowerCase() === labelName.toLowerCase());

        if (existing?.id) return existing.id;

        const created = await gmail.users.labels.create({
            userId: "me",
            requestBody: {
                name: labelName,
                labelListVisibility: "labelShow",
                messageListVisibility: "show"
            }
        });
        return created.data.id!;
    }

    private async logActivity(supabase: any, from: string, subject: string, intent: string, action: string, metadata: any = {}) {
        if (!supabase) return;
        try {
            await supabase.from("ap_activity_log").insert({
                email_from: from,
                email_subject: subject,
                intent,
                action_taken: action,
                metadata
            });
        } catch (e: any) {
            console.error("   ❌ Failed to log activity:", e.message);
        }
    }

    /**
     * Polls the Supabase email queue for unread AP emails, classifies them, and queues PDFs.
     */
    async identifyAndQueue() {
        console.log("🕵️‍♀️ [AP-Identifier] Scanning queue for new invoices...");
        try {
            const supabase = createClient();

            if (!supabase) {
                console.error("   ❌ Supabase client not available.");
                return;
            }

            // Cache GMail clients by tokenIdentifier to prevent recreating them on every email
            const gmailClients: Record<string, any> = {};
            const getGmailClient = async (inbox: string) => {
                if (!gmailClients[inbox]) {
                    try {
                        const auth = await getAuthenticatedClient(inbox);
                        gmailClients[inbox] = GmailApi({ version: "v1", auth });
                    } catch (e: any) {
                        console.warn(`   ⚠️ Missing '${inbox}' token, falling back to 'default' token...`);
                        const fallbackAuth = await getAuthenticatedClient("default");
                        gmailClients[inbox] = GmailApi({ version: "v1", auth: fallbackAuth });
                    }
                }
                return gmailClients[inbox];
            };

            // Read from central queue instead of making a direct Gmail API search
            const { data: messages, error } = await supabase
                .from('email_inbox_queue')
                .select('*')
                .eq('processed_by_ap', false)
                .limit(15);

            if (error) throw error;

            if (!messages || messages.length === 0) {
                return;
            }

            console.log(`   Found ${messages.length} email(s) in queue to identify.`);

            // Labels are account-scoped in Gmail — fetch and cache per source inbox
            const labelCache: Record<string, { invoiceFwd: string; statements: string }> = {};
            const getLabels = async (inbox: string) => {
                if (!labelCache[inbox]) {
                    const gm = await getGmailClient(inbox);
                    labelCache[inbox] = {
                        invoiceFwd: await this.getOrCreateLabel(gm, "Invoice Forward"),
                        statements: await this.getOrCreateLabel(gm, "Statements"),
                    };
                }
                return labelCache[inbox];
            };

            for (const m of messages) {
                const sourceInbox = m.source_inbox || "ap";
                const gmail = await getGmailClient(sourceInbox);

                // Lock row
                await supabase.from('email_inbox_queue')
                    .update({ processed_by_ap: true })
                    .eq('id', m.id);

                const subject = m.subject || "No Subject";
                const from = m.from_email || "Unknown Sender";
                const snippet = m.body_snippet || "";
                const fromLower = from.toLowerCase();

                // ── SENDER BLOCKLIST CHECK ─────────────────────────────────
                // DECISION(2026-03-20): Block internal, Toyota/TICF, and bounce
                // emails before any other processing. These must NEVER reach
                // Bill.com regardless of PDF content or subject.
                const blockedSender = SENDER_BLOCKLIST.find(rule => {
                    if (rule.type === 'exact') return fromLower === rule.value.toLowerCase();
                    if (rule.type === 'domain') return fromLower.includes(`@${rule.value.toLowerCase()}`);
                    return fromLower.includes(rule.value.toLowerCase());
                });
                if (blockedSender) {
                    console.log(`   🚫 Blocked sender: "${subject}" from ${from} — ${blockedSender.label}`);
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                        });
                    } catch (e) { /* ignore */ }
                    await this.logActivity(supabase, from, subject, "BLOCKED_SENDER",
                        `Blocked: ${blockedSender.label} — archived without forwarding`);
                    continue;
                }

                // ── TAX DOCUMENT GUARD ─────────────────────────────────────
                // DECISION(2026-03-24): Tax documents must never be marked as read
                // or archived automatically. They require manual human handling.
                const isTaxRelated = /\btax(es)?\b|w-?9|1099|1040|sales tax|tax return|tax exemption/i.test(subject) ||
                                     /\btax(es)?\b|w-?9|1099|1040/i.test(snippet) ||
                                     (m.pdf_filenames || []).some((f: string) => /\btax(es)?\b|w-?9|1099|1040/i.test(f));
                
                if (isTaxRelated) {
                    console.log(`   ⚠️ TAX DOCUMENT: "${subject}". Leaving unread for human review.`);
                    await this.logActivity(supabase, from, subject, "TAX_DOCUMENT", 
                        "Tax document detected — leaving unread in inbox");
                    continue; // Skip all further processing; remains UNREAD and in INBOX
                }

                // ── SUBJECT SKIP CHECK ─────────────────────────────────────
                const subjectBlocked = SUBJECT_SKIP_PATTERNS.find(p => p.test(subject));
                if (subjectBlocked) {
                    console.log(`   🚫 Blocked subject: "${subject}" — matches skip pattern`);
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                        });
                    } catch (e) { /* ignore */ }
                    await this.logActivity(supabase, from, subject, "BLOCKED_SUBJECT",
                        `Blocked: subject matches skip pattern — archived without forwarding`);
                    continue;
                }

                // Fetch full message payload from Gmail ONLY to get the PDF buffers 
                // We could skip fetching if !m.has_pdf, but we'll fetch anyway to safely apply labels.
                let msg: any;
                try {
                    msg = await gmail.users.messages.get({ userId: "me", id: m.gmail_message_id });
                } catch (fetchErr: any) {
                    const isQuota = fetchErr.code === 429 ||
                        String(fetchErr.message).toLowerCase().includes("quota") ||
                        String(fetchErr.message).toLowerCase().includes("ratelimit");
                    if (isQuota) {
                        console.warn("   ⚠️ Gmail API rate limit hit — stopping batch early.");
                        break;
                    }
                    console.error(`   ❌ Failed to fetch message payload for ${m.gmail_message_id}`);
                    continue;
                }
                const payload = msg.data.payload;

                console.log(`   Evaluating Email: "${subject}" from ${from}`);

                // ── PDF filename heuristics (pre-LLM) ────────────────────────
                // DECISION(2026-03-19): Tightened from original (2026-03-13) heuristic.
                // Previous version matched 'baspo' and 'po[_-]?\d+' in filenames,
                // which incorrectly forced PO confirmation docs (e.g. BASPO-124498.pdf)
                // to INVOICE. Now we split into positive signals (invoice-like names)
                // and negative signals (PO docs, BOLs, acks, certs) for cleaner routing.
                const pdfFilenames: string[] = m.pdf_filenames || [];

                // Positive: filename clearly says "invoice" or "inv_" (vendor invoices)
                const hasInvoicePdf = pdfFilenames.some((f: string) =>
                    /\b(invoice|inv[_\-])/i.test(f)
                );
                // Negative: PO documents returned by vendor, BOLs, acks, certs
                const isNonInvoicePdf = pdfFilenames.every((f: string) =>
                    /\b(baspo|bol\b|acknowledgement|ordack|confirm|cert|org\s*cert|shipped\s*paperwork)/i.test(f)
                );
                // PO-thread context from subject line
                const isPOThread = /\bPO\s*#?\s*\d+/i.test(subject) || /\bpurchase\s*order\b/i.test(subject);
                const hasPdfAttachment = pdfFilenames.length > 0;
                // Subject signals for non-invoice PO emails
                const isReadyNotification = /\*\*READY\*\*/i.test(subject);
                const isOrderAck = /acknowledgement|order\s*confirm/i.test(subject);

                let intent: string;
                if (hasInvoicePdf && !isNonInvoicePdf) {
                    // Override: PDF filename clearly indicates an invoice document
                    intent = "INVOICE";
                    console.log(`     -> Forced INVOICE (PDF filename match: ${pdfFilenames.join(', ')})`);
                } else if (isReadyNotification || isOrderAck) {
                    // DECISION(2026-03-19): "PO READY" notifications and order acks
                    // are vendor confirmations, not invoices. Skip without LLM call.
                    intent = "HUMAN_INTERACTION";
                    console.log(`     -> Forced HUMAN_INTERACTION (PO ready/ack, not invoice)`);
                } else if (isNonInvoicePdf && hasPdfAttachment) {
                    // All attached PDFs are PO docs, BOLs, or certs — not invoices
                    intent = "HUMAN_INTERACTION";
                    console.log(`     -> Forced HUMAN_INTERACTION (PDFs are PO docs/BOLs, not invoices)`);
                } else if (isPOThread && hasPdfAttachment && !isNonInvoicePdf) {
                    // PO thread with a PDF that isn't clearly a PO doc — likely an invoice
                    intent = "INVOICE";
                    console.log(`     -> Forced INVOICE (PO thread + non-PO PDF attached)`);
                } else if (detectPaidInvoice(subject, m.body_text || snippet, hasPdfAttachment)) {
                    // DECISION(2026-03-16): Fast regex pre-check for paid invoice confirmations.
                    // Fires BEFORE LLM classification to avoid misclassifying as HUMAN_INTERACTION.
                    intent = "PAID_INVOICE";
                    console.log(`     -> Forced PAID_INVOICE (regex heuristic match)`);
                } else {
                    // DECISION(2026-03-24): Check nightshift pre-classification before paid LLM call.
                    // If the local model classified this overnight with confidence >= 0.7, use it.
                    // Falls through to paid LLM on null return — zero risk to daytime AP flow.
                    const preClass = await getPreClassification(m.gmail_message_id).catch(() => null);
                    if (preClass) {
                        intent = preClass.classification;
                        console.log(`     -> Pre-classified (${preClass.handler}, conf=${preClass.confidence.toFixed(2)}): ${intent}`);
                    } else {
                        intent = await this.classifyEmailIntent(subject, from, snippet);
                        console.log(`     -> Classified as: ${intent}`);
                    }
                }

                if (intent === "ADVERTISEMENT") {
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                        });
                        await this.logActivity(supabase, from, subject, "ADVERTISEMENT", "Archived and marked read");
                    } catch (e) { /* ignore */ }
                    continue;
                }

                if (intent === "STATEMENT") {
                    // ── CHECK: Is this a multi-invoice "statement"? ──────────
                    // DECISION(2026-03-23): Some vendors (AAA Cooper) send bundled
                    // invoices labeled as "statements." Before dead-ending, check
                    // if the sender matches a known multi-invoice vendor pattern.
                    // If so, split the PDF and queue individual invoices.
                    const pdfNames: string[] = m.pdf_filenames || [];
                    const multiInvVendor = MULTI_INVOICE_STATEMENT_VENDORS.find(v =>
                        v.senderMatch.test(from) ||
                        (v.filenameMatch && pdfNames.some((f: string) => v.filenameMatch!.test(f)))
                    );

                    if (multiInvVendor && m.gmail_message_id) {
                        try {
                            const handled = await this.handleMultiInvoiceStatement(
                                m, gmail, supabase, multiInvVendor.label,
                            );
                            if (handled) {
                                // Successfully split — label as processed and archive
                                try {
                                    await gmail.users.messages.modify({
                                        userId: "me",
                                        id: m.gmail_message_id,
                                        requestBody: {
                                            addLabelIds: [(await getLabels(sourceInbox)).invoiceFwd],
                                            removeLabelIds: ["INBOX", "UNREAD"]
                                        }
                                    });
                                } catch (e) { /* ignore */ }
                                continue;
                            }
                            // Fall through to normal STATEMENT handling if split failed
                        } catch (err: any) {
                            console.error(`     ❌ Multi-invoice statement split failed:`, err.message);
                            await this.logActivity(supabase, from, subject, "STATEMENT",
                                `Multi-invoice split failed: ${err.message} — falling back to label`);
                            // Fall through to normal STATEMENT handling
                        }
                    }

                    // Default STATEMENT handling: label and archive
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: {
                                addLabelIds: [(await getLabels(sourceInbox)).statements],
                                removeLabelIds: ["INBOX", "UNREAD"]
                            }
                        });
                        await this.logActivity(supabase, from, subject, "STATEMENT", "Labeled as Statement, marked read");
                    } catch (e) { /* ignore */ }
                    continue;
                }

                if (intent === "HUMAN_INTERACTION") {
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                        });
                    } catch (e) { /* ignore */ }
                    continue;
                }

                // ── PAID INVOICE HANDLER ──────────────────────────────────────
                // DECISION(2026-03-16): Detect paid invoice confirmations, extract
                // vendor/invoice/amount via LLM, cross-reference with Finale POs,
                // and create a draft PO when no match is found.
                if (intent === "PAID_INVOICE") {
                    try {
                        await this.handlePaidInvoice(m, gmail, supabase, sourceInbox, getLabels);
                    } catch (err: any) {
                        console.error(`     ❌ PAID_INVOICE handler failed:`, err.message);
                        await this.logActivity(supabase, from, subject, "PAID_INVOICE", `Handler error: ${err.message}`);
                    }
                    continue;
                }

                // ── INBOX GATE ──────────────────────────────────────────────
                // DECISION(2026-03-19): Only the AP inbox (ap@buildasoil.com)
                // should forward invoices to Bill.com. The default inbox
                // (bill.selee@buildasoil.com) receives PO threads, quotes,
                // and vendor correspondence that may have PDFs attached but
                // are NOT to be forwarded. Keep them visible for review.
                if (sourceInbox !== 'ap') {
                    console.log(`     ⚠️ Invoice detected on '${sourceInbox}' inbox — labeling only, not queuing for Bill.com`);
                    const policy = getInvoiceInboxPolicy(sourceInbox);
                    try {
                        await applyMessageLabelPolicy({
                            gmail,
                            gmailMessageId: m.gmail_message_id,
                            addLabels: policy.addLabels,
                            removeLabels: policy.removeLabels,
                        });
                    } catch (e) { /* ignore */ }
                    await this.logActivity(supabase, from, subject, intent,
                        policy.activityNote);
                    continue;
                }

                // --- INVOICE QUEUEING (ap inbox only) ---
                let processedAnyPDF = false;

                const pdfParts: any[] = [];
                const walkParts = (parts: any[]): void => {
                    for (const part of parts) {
                        if (part.filename && part.filename.toLowerCase().endsWith(".pdf")) {
                            pdfParts.push(part);
                        }
                        if (part.parts?.length) {
                            walkParts(part.parts);
                        }
                    }
                };
                walkParts(payload?.parts || []);

                let attachmentIndex = 0;
                for (const part of pdfParts) {
                    if (part.body?.attachmentId) {
                        try {
                            const capturedFilename = part.filename;
                            const uniqueMsgId = pdfParts.length > 1 ? `${m.gmail_message_id}_${attachmentIndex}` : m.gmail_message_id;

                            // ── Dedup Check 1: same message_id (same inbox re-scan) ──
                            const { data: existing } = await supabase
                                .from("ap_inbox_queue")
                                .select("id")
                                .eq("message_id", uniqueMsgId)
                                .maybeSingle();

                            if (existing) {
                                console.log(`     ⚠️ Already queued ${capturedFilename}, skipping...`);
                                attachmentIndex++;
                                continue;
                            }

                            // ── Dedup Check 2: cross-inbox duplicate ─────────────────
                            // DECISION(2026-03-19): Same invoice arrives on both ap and
                            // default inboxes with different gmail_message_ids. Match on
                            // (email_from, pdf_filename, email_subject) within 24h to
                            // prevent duplicate Bill.com forwards.
                            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                            const { data: crossInboxDup } = await supabase
                                .from("ap_inbox_queue")
                                .select("id, source_inbox")
                                .eq("email_from", from)
                                .eq("pdf_filename", capturedFilename)
                                .eq("email_subject", subject)
                                .gte("created_at", twentyFourHoursAgo)
                                .maybeSingle();

                            if (crossInboxDup) {
                                console.log(`     ⚠️ Cross-inbox duplicate: ${capturedFilename} already queued from ${crossInboxDup.source_inbox}, skipping ${sourceInbox} copy`);
                                attachmentIndex++;
                                processedAnyPDF = true; // still mark as handled so label is applied
                                continue;
                            }

                            console.log(`     -> Downloading attachment: ${capturedFilename}`);
                            const response = await gmail.users.messages.attachments.get({
                                userId: "me",
                                messageId: m.gmail_message_id,
                                id: part.body.attachmentId
                            });

                            const attachmentData = response.data.data;
                            if (!attachmentData) continue;
                            const buffer = Buffer.from(attachmentData, "base64url");

                            // ── PDF CONTENT SAFETY CHECK ──────────────────────────
                            // DECISION(2026-03-20): Before forwarding to Bill.com,
                            // scan the first ~2KB of PDF text for block patterns
                            // ("Do Not Pay", "This is not a bill", $0.00 balance).
                            // This catches Toyota/TICF-style invoices that slip past
                            // the sender blocklist via a different sender address.
                            let pdfTextPreview = '';
                            try {
                                const { extractPDF } = await import('../../pdf/extractor');
                                const extracted = await extractPDF(buffer);
                                pdfTextPreview = extracted.rawText.slice(0, 2000);
                            } catch {
                                // PDF extraction failed — don't block, let it through
                                console.warn(`     ⚠️ PDF text extraction failed for ${capturedFilename} — skipping content check`);
                            }

                            if (pdfTextPreview) {
                                const blockedContent = PDF_BLOCK_PATTERNS.find(p => p.pattern.test(pdfTextPreview));
                                if (blockedContent) {
                                    console.log(`     🚫 PDF BLOCKED: ${capturedFilename} — ${blockedContent.reason}`);
                                    await this.logActivity(supabase, from, subject, "BLOCKED_PDF_CONTENT",
                                        `PDF blocked from Bill.com: ${blockedContent.reason} (${capturedFilename})`);
                                    // Mark email as read and archive — do not forward
                                    try {
                                        await gmail.users.messages.modify({
                                            userId: "me",
                                            id: m.gmail_message_id,
                                            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                                        });
                                    } catch (e) { /* ignore */ }
                                    attachmentIndex++;
                                    continue; // Skip this attachment, do NOT queue
                                }
                            }

                            // Upload to Supabase Storage
                            const storagePath = `${m.gmail_message_id}/${Date.now()}_${capturedFilename}`;
                            const { error: uploadError } = await supabase.storage
                                .from('ap_invoices')
                                .upload(storagePath, buffer, {
                                    contentType: 'application/pdf',
                                    upsert: true
                                });

                            if (uploadError) {
                                throw new Error(`Storage upload failed: ${uploadError.message}`);
                            }

                            // DECISION(2026-03-19): Queue directly as PENDING_FORWARD.
                            // Previously set to PENDING_EXTRACTION, but no extraction
                            // worker existed — invoices got stuck permanently. The PDF is
                            // already in Storage; the AP Forwarder downloads and sends it
                            // to Bill.com. Reconciliation happens independently afterwards.
                            // This matches the SOP: "forward immediately, reconcile later."
                            const queueStatus = 'PENDING_FORWARD';

                            const { error: insertError } = await supabase.from("ap_inbox_queue").insert({
                                message_id: uniqueMsgId,
                                email_from: from,
                                email_subject: subject,
                                intent: intent,
                                pdf_path: storagePath,
                                pdf_filename: capturedFilename,
                                status: queueStatus,
                                source_inbox: sourceInbox
                            });

                            if (insertError) {
                                throw new Error(`Queue insert failed: ${insertError.message}`);
                            }

                            console.log(`     ✅ Queued ${capturedFilename} → ${queueStatus} (ready for Bill.com)`);
                            processedAnyPDF = true;
                            attachmentIndex++;

                        } catch (err: any) {
                            console.error(`     ❌ Failed to queue attachment:`, err.message);
                            await this.logActivity(supabase, from, subject, "PROCESSING_ERROR", `Queue failed: ${err.message}`);
                        }
                    }
                }

                if (processedAnyPDF) {
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: {
                                addLabelIds: [(await getLabels(sourceInbox)).invoiceFwd],
                                removeLabelIds: ["INBOX", "UNREAD"]  // Decoupled! We mark as read IMMEDIATELY upon successful queuing
                            }
                        });
                    } catch (e) { /* ignore */ }
                    const pdfNames = pdfParts.map((p: any) => p.filename).join(", ");
                    const logNote = `Queued for Bill.com forward (${pdfNames})`;
                    await this.logActivity(supabase, from, subject, intent, logNote, { attachments: pdfNames });
                } else {
                    console.log(`     ⚠️ No PDF found on ${intent}. Leaving unread for human check.`);
                    await this.logActivity(supabase, from, subject, intent, "No PDF attachment found — left unread for manual review");
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                        });
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (err: any) {
            console.error("❌ [AP-Identifier] Error processing AP Inbox:", err.message);
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PAID INVOICE HANDLER
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Process a paid invoice confirmation email:
     * 1. Extract vendor, invoice #, amount via LLM
     * 2. Search Finale for matching PO (by PO# in invoice, then by vendor + amount)
     * 3. If matched → log it
     * 4. If no match → create a draft PO with placeholder SKU
     * 5. Alert via Telegram
     * 6. Label email as AP-Seen
     */
    private async handlePaidInvoice(
        emailRow: any,
        gmail: any,
        supabase: any,
        sourceInbox: string,
        getLabels: (inbox: string) => Promise<{ invoiceFwd: string; statements: string }>
    ): Promise<void> {
        const subject = emailRow.subject || 'No Subject';
        const from = emailRow.from_email || 'Unknown';
        const bodyText = emailRow.body_text || emailRow.body_snippet || '';

        console.log(`     💳 Processing paid invoice: "${subject}"`);

        // Step 1: LLM extraction
        const extracted = await parsePaidInvoice(bodyText, subject, from);
        console.log(`     📋 Extracted: vendor="${extracted.vendorName}", inv#=${extracted.invoiceNumber}, $${extracted.amountPaid}, PO#=${extracted.poNumber || 'none'}`);

        const finale = new FinaleClient();
        let matchedPO: { orderId: string; total: number; status: string } | null = null;

        // Step 2a: If the email references a PO number, try direct lookup first
        if (extracted.poNumber) {
            try {
                const summary = await finale.getOrderSummary(extracted.poNumber);
                if (summary) {
                    matchedPO = { orderId: summary.orderId, total: summary.total, status: summary.status };
                    console.log(`     ✅ Matched by PO# ${summary.orderId} (status: ${summary.status})`);
                }
            } catch {
                console.log(`     ⚠️ Direct PO# lookup for ${extracted.poNumber} failed, trying fuzzy match...`);
            }
        }

        // Step 2b: Fuzzy match by vendor name + date + amount
        if (!matchedPO) {
            const candidates = await finale.findPOByVendorAndDate(
                extracted.vendorName,
                extracted.datePaid || new Date().toISOString().split('T')[0],
                60   // 60-day window — paid invoices can arrive well after the PO
            );

            if (candidates.length > 0) {
                // Prefer amount match, then most recent
                const amountMatch = candidates.find(c =>
                    Math.abs(c.total - extracted.amountPaid) < 1.00  // within $1 tolerance
                );
                const best = amountMatch || candidates[0];
                matchedPO = { orderId: best.orderId, total: best.total, status: best.status };
                console.log(`     ✅ Fuzzy-matched to PO #${best.orderId} ($${best.total}, ${best.status})`);
            }
        }

        // Step 3: Log to Supabase
        try {
            await supabase.from('paid_invoices').insert({
                vendor_name: extracted.vendorName,
                invoice_number: extracted.invoiceNumber,
                amount_paid: extracted.amountPaid,
                date_paid: extracted.datePaid,
                po_number: matchedPO?.orderId || null,
                po_matched: !!matchedPO,
                product_description: extracted.productDescription,
                vendor_address: extracted.vendorAddress,
                email_from: from,
                email_subject: subject,
                gmail_message_id: emailRow.gmail_message_id,
                confidence: extracted.confidence,
                source_inbox: sourceInbox,
            });
        } catch (dbErr: any) {
            // Table might not exist yet — log but don't block
            console.warn(`     ⚠️ paid_invoices insert failed (table may not exist):`, dbErr.message);
        }

        // Step 4: If no PO match, create a draft PO for Will to review
        // DEDUP GUARD: Check if we already created a draft PO for this vendor/invoice
        let draftInfo: { orderId: string; finaleUrl: string } | null = null;
        let skipDraftCreation = false;

        if (!matchedPO) {
            // Check paid_invoices table for existing record with same vendor + invoice
            try {
                const { data: existingPaid } = await supabase
                    .from('paid_invoices')
                    .select('id, po_number, po_matched')
                    .eq('vendor_name', extracted.vendorName)
                    .eq('invoice_number', extracted.invoiceNumber)
                    .maybeSingle();

                if (existingPaid?.po_number) {
                    console.log(`     ⚠️ DEDUP: Draft PO already exists for ${extracted.vendorName} inv#${extracted.invoiceNumber} → PO #${existingPaid.po_number}. Skipping.`);
                    matchedPO = { orderId: existingPaid.po_number, total: extracted.amountPaid, status: 'Draft' };
                    skipDraftCreation = true;
                } else if (existingPaid) {
                    console.log(`     ⚠️ DEDUP: Already processed ${extracted.vendorName} inv#${extracted.invoiceNumber} (no PO matched). Skipping.`);
                    skipDraftCreation = true;
                }
            } catch { /* table may not exist — proceed normally */ }

            // Also check if we created a draft PO for this vendor in the last 24h
            if (!skipDraftCreation) {
                try {
                    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                    const { data: recentDraft } = await supabase
                        .from('paid_invoices')
                        .select('id, po_number')
                        .eq('vendor_name', extracted.vendorName)
                        .gte('created_at', twentyFourHoursAgo)
                        .not('po_number', 'is', null)
                        .limit(1)
                        .maybeSingle();

                    if (recentDraft?.po_number) {
                        console.log(`     ⚠️ DEDUP: Recent draft PO #${recentDraft.po_number} exists for ${extracted.vendorName} (last 24h). Skipping.`);
                        matchedPO = { orderId: recentDraft.po_number, total: extracted.amountPaid, status: 'Draft' };
                        skipDraftCreation = true;
                    }
                } catch { /* proceed normally */ }
            }
        }

        if (!matchedPO && !skipDraftCreation) {
            try {
                const vendorPartyId = await finale.findVendorPartyByName(extracted.vendorName);

                if (vendorPartyId) {
                    // DECISION(2026-03-16): Create draft PO with placeholder SKU.
                    // Real SKU correlation is complex — for now, use a single
                    // generic line item at the paid amount. Will adds the real SKU.
                    const memo = [
                        `[Aria] Auto-created from paid invoice confirmation`,
                        `Invoice: ${extracted.invoiceNumber}`,
                        `Amount: $${extracted.amountPaid.toFixed(2)}`,
                        `Date: ${extracted.datePaid}`,
                        extracted.productDescription ? `Product: ${extracted.productDescription}` : null,
                        `Source email: ${from}`,
                        `⚠️ REMINDER: Add the correct vendor SKU to this PO before committing.`,
                    ].filter(Boolean).join('\n');

                    const result = await finale.createDraftPurchaseOrder(
                        vendorPartyId,
                        [{
                            productId: 'PLACEHOLDER-PAID-INVOICE',
                            quantity: 1,
                            unitPrice: extracted.amountPaid,
                        }],
                        memo
                    );

                    draftInfo = { orderId: result.orderId, finaleUrl: result.finaleUrl };
                    console.log(`     📝 Created draft PO #${result.orderId} for review`);
                } else {
                    console.warn(`     ⚠️ Could not find vendor party for "${extracted.vendorName}" — no draft PO created`);
                }
            } catch (draftErr: any) {
                console.error(`     ❌ Draft PO creation failed:`, draftErr.message);
            }
        }

        // Step 5: Telegram alert
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (chatId && this.bot) {
            let message: string;
            if (matchedPO) {
                message = [
                    `✅ <b>Paid Invoice Matched</b>`,
                    ``,
                    `<b>Vendor:</b> ${this.escapeHtml(extracted.vendorName)}`,
                    `<b>Invoice:</b> ${this.escapeHtml(extracted.invoiceNumber)} — $${extracted.amountPaid.toFixed(2)}`,
                    `<b>Matched:</b> PO #${matchedPO.orderId} ($${matchedPO.total.toFixed(2)}, ${matchedPO.status})`,
                    `<b>Date Paid:</b> ${extracted.datePaid}`,
                    extracted.productDescription ? `<b>Product:</b> ${this.escapeHtml(extracted.productDescription)}` : '',
                    ``,
                    `📋 Logged to paid_invoices`,
                ].filter(Boolean).join('\n');
            } else if (draftInfo) {
                message = [
                    `⚠️ <b>Paid Invoice — No PO Found</b>`,
                    ``,
                    `<b>Vendor:</b> ${this.escapeHtml(extracted.vendorName)}`,
                    `<b>Invoice:</b> ${this.escapeHtml(extracted.invoiceNumber)} — $${extracted.amountPaid.toFixed(2)}`,
                    `<b>Date Paid:</b> ${extracted.datePaid}`,
                    extracted.productDescription ? `<b>Product:</b> ${this.escapeHtml(extracted.productDescription)}` : '',
                    ``,
                    `📝 Created Draft PO #${draftInfo.orderId} for review`,
                    `⚠️ <i>Add the correct vendor SKU before committing</i>`,
                    ``,
                    `<a href="${draftInfo.finaleUrl}">Open in Finale →</a>`,
                ].filter(Boolean).join('\n');
            } else {
                message = [
                    `🔍 <b>Paid Invoice — Manual Review Needed</b>`,
                    ``,
                    `<b>Vendor:</b> ${this.escapeHtml(extracted.vendorName)}`,
                    `<b>Invoice:</b> ${this.escapeHtml(extracted.invoiceNumber)} — $${extracted.amountPaid.toFixed(2)}`,
                    `<b>Date Paid:</b> ${extracted.datePaid}`,
                    extracted.productDescription ? `<b>Product:</b> ${this.escapeHtml(extracted.productDescription)}` : '',
                    ``,
                    `❌ Could not find vendor in Finale — no draft PO created.`,
                    `Please create PO manually.`,
                ].filter(Boolean).join('\n');
            }

            try {
                await this.bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
            } catch (tgErr: any) {
                console.warn(`     ⚠️ Telegram alert failed:`, tgErr.message);
            }
        }

        // Step 6: Label email and log activity
        try {
            const labels = await getLabels(sourceInbox);
            await gmail.users.messages.modify({
                userId: "me",
                id: emailRow.gmail_message_id,
                requestBody: {
                    removeLabelIds: ["INBOX", "UNREAD"]
                }
            });
        } catch (e) { /* ignore */ }

        const action = matchedPO
            ? `Matched to PO #${matchedPO.orderId}`
            : draftInfo
                ? `Draft PO #${draftInfo.orderId} created`
                : `No PO match, vendor not found in Finale`;

        await this.logActivity(supabase, from, subject, 'PAID_INVOICE', action, {
            invoiceNumber: extracted.invoiceNumber,
            amountPaid: extracted.amountPaid,
            vendorName: extracted.vendorName,
            matchedPO: matchedPO?.orderId || null,
            draftPO: draftInfo?.orderId || null,
            confidence: extracted.confidence,
        });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // MULTI-INVOICE STATEMENT HANDLER (AAA Cooper-style)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Splits a multi-invoice "statement" PDF into individual invoice PDFs.
     *
     * AAA Cooper (and similar vendors) bundle 3-6 invoices into one PDF along
     * with BOLs, delivery receipts, and cover letters. Each invoice has its
     * own PRO number and needs to be sent individually to Bill.com.
     *
     * Process:
     * 1. Download the PDF attachment from Gmail
     * 2. Extract text per-page using pdf-lib + pdf-parse
     * 3. LLM classifies each page as INVOICE / BOL / COVER / OTHER
     * 4. For each INVOICE page: extract into its own PDF, name by PRO/invoice #
     * 5. Upload each to Supabase Storage
     * 6. Queue each as PENDING_FORWARD in ap_inbox_queue
     * 7. Existing AP Forwarder picks them up and sends to Bill.com
     *
     * @returns true if statement was successfully split and queued, false if
     *          it should fall through to default STATEMENT handling.
     */
    private async handleMultiInvoiceStatement(
        emailRow: any,
        gmail: any,
        supabase: any,
        vendorLabel: string,
    ): Promise<boolean> {
        const subject = emailRow.subject || 'No Subject';
        const from = emailRow.from_email || 'Unknown';
        const msgId = emailRow.gmail_message_id;

        console.log(`     ✂️ Multi-invoice statement detected (${vendorLabel}): "${subject}"`);

        // Step 1: Fetch full message and find PDF attachments
        let msg: any;
        try {
            msg = await gmail.users.messages.get({ userId: 'me', id: msgId });
        } catch (err: any) {
            console.error(`     ❌ Failed to fetch message for statement split:`, err.message);
            return false;
        }

        const pdfParts: any[] = [];
        const walkParts = (parts: any[]): void => {
            for (const part of parts) {
                if (part.filename && part.filename.toLowerCase().endsWith('.pdf')) {
                    pdfParts.push(part);
                }
                if (part.parts?.length) walkParts(part.parts);
            }
        };
        walkParts(msg.data.payload?.parts || []);

        if (pdfParts.length === 0) {
            console.log(`     ⚠️ No PDF attachment found on statement email — falling through`);
            return false;
        }

        // Process the first PDF attachment (statements are typically single-PDF)
        const pdfPart = pdfParts[0];
        if (!pdfPart.body?.attachmentId) return false;

        let buffer: Buffer;
        try {
            const response = await gmail.users.messages.attachments.get({
                userId: 'me',
                messageId: msgId,
                id: pdfPart.body.attachmentId,
            });
            const attachmentData = response.data.data;
            if (!attachmentData) return false;
            buffer = Buffer.from(attachmentData, 'base64url');
        } catch (err: any) {
            console.error(`     ❌ Failed to download PDF attachment:`, err.message);
            return false;
        }

        console.log(`     📄 Downloaded ${pdfPart.filename} (${(buffer.length / 1024).toFixed(0)} KB)`);

        // Step 2: Per-page text extraction
        const { extractPerPage } = await import('../../pdf/extractor');
        const { PDFDocument } = await import('pdf-lib');
        const pages = await extractPerPage(buffer);

        if (pages.length < 2) {
            console.log(`     ⚠️ Only ${pages.length} page(s) — not a multi-invoice statement`);
            return false;
        }

        console.log(`     🔬 Analyzing ${pages.length} pages for invoice identification...`);

        // Step 3: LLM per-page classification
        const pageAnalysis = await unifiedTextGeneration({
            system: `You analyze freight carrier statement documents page by page. These "statements" contain a mix of individual invoices, bills of lading (BOL), delivery receipts, and cover letters.

For each page, determine:
- INVOICE: An individual freight invoice with charges, a PRO number, shipper/consignee, and a total amount
- BOL: Bill of lading or delivery receipt
- COVER: Cover letter, summary page, or remittance advice
- OTHER: Any other page type

Return ONLY a JSON array with one object per page:
[{"page":1,"type":"COVER"},{"page":2,"type":"BOL"},{"page":3,"type":"INVOICE","invoiceNumber":"64471573","amount":470.51}]

For INVOICE pages, extract:
- invoiceNumber: The PRO number or invoice number (critical for filename)
- amount: The total charge amount

If no invoice number is found, use null.`,
            prompt: `${pages.length} pages from a ${vendorLabel} statement:\n\n${pages.map(p =>
                `=== PAGE ${p.pageNumber} ===\n${p.text.slice(0, 1000)}\n`
            ).join('\n')}`,
        });

        // Parse the LLM response
        let pageResults: Array<{
            page: number;
            type: string;
            invoiceNumber?: string | null;
            amount?: number | null;
        }> = [];
        try {
            const jsonMatch = pageAnalysis.match(/\[[\s\S]*?\]/);
            if (jsonMatch) pageResults = JSON.parse(jsonMatch[0]);
        } catch {
            console.error(`     ❌ Failed to parse page analysis JSON — aborting split`);
            return false;
        }

        const { invoicePages, discardedCount } = filterStatementInvoicePages(
            vendorLabel,
            pageResults.map((result) => ({
                ...result,
                text: pages.find((page) => page.pageNumber === result.page)?.text || "",
            })),
        );

        if (invoicePages.length === 0) {
            console.log(`     ⚠️ No invoice pages identified in statement — falling through`);
            return false;
        }

        console.log(`     📋 Found ${invoicePages.length} invoice(s); discarded ${discardedCount} paperwork page(s): ${invoicePages.map(p => p.invoiceNumber || `page${p.page}`).join(', ')}`);

        // Step 4: Split PDF and queue each invoice
        const sourcePdf = await PDFDocument.load(buffer);
        let queuedCount = 0;

        for (const invPage of invoicePages) {
            const pageIdx = invPage.page - 1;
            if (pageIdx < 0 || pageIdx >= sourcePdf.getPageCount()) continue;

            const invNum = invPage.invoiceNumber || `page${invPage.page}`;
            const safeInvNum = invNum.replace(/[^a-zA-Z0-9-]/g, '_');
            const invFilename = `${safeInvNum}.pdf`;

            // Create single-page PDF
            const singlePdf = await PDFDocument.create();
            const [copiedPage] = await singlePdf.copyPages(sourcePdf, [pageIdx]);
            singlePdf.addPage(copiedPage);
            const pageBuffer = Buffer.from(await singlePdf.save());

            // Dedup check: same PRO number from same sender within 7 days
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const { data: existingInv } = await supabase
                .from('ap_inbox_queue')
                .select('id')
                .eq('email_from', from)
                .eq('pdf_filename', invFilename)
                .gte('created_at', sevenDaysAgo)
                .maybeSingle();

            if (existingInv) {
                console.log(`     ⚠️ DEDUP: ${invFilename} already queued from ${from} — skipping`);
                continue;
            }

            // Upload to Supabase Storage
            const storagePath = `${msgId}/split_${Date.now()}_${invFilename}`;
            const { error: uploadError } = await supabase.storage
                .from('ap_invoices')
                .upload(storagePath, pageBuffer, {
                    contentType: 'application/pdf',
                    upsert: true,
                });

            if (uploadError) {
                console.error(`     ❌ Storage upload failed for ${invFilename}:`, uploadError.message);
                continue;
            }

            // Queue as PENDING_FORWARD
            const uniqueMsgId = `${msgId}_split_${safeInvNum}`;
            const { error: insertError } = await supabase.from('ap_inbox_queue').insert({
                message_id: uniqueMsgId,
                email_from: from,
                email_subject: `${vendorLabel} Invoice ${invNum}`,
                intent: 'INVOICE',
                pdf_path: storagePath,
                pdf_filename: invFilename,
                status: 'PENDING_FORWARD',
                source_inbox: emailRow.source_inbox || 'ap',
            });

            if (insertError) {
                console.error(`     ❌ Queue insert failed for ${invFilename}:`, insertError.message);
                continue;
            }

            const amountStr = invPage.amount ? ` ($${invPage.amount.toFixed(2)})` : '';
            console.log(`     ✅ Queued ${invFilename}${amountStr} → PENDING_FORWARD`);
            queuedCount++;
        }

        if (queuedCount > 0) {
            await this.logActivity(
                supabase, from, subject, 'MULTI_INVOICE_STATEMENT',
                `Split ${vendorLabel} statement: ${queuedCount} invoice(s) queued for Bill.com`,
                {
                    vendor: vendorLabel,
                    invoicesFound: invoicePages.length,
                    invoicesQueued: queuedCount,
                    discardedPages: discardedCount,
                    invoiceNumbers: invoicePages.map(p => p.invoiceNumber).filter(Boolean),
                    sourceFilename: pdfPart.filename,
                }
            );

            // Telegram notification
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId && this.bot) {
                const invoiceList = invoicePages
                    .map(p => {
                        const num = p.invoiceNumber || `page${p.page}`;
                        const amt = p.amount ? ` — $${p.amount.toFixed(2)}` : '';
                        return `  • ${num}${amt}`;
                    })
                    .join('\n');
                const total = invoicePages.reduce((sum, p) => sum + (p.amount || 0), 0);
                const totalStr = total > 0 ? `\n<b>Statement Total:</b> $${total.toFixed(2)}` : '';

                try {
                    await this.bot.telegram.sendMessage(chatId, [
                        `✂️ <b>${vendorLabel} Statement Split</b>`,
                        ``,
                        `Split <b>${queuedCount}</b> invoice(s); discarded <b>${discardedCount}</b> non-invoice page(s):`,
                        invoiceList,
                        totalStr,
                        ``,
                        `📤 Queued for Bill.com forwarding`,
                    ].filter(Boolean).join('\n'), { parse_mode: 'HTML' });
                } catch { /* non-critical */ }
            }
        }

        return queuedCount > 0;
    }

    /** Escape HTML special characters for Telegram messages. */
    private escapeHtml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
}
