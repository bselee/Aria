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

import { createHash } from "crypto";
import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../../gmail/auth";
import { createClient } from "../../db";
import { z } from "zod";
import { unifiedObjectGeneration, unifiedTextGeneration } from "../llm";
import { recall } from "../memory";
import { detectPaidInvoice, parsePaidInvoice, detectInlineInvoice } from "../inline-invoice-parser";
import { handleInlineInvoice } from "../inline-invoice-handler";
import { getPreClassification } from "../nightshift-agent";
import { FinaleClient } from "../../finale/client";
import { requestDraftPOApproval } from "../../command-board/po-approval-task";
import { Telegraf } from "telegraf";
import { applyMessageLabelPolicy } from "../gmail-policy";
import {
    getAPHumanInteractionPolicy,
    getAPMissingPdfPolicy,
    getInvoiceInboxPolicy,
} from "./ap-identifier-policy";
import {
    queueStatementEmailIntake,
    queueStatementMetadataOnly,
} from "@/lib/statements/email-intake";
import { pickPrimaryInvoicePage } from "./invoice-page-selector";
import { businessHoursAlert } from "../alert-gate";
import { matchVendorRouting } from "../ap/vendor-router";

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
    { type: 'contains', value: 'pioneer propane', label: 'Pioneer Propane (Autopay)' },
    { type: 'contains', value: 'pioneerpropaneinc@gmail.com', label: 'Pioneer Propane (Autopay)' },

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

export class APIdentifierAgent {

    private bot: Telegraf | null;

    constructor(bot?: Telegraf) {
        this.bot = bot || null;
    }

    /**
     * Labels we trust from the overnight nightshift Haiku pre-classifier.
     * If nightshift produced one of these with confidence ≥ 0.7, we skip
     * the paid Sonnet call entirely (KAIZEN #3, 2026-05-05).
     */
    private static readonly NIGHTSHIFT_KNOWN_LABELS: ReadonlySet<string> = new Set([
        "INVOICE",
        "STATEMENT",
        "ADVERTISEMENT",
        "HUMAN_INTERACTION",
        "PAID_INVOICE",
    ]);

    private async classifyEmailIntent(
        subject: string,
        from: string,
        snippet: string,
        gmailMessageId?: string,
    ): Promise<string> {
        // KAIZEN #3 (2026-05-05): Honor nightshift pre-classification before paying for Sonnet.
        // getPreClassification() already enforces conf ≥ 0.7 + valid label, but we re-check
        // here defensively so this method is safe to call from any path.
        if (gmailMessageId) {
            const pre = await getPreClassification(gmailMessageId).catch(() => null);
            if (
                pre &&
                typeof pre.confidence === "number" &&
                pre.confidence >= 0.7 &&
                APIdentifierAgent.NIGHTSHIFT_KNOWN_LABELS.has(pre.classification)
            ) {
                console.log(`     -> Pre-classified (${pre.handler}, conf=${pre.confidence.toFixed(2)}): ${pre.classification} [skipped paid Sonnet]`);
                return pre.classification;
            }
        }

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
                schemaName: "EmailIntent",
                tier: "free",
                maxTokens: 80,
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
        if (!db) return;
        try {
            await db.from("ap_activity_log").insert({
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

    private inferStatementVendorName(from: string, subject: string): string {
        const displayMatch = from.match(/^([^<]+)/);
        const display = displayMatch?.[1]?.trim();
        if (display && !display.includes("@")) return display;

        const emailMatch = from.match(/<([^>]+)>/);
        const email = emailMatch?.[1] ?? from;
        const domain = email.split("@")[1] ?? "";
        const host = domain.split(".")[0] ?? "";
        if (host) {
            return host
                .split(/[-_]/g)
                .filter(Boolean)
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                .join(" ");
        }

        return subject.split("-")[0]?.trim() || "Unknown Vendor";
    }

    private normalizeDocumentNumber(value: string | null | undefined): string | null {
        if (!value) return null;
        const normalized = value.replace(/\D/g, "");
        return normalized.length > 0 ? normalized : null;
    }

    private hasExactNumberSetMatch(expected: string[], actual: string[]): boolean {
        if (expected.length === 0 || actual.length === 0 || expected.length !== actual.length) {
            return false;
        }

        const sortedExpected = [...expected].sort();
        const sortedActual = [...actual].sort();
        return sortedExpected.every((value, index) => value === sortedActual[index]);
    }

    private isFedExInvoiceEmail(
        from: string,
        subject: string,
        snippet: string,
        pdfFilenames: string[],
    ): boolean {
        if (!/fedex/i.test(from)) return false;

        return (
            /\binvoice\b/i.test(subject)
            || /\binvoice\b/i.test(snippet)
            || pdfFilenames.some((filename) => /\b(invoice|bill)\b/i.test(filename))
        );
    }

    private async selectPrimaryInvoicePageNumber(
        buffer: Buffer,
        extractedPages: Array<{ pageNumber: number; text: string; hasTable: boolean }> | undefined,
        pageCount: number | undefined,
    ): Promise<{ pageNumber: number | null; confidence: "none" | "weak" | "strong"; reason: string }> {
        const initialSelection = pickPrimaryInvoicePage(extractedPages || []);
        if (initialSelection.pageNumber || (pageCount ?? 1) <= 1) {
            return initialSelection;
        }

        try {
            const { extractPerPage } = await import("../../pdf/extractor");
            const physicalPages = await extractPerPage(buffer);
            return pickPrimaryInvoicePage(physicalPages);
        } catch {
            return initialSelection;
        }
    }

    private async extractSinglePagePdf(buffer: Buffer, pageNumber: number): Promise<Buffer> {
        const { PDFDocument } = await import("pdf-lib");
        const pdfDoc = await PDFDocument.load(buffer);
        const singlePageDoc = await PDFDocument.create();
        const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [pageNumber - 1]);
        singlePageDoc.addPage(copiedPage);
        return Buffer.from(await singlePageDoc.save());
    }

    private async queueStatementCandidates(
        emailRow: any,
        gmail: any,
        sourceInbox: string,
        vendorName: string,
    ): Promise<string[]> {
        const queuedIds: string[] = [];
        const msgId = emailRow.gmail_message_id;
        if (!msgId) return queuedIds;

        const fullMsg = await gmail.users.messages.get({
            userId: "me",
            id: msgId,
            format: "full",
        });

        const pdfParts: any[] = [];
        const walkParts = (parts: any[] = []) => {
            for (const part of parts) {
                if (
                    part.filename?.toLowerCase().endsWith(".pdf")
                    && part.body?.attachmentId
                ) {
                    pdfParts.push(part);
                }
                if (part.parts?.length) walkParts(part.parts);
            }
        };
        walkParts(fullMsg.data.payload?.parts || []);

        for (const part of pdfParts) {
            const response = await gmail.users.messages.attachments.get({
                userId: "me",
                messageId: msgId,
                id: part.body.attachmentId,
            });
            const attachmentData = response.data.data;
            if (!attachmentData) continue;

            const intakeId = await queueStatementEmailIntake({
                gmailMessageId: msgId,
                sourceInbox,
                vendorName,
                emailFrom: emailRow.from_email || "Unknown",
                emailSubject: emailRow.subject || "No Subject",
                filename: part.filename || "statement.pdf",
                contentType: "application/pdf",
                buffer: Buffer.from(attachmentData, "base64url"),
            });

            if (intakeId) queuedIds.push(intakeId);
        }

        if (queuedIds.length === 0) {
            const intakeId = await queueStatementMetadataOnly({
                gmailMessageId: msgId,
                sourceInbox,
                vendorName,
                emailFrom: emailRow.from_email || "Unknown",
                emailSubject: emailRow.subject || "No Subject",
            });
            if (intakeId) queuedIds.push(intakeId);
        }

        return queuedIds;
    }

    /**
     * Polls the Supabase email queue for unread AP emails, classifies them, and queues PDFs.
     */
    async identifyAndQueue() {
        console.log("🕵️‍♀️ [AP-Identifier] Scanning queue for new invoices...");
        try {
            const db = createClient();

            if (!db) {
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
            // Include emails that failed in ap_inbox_queue (ERROR_PROCESSING) — reset them for retry
            const { data: messages, error } = await db
                .from('email_inbox_queue')
                .select('*')
                .eq('processed_by_ap', false)
                .limit(15);

            if (error) throw error;

            if (!messages || messages.length === 0) {
                // No unprocessed emails — check if any need retry via ap_inbox_queue ERROR_PROCESSING
                const { data: retryMessages } = await db
                    .from('email_inbox_queue')
                    .select('id, gmail_message_id, from_email, source_inbox')
                    .eq('processed_by_ap', true)
                    .limit(10);

                if (retryMessages && retryMessages.length > 0) {
                    const msgIds = retryMessages.map((r: any) => r.gmail_message_id);
                    const { data: errorItems } = await db
                        .from('ap_inbox_queue')
                        .select('message_id, extracted_json, updated_at')
                        .in('message_id', msgIds)
                        .eq('status', 'ERROR_PROCESSING');

                    if (errorItems && errorItems.length > 0) {
                        const maxRetryAge = 3 * 3600000; // 3 hours — don't retry invoices stuck longer
                        const now = Date.now();
                        const retryIds = retryMessages
                            .filter((r: any) => {
                                const errorItem = errorItems.find((e: any) => e.message_id === r.gmail_message_id);
                                if (!errorItem) return false;
                                // Compute age of the ERROR_PROCESSING entry
                                const updatedAt = new Date(errorItem.updated_at).getTime();
                                const age = now - updatedAt;
                                if (age > maxRetryAge) {
                                    console.log(`   ⏭️ Not retrying ${r.gmail_message_id} — ERROR_PROCESSING for ${Math.round(age / 3600000)}h (max ${maxRetryAge / 3600000}h)`);
                                    return false; // too old, leave as permanent error
                                }
                                return true;
                            })
                            .map((r: any) => r.id);

                        if (retryIds.length > 0) {
                            await db
                                .from('email_inbox_queue')
                                .update({ processed_by_ap: false })
                                .in('id', retryIds);
                            console.log(`   🔄 Reset ${retryIds.length} emails for retry (had ERROR_PROCESSING in ap_inbox_queue)`);
                        }
                    }

                }
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

                // H1 FIX(2026-04-14): Lock moved to end-of-iteration in `finally` below.
                // Previously we set processed_by_ap=true at the START of the loop, which
                // meant any uncaught exception (or transient Gmail fetch failure) between
                // here and the ap_inbox_queue insert left the email marked "done" but
                // never queued downstream — an orphan. Now we default handled=true so
                // every explicit decision branch (blocklist, statement, human, queued)
                // preserves prior behavior, but uncaught errors set handled=false so the
                // next poll retries.
                let handled = true;
                try {

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
                    await this.logActivity(db, from, subject, "BLOCKED_SENDER",
                        `Blocked: ${blockedSender.label} — archived without forwarding`);
                    continue;
                }

                // ── VENDOR ROUTING (deterministic pre-LLM) ──────────────────
                // DECISION(2026-06-05): Match known vendor senders for autopay,
                // dropship, ignore, and amazon_order — runs BEFORE LLM call to
                // save API costs and ensure correctness for deterministic rules.
                const fromEmailMatch = from.match(/<([^>]+)>/);
                const fromEmail = fromEmailMatch ? fromEmailMatch[1] : from.trim();
                const fromName = from.replace(/<[^>]+>/, '').trim();
                const routingRule = matchVendorRouting(fromEmail, fromName, subject);
                if (routingRule) {
                    console.log(`     -> Vendor routing match: ${routingRule.label} (${routingRule.action})`);

                    // 'skip' is the current vendor-router action; 'ignore' kept as legacy alias
                                        if (routingRule.action === 'skip' || (routingRule.action as string) === 'ignore') {
                                            // Skip entirely — archive and mark read (not an invoice)
                                            try {
                                                await gmail.users.messages.modify({
                                                    userId: "me",
                                                    id: m.gmail_message_id,
                                                    requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                                                });
                                            } catch (e) { /* ignore */ }
                                            await this.logActivity(db, from, subject, "BLOCKED_SENDER",
                                                `Skipped: ${routingRule.label} — archived without forwarding`);
                                            console.log(`     ⏭️ Skipped (${routingRule.label})`);
                                            continue;
                                        }

                    if (routingRule.action === 'autopay') {
                        // Autopay / recurring — mark as read, do NOT forward to Bill.com
                        try {
                            await gmail.users.messages.modify({
                                userId: "me",
                                id: m.gmail_message_id,
                                requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                            });
                        } catch (e) { /* ignore */ }
                        await this.logActivity(db, from, subject, "BLOCKED_SENDER",
                            `${routingRule.label} — marked read, no Bill.com forward`);
                        console.log(`     ✅ Autopay: ${routingRule.label} — marked read, no forward`);
                        continue;
                    }

                    if (routingRule.action === 'dropship') {
                        // Dropship vendor — queue to ap_inbox_queue with dropship metadata,
                        // skip LLM classification. The AP Forwarder will handle Bill.com.
                        try {
                            await db.from("ap_inbox_queue").insert({
                                message_id: m.gmail_message_id,
                                email_from: from,
                                email_subject: subject,
                                intent: "INVOICE",
                                status: "PENDING_FORWARD",
                                source_inbox: sourceInbox,
                                extracted_json: {
                                    vendor_routing_action: "dropship",
                                    vendor_name: routingRule.label,
                                    source_gmail_message_id: m.gmail_message_id,
                                },
                            });
                            console.log(`     🚚 Dropship: ${routingRule.label} — queued for forward`);
                            await this.logActivity(db, from, subject, "DROPSHIP",
                                `${routingRule.label} — queued for Bill.com forward (dropship, no PO matching)`, {
                                    vendor_routing_action: "dropship",
                                    vendor_name: routingRule.label,
                                });
                            // FIX(2026-06-29): Archive source email immediately.
                            // Same rationale as INVOICE queueing — prevents double-forward
                            // from ap-local-forwarder.ts on subsequent cron ticks.
                            try {
                                await gmail.users.messages.modify({
                                    userId: "me",
                                    id: m.gmail_message_id,
                                    requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                                });
                            } catch (e) { /* ignore — non-critical */ }
                        } catch (e: any) {
                            console.error(`     ❌ Dropship queue failed: ${e.message}`);
                        }
                        continue;
                    }

                    if (routingRule.action === 'amazon_order') {
                        // Amazon orders — skip for now, let normal processing handle
                        console.log(`     📦 Amazon order: ${routingRule.label} — continuing normal flow`);
                        // Fall through to normal processing
                    }
                }

                // ── TAX DOCUMENT GUARD ─────────────────────────────────────
                // DECISION(2026-03-24): Tax documents must never be marked as read
                // or archived automatically. They require manual human handling.
                const isTaxRelated = /\btax(es)?\b|w-?9|1099|1040|sales tax|tax return|tax exemption/i.test(subject) ||
                                     /\btax(es)?\b|w-?9|1099|1040/i.test(snippet) ||
                                     (m.pdf_filenames || []).some((f: string) => /\btax(es)?\b|w-?9|1099|1040/i.test(f));
                
                if (isTaxRelated) {
                    console.log(`   ⚠️ TAX DOCUMENT: "${subject}". Leaving unread for human review.`);
                    await this.logActivity(db, from, subject, "TAX_DOCUMENT", 
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
                    await this.logActivity(db, from, subject, "BLOCKED_SUBJECT",
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
                    handled = false;
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
                const isFedExInvoice = this.isFedExInvoiceEmail(from, subject, snippet, pdfFilenames);

                let intent: string;
                if (hasInvoicePdf && !isNonInvoicePdf) {
                    // Override: PDF filename clearly indicates an invoice document
                    intent = "INVOICE";
                    console.log(`     -> Forced INVOICE (PDF filename match: ${pdfFilenames.join(', ')})`);
                } else if (isFedExInvoice && hasPdfAttachment && !isNonInvoicePdf) {
                    intent = "INVOICE";
                    console.log(`     -> Forced INVOICE (FedEx invoice pattern)`);
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
                    // DECISION(2026-03-24, refined 2026-05-05 KAIZEN #3):
                    // classifyEmailIntent() now internally honors nightshift pre-classification
                    // (conf ≥ 0.7 + known label) and skips the paid Sonnet call when present.
                    intent = await this.classifyEmailIntent(subject, from, snippet, m.gmail_message_id);
                    console.log(`     -> Classified as: ${intent}`);
                }

                if (intent === "ADVERTISEMENT") {
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                        });
                        await this.logActivity(db, from, subject, "ADVERTISEMENT", "Archived and marked read");
                    } catch (e) { /* ignore */ }
                    continue;
                }

                if (intent === "STATEMENT") {
                    // STATEMENT handling: queue for statement reconciliation, then label/archive
                    try {
                        const vendorName = this.inferStatementVendorName(from, subject);
                        const intakeIds = await this.queueStatementCandidates(m, gmail, sourceInbox, vendorName);
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: {
                                addLabelIds: [(await getLabels(sourceInbox)).statements],
                                removeLabelIds: ["INBOX", "UNREAD"]
                            }
                        });
                        await this.logActivity(
                            db,
                            from,
                            subject,
                            "STATEMENT",
                            "Queued for statement reconciliation, labeled as Statement, marked read",
                            {
                                reasonCode: "statement_intake_queued",
                                sourceInbox,
                                gmailMessageId: m.gmail_message_id,
                                vendorName,
                                intakeIds,
                            },
                        );
                    } catch (e) { /* ignore */ }
                    continue;
                }

                if (intent === "HUMAN_INTERACTION") {
                    const policy = getAPHumanInteractionPolicy(sourceInbox);
                    try {
                        await applyMessageLabelPolicy({
                            gmail,
                            gmailMessageId: m.gmail_message_id,
                            addLabels: policy.addLabels,
                            removeLabels: policy.removeLabels,
                        });
                    } catch (e) { /* ignore */ }
                    await this.logActivity(db, from, subject, intent, policy.activityNote, {
                        reasonCode: policy.reasonCode,
                        sourceInbox,
                        gmailMessageId: m.gmail_message_id,
                    });
                    continue;
                }

                // ── PAID INVOICE HANDLER ──────────────────────────────────────
                // DECISION(2026-03-16): Detect paid invoice confirmations, extract
                // vendor/invoice/amount via LLM, cross-reference with Finale POs,
                // and create a draft PO when no match is found.
                if (intent === "PAID_INVOICE") {
                    try {
                        await this.handlePaidInvoice(m, gmail, db, sourceInbox, getLabels);
                    } catch (err: any) {
                        console.error(`     ❌ PAID_INVOICE handler failed:`, err.message);
                        await this.logActivity(db, from, subject, "PAID_INVOICE", `Handler error: ${err.message}`);
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
                    await this.logActivity(db, from, subject, intent, policy.activityNote, {
                        reasonCode: policy.reasonCode,
                        sourceInbox,
                        gmailMessageId: m.gmail_message_id,
                    });
                    continue;
                }

                // ── INLINE INVOICE DETECTION ──────────────────────────────────
                // DECISION(2026-06-29): Vendors like Ed Zybura / Organic AG Products
                // send casual text-only emails with cost breakdowns (no PDF).
                // detectInlineInvoice catches them; the handler parses, finds the
                // correlating PO in Finale, generates a PDF, and forwards to Bill.com.
                // Must run BEFORE PDF collection — these emails have no PDF parts.
                const bodyText = m.body_text || snippet;
                if (intent === "INVOICE" && !hasPdfAttachment) {
                    const isInline = detectInlineInvoice(bodyText, false, subject);
                    if (isInline) {
                        console.log(`     🧾 Inline invoice detected (${from}) — routing to handler...`);
                        try {
                            const emailDate = m.internalDate
                                ? new Date(Number(m.internalDate)).toISOString().split("T")[0]
                                : new Date().toISOString().split("T")[0];

                            const result = await handleInlineInvoice({
                                gmail,
                                gmailMessageId: m.gmail_message_id,
                                from,
                                subject,
                                body: bodyText,
                                date: emailDate,
                            });

                            if (result.success) {
                                console.log(`     ✅ Inline invoice handled — forwarded as ${result.invoiceNumber} (PO ${result.poNumber || "N/A"})`);
                                await this.logActivity(db, from, subject, "INLINE_INVOICE",
                                    `Auto-generated PDF invoice ${result.invoiceNumber} from inline text. PO ${result.poNumber || "not found"}. Forwarded to Bill.com: ${result.forwardedMessageId}`,
                                    {
                                        reasonCode: "inline_invoice_handled",
                                        sourceInbox,
                                        gmailMessageId: m.gmail_message_id,
                                        poNumber: result.poNumber,
                                        invoiceNumber: result.invoiceNumber,
                                        totalAmount: result.totalAmount,
                                        forwardedMessageId: result.forwardedMessageId,
                                    }
                                );
                                // Archive the source email — handler already forwarded to Bill.com
                                try {
                                    await gmail.users.messages.modify({
                                        userId: "me",
                                        id: m.gmail_message_id,
                                        requestBody: { removeLabelIds: ["INBOX", "UNREAD"] },
                                    });
                                } catch (e) { /* ignore */ }
                            } else {
                                console.warn(`     ⚠️ Inline invoice handler failed: ${result.error}`);
                                await this.logActivity(db, from, subject, "INLINE_INVOICE_FAILED",
                                    `Handler error: ${result.error} — leaving unread for human review`,
                                    { reasonCode: "inline_invoice_failed", sourceInbox, gmailMessageId: m.gmail_message_id }
                                );
                            }
                        } catch (err: any) {
                            console.error(`     ❌ Inline invoice handler exception: ${err.message}`);
                            await this.logActivity(db, from, subject, "INLINE_INVOICE_ERROR",
                                `Unhandled error: ${err.message}`,
                                { reasonCode: "inline_invoice_exception", sourceInbox, gmailMessageId: m.gmail_message_id }
                            );
                        }
                        continue;
                    }
                }

                // --- INVOICE QUEUEING (ap inbox only) ---
                let processedAnyPDF = false;
                let manualReviewReason: string | null = null;

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
                const expectedForwardCount = pdfParts.length;

                let attachmentIndex = 0;
                for (const part of pdfParts) {
                    if (part.body?.attachmentId) {
                        try {
                            const capturedFilename = part.filename;
                            const uniqueMsgId = pdfParts.length > 1 ? `${m.gmail_message_id}_${attachmentIndex}` : m.gmail_message_id;

                            // ── Dedup Check 1: same message_id (same inbox re-scan) ──
                            const { data: existing } = await db
                                .from("ap_inbox_queue")
                                .select("id")
                                .eq("message_id", uniqueMsgId)
                                .maybeSingle();

                            if (existing) {
                                console.log(`     ⚠️ Already queued ${capturedFilename}, skipping...`);
                                processedAnyPDF = true;
                                attachmentIndex++;
                                continue;
                            }

                            // ── Dedup Check 2: cross-inbox duplicate ─────────────────
                            // DECISION(2026-03-19): Same invoice arrives on both ap and
                            // default inboxes with different gmail_message_ids. Match on
                            // (email_from, pdf_filename, email_subject) within 24h to
                            // prevent duplicate Bill.com forwards.
                            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                            const { data: crossInboxDup } = await db
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

                            // ── Dedup Check 3: PDF content hash ───────────────────
                            // Some vendors (e.g. Abel's ACE) send identical PDFs in
                            // separate emails with different subjects. Hash the actual
                            // bytes so truly identical invoices are never forwarded twice,
                            // regardless of filename or subject line.
                            const pdfHash = createHash("sha256").update(buffer).digest("hex");
                            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
                            const { data: hashDup } = await db
                                .from("ap_inbox_queue")
                                .select("id, email_subject")
                                .eq("email_from", from)
                                .eq("pdf_content_hash", pdfHash)
                                .gte("created_at", sevenDaysAgo)
                                .maybeSingle();
                            if (hashDup) {
                                console.log(`     ⚠️ PDF content duplicate: ${capturedFilename} (hash match with "${hashDup.email_subject}") — skipping`);
                                await this.logActivity(db, from, subject, "DUPLICATE_PDF_CONTENT",
                                    `PDF content hash duplicate: ${capturedFilename} matches prior entry "${hashDup.email_subject}" — not forwarded`, {
                                        reasonCode: "duplicate_pdf_content",
                                        sourceInbox,
                                        gmailMessageId: m.gmail_message_id,
                                        pdfFilename: capturedFilename,
                                        duplicateSubject: hashDup.email_subject,
                                    });
                                attachmentIndex++;
                                processedAnyPDF = true;
                                continue;
                            }

                            // ── PDF CONTENT SAFETY CHECK ──────────────────────────
                            // DECISION(2026-03-20): Before forwarding to Bill.com,
                            // scan the first ~2KB of PDF text for block patterns
                            // ("Do Not Pay", "This is not a bill", $0.00 balance).
                            // This catches Toyota/TICF-style invoices that slip past
                            // the sender blocklist via a different sender address.
                            let pdfTextPreview = '';
                            let extractedPdf: Awaited<ReturnType<typeof import("../../pdf/extractor")["extractPDF"]>> | null = null;
                            try {
                                const { extractPDF } = await import('../../pdf/extractor');
                                extractedPdf = await extractPDF(buffer);
                                pdfTextPreview = extractedPdf.rawText.slice(0, 2000);
                            } catch {
                                // PDF extraction failed — don't block, let it through
                                console.warn(`     ⚠️ PDF text extraction failed for ${capturedFilename} — skipping content check`);
                            }

                            if (pdfTextPreview) {
                                const blockedContent = PDF_BLOCK_PATTERNS.find(p => p.pattern.test(pdfTextPreview));
                                if (blockedContent) {
                                    console.log(`     🚫 PDF BLOCKED: ${capturedFilename} — ${blockedContent.reason}`);
                                    await this.logActivity(db, from, subject, "BLOCKED_PDF_CONTENT",
                                        `PDF blocked from Bill.com: ${blockedContent.reason} (${capturedFilename})`, {
                                            reasonCode: "blocked_pdf_content",
                                            sourceInbox,
                                            gmailMessageId: m.gmail_message_id,
                                            pdfFilename: capturedFilename,
                                            blockedReason: blockedContent.reason,
                                        });
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

                            let queueBuffer = buffer;
                            const queueMetadata: Record<string, unknown> = {};
                            if (extractedPdf) {
                                // KAIZEN(2026-07-22): Removed AAA Cooper forced-page-1 override.
                                // AAA Cooper page 1 is always a STATEMENT SUMMARY cover sheet
                                // (hits "statement" negative rule, scores ~-2). Page 2 is the
                                // actual invoice (hits "invoice_heading" + "amount_due", scores
                                // ~9). Forcing page 1 sent the cover sheet to Bill.com, which
                                // picked up the customer number instead of the PRO/BOL number.
                                // The page selector correctly identifies page 2 as the invoice.
                                const pageSelection = await this.selectPrimaryInvoicePageNumber(
                                    buffer,
                                    extractedPdf.pages,
                                    extractedPdf.metadata?.pageCount,
                                );

                                const multiPagePacket = (extractedPdf.metadata?.pageCount ?? 1) > 1;
                                const needsFedExOcrRetry = isFedExInvoice
                                    && multiPagePacket
                                    && extractedPdf.ocrStrategy === "pdf-parse"
                                    && pageSelection.confidence !== "strong";

                                if (needsFedExOcrRetry) {
                                    try {
                                        const { extractPDFWithLLM } = await import("../../pdf/extractor");
                                        const retriedExtraction = await extractPDFWithLLM(buffer);
                                        const retriedSelection = await this.selectPrimaryInvoicePageNumber(
                                            buffer,
                                            retriedExtraction.pages,
                                            retriedExtraction.metadata?.pageCount,
                                        );
                                        queueMetadata.invoice_page_ocr_retry_used = true;
                                        queueMetadata.invoice_page_ocr_retry_strategy = retriedExtraction.ocrStrategy ?? "unknown";
                                        extractedPdf = retriedExtraction;
                                        pageSelection = retriedSelection;
                                    } catch (retryErr: any) {
                                        queueMetadata.invoice_page_ocr_retry_used = true;
                                        queueMetadata.invoice_page_ocr_retry_error = retryErr.message;
                                    }
                                }

                                if (isFedExInvoice && multiPagePacket && pageSelection.confidence !== "strong") {
                                    manualReviewReason = `Ambiguous FedEx invoice packet (${capturedFilename}) - unable to isolate a single invoice page`;
                                    console.log(`     ⚠️ ${manualReviewReason}`);
                                    await this.logActivity(db, from, subject, "AMBIGUOUS_INVOICE_PACKET", manualReviewReason, {
                                        reasonCode: "ambiguous_invoice_packet",
                                        sourceInbox,
                                        gmailMessageId: m.gmail_message_id,
                                        pdfFilename: capturedFilename,
                                        invoicePageSelectionConfidence: pageSelection.confidence,
                                        invoicePageSelectionReason: pageSelection.reason,
                                        ocrRetryUsed: Boolean(queueMetadata.invoice_page_ocr_retry_used),
                                        ocrRetryStrategy: queueMetadata.invoice_page_ocr_retry_strategy ?? null,
                                    });
                                    attachmentIndex++;
                                    continue;
                                }

                                if (pageSelection.pageNumber) {
                                    try {
                                        queueBuffer = await this.extractSinglePagePdf(buffer, pageSelection.pageNumber);
                                        queueMetadata.selected_invoice_page = pageSelection.pageNumber;
                                        queueMetadata.invoice_page_selection_confidence = pageSelection.confidence;
                                        queueMetadata.invoice_page_selection_reason = pageSelection.reason;
                                        queueMetadata.forwarded_page_count = 1;
                                        console.log(`     ✂️ Trimmed ${capturedFilename} to invoice page ${pageSelection.pageNumber}`);
                                    } catch (pageErr: any) {
                                        console.warn(`     ⚠️ Failed to trim ${capturedFilename} to invoice page: ${pageErr.message}`);
                                    }
                                }
                            }

                            // Upload to local filesystem storage
                            const storagePath = `${m.gmail_message_id}/${Date.now()}_${capturedFilename}`;
                            const { uploadPDF } = await import("../../storage/supabase-storage");
                            const localPath = await uploadPDF(queueBuffer, {
                                type: "ap_invoices",
                                vendor: m.vendor_name || "unknown",
                                date: new Date().toISOString().split("T")[0],
                                filename: capturedFilename,
                            });

                            if (!localPath) {
                                throw new Error(`Local storage upload failed for ${storagePath}`);
                            }

                            // DECISION(2026-03-19): Queue directly as PENDING_FORWARD.
                            // Previously set to PENDING_EXTRACTION, but no extraction
                            // worker existed — invoices got stuck permanently. The PDF is
                            // already in Storage; the AP Forwarder downloads and sends it
                            // to Bill.com. Reconciliation happens independently afterwards.
                            // This matches the SOP: "forward immediately, reconcile later."
                            const queueStatus = 'PENDING_FORWARD';

                            const { error: insertError } = await db.from("ap_inbox_queue").insert({
                                message_id: uniqueMsgId,
                                email_from: from,
                                email_subject: subject,
                                intent: intent,
                                pdf_path: localPath,
                                pdf_filename: capturedFilename,
                                status: queueStatus,
                                source_inbox: sourceInbox,
                                pdf_content_hash: pdfHash,
                                extracted_json: {
                                    source_gmail_message_id: m.gmail_message_id,
                                    completion_mode: "forward_success",
                                    expected_forward_count: expectedForwardCount,
                                    pdf_attachment_index: attachmentIndex,
                                    pdf_attachment_count: expectedForwardCount,
                                    ...queueMetadata,
                                },
                            });

                            if (insertError) {
                                throw new Error(`Queue insert failed: ${insertError.message}`);
                            }

                            console.log(`     ✅ Queued ${capturedFilename} → ${queueStatus} (ready for Bill.com)`);
                            processedAnyPDF = true;
                            attachmentIndex++;

                        } catch (err: any) {
                            console.error(`     ❌ Failed to queue attachment:`, err.message);
                            await this.logActivity(db, from, subject, "PROCESSING_ERROR", `Queue failed: ${err.message}`, {
                                reasonCode: "queue_insert_failed",
                                sourceInbox,
                                gmailMessageId: m.gmail_message_id,
                            });
                        }
                    }
                }

                if (processedAnyPDF) {
                    const pdfNames = pdfParts.map((p: any) => p.filename).join(", ");
                    const logNote = `Queued for Bill.com forward (${pdfNames}); source email archived`;
                    await this.logActivity(db, from, subject, intent, logNote, {
                        reasonCode: "queued_for_billcom",
                        sourceInbox,
                        gmailMessageId: m.gmail_message_id,
                        attachments: pdfNames,
                        queueStatus: "PENDING_FORWARD",
                    });
                    // FIX(2026-06-29): Archive source email immediately after queuing.
                    // Previously we waited for send verification (ap-forwarder.ts), but
                    // the forwarder is rate-limited (10 items/run) and a second forwarder
                    // (ap-local-forwarder.ts) also scans Gmail for UNREAD emails. Leaving
                    // the email unread after queuing caused the local forwarder to find the
                    // same invoice on the next cron tick and forward it to Bill.com AGAIN.
                    // ap_inbox_queue is the canonical forwarding queue — no reason to keep
                    // the source email unread.
                    try {
                        await applyMessageLabelPolicy({
                            gmail,
                            gmailMessageId: m.gmail_message_id,
                            addLabels: ["Invoice Forward"],
                            removeLabels: ["INBOX", "UNREAD"],
                        });
                    } catch (e) {
                        // Non-critical — the local forwarder will pick up the slack in a
                        // worst case, but the queue dedup in ap_inbox_queue is the guard.
                        console.warn(`     ⚠️ Failed to archive source email after queuing: ${(e as Error).message}`);
                    }
                } else if (pdfParts.length === 0) {
                    console.log(`     ⚠️ No PDF found on ${intent}. Leaving unread for human check.`);
                    const policy = getAPMissingPdfPolicy(sourceInbox, intent);
                    await this.logActivity(db, from, subject, intent, policy.activityNote, {
                        reasonCode: policy.reasonCode,
                        sourceInbox,
                        gmailMessageId: m.gmail_message_id,
                    });
                    try {
                        await applyMessageLabelPolicy({
                            gmail,
                            gmailMessageId: m.gmail_message_id,
                            addLabels: policy.addLabels,
                            removeLabels: policy.removeLabels,
                        });
                    } catch (e) { /* ignore */ }
                } else {
                    const incompleteReason = manualReviewReason
                        ? `${manualReviewReason}; leaving unread in inbox`
                        : "Invoice PDFs detected but queueing was incomplete; leaving unread in inbox";
                    console.log(`     ⚠️ ${incompleteReason}`);
                    await this.logActivity(db, from, subject, intent, incompleteReason, {
                        reasonCode: manualReviewReason ? "manual_review_required" : "incomplete_queue",
                        sourceInbox,
                        gmailMessageId: m.gmail_message_id,
                        expectedForwardCount,
                    });
                }

                } catch (err: any) {
                    handled = false;
                    throw err;
                } finally {
                    await db.from('email_inbox_queue')
                        .update({ processed_by_ap: handled })
                        .eq('id', m.id);
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
            await db.from('paid_invoices').insert({
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
                const { data: existingPaid } = await db
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
                    const { data: recentDraft } = await db
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
                    // DECISION(2026-05-11): Route through approval gate instead
                    // of auto-creating in Finale. Will approves the queued task
                    // from /tasks; approval calls createDraftPurchaseOrder via
                    // createDraftPOTaskAfterApproval.
                    //
                    // Original DECISION(2026-03-16) on placeholder SKU still
                    // applies: real SKU correlation is complex — payload uses a
                    // single generic line item at the paid amount, and Will
                    // adds the correct SKU after approval.
                    const memo = [
                        `[Aria] From paid invoice confirmation`,
                        `Invoice: ${extracted.invoiceNumber}`,
                        `Amount: $${extracted.amountPaid.toFixed(2)}`,
                        `Date: ${extracted.datePaid}`,
                        extracted.productDescription ? `Product: ${extracted.productDescription}` : null,
                        `Source email: ${from}`,
                        `⚠️ REMINDER: Replace PLACEHOLDER-PAID-INVOICE with the correct vendor SKU before committing.`,
                    ].filter(Boolean).join('\n');

                    const sourceId = `paid_invoice:${extracted.invoiceNumber || extracted.datePaid}:${vendorPartyId}`;
                    const goal = `Draft PO — ${extracted.vendorName} ($${extracted.amountPaid.toFixed(2)})`;
                    const approval = await requestDraftPOApproval(
                        sourceId,
                        goal,
                        {
                            vendorPartyId,
                            items: [{
                                productId: 'PLACEHOLDER-PAID-INVOICE',
                                quantity: 1,
                                unitPrice: extracted.amountPaid,
                            }],
                            memo,
                        },
                    );

                    if (approval.taskId) {
                        draftInfo = { orderId: `pending:${approval.taskId.slice(0, 8)}`, finaleUrl: '' };
                        console.log(`     ⏸️ Draft PO queued for approval (task ${approval.taskId.slice(0, 8)})`);
                    } else {
                        console.warn(`     ⚠️ ${approval.message}`);
                    }
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
                await businessHoursAlert(this.bot, chatId, message, { parse_mode: "HTML" });
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

        await this.logActivity(db, from, subject, 'PAID_INVOICE', action, {
            invoiceNumber: extracted.invoiceNumber,
            amountPaid: extracted.amountPaid,
            vendorName: extracted.vendorName,
            matchedPO: matchedPO?.orderId || null,
            draftPO: draftInfo?.orderId || null,
            confidence: extracted.confidence,
        });
    }


    /** Escape HTML special characters for Telegram messages. */
    private escapeHtml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
}
