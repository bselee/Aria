import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { Telegraf, Markup } from "telegraf";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { unifiedObjectGeneration } from "./llm";
import { extractPDF } from "../pdf/extractor";
import { recall } from "./memory";
import { parseInvoice, InvoiceData } from "../pdf/invoice-parser";
// matchInvoiceToPO kept for manual re-match flow in start-bot.ts invoice_has_po_ handler
// but is no longer in the hot path — ap-agent queries Finale directly
import { FinaleClient } from "../finale/client";
import Fuse from "fuse.js";
import PDFDocument from "pdfkit";
import {
    reconcileInvoiceToPO,
    applyReconciliation,
    ReconciliationResult,
    storePendingApproval,
    updatePendingApprovalMessageId,
    buildAuditMetadata,
    buildReconciliationReport,
} from "../finale/reconciler";
import { recordFeedback } from "./feedback-loop";
import { upsertVendorInvoice } from "../storage/vendor-invoices";

/**
 * @file    ap-agent.ts
 * @purpose Dedicated agent for the ap@buildasoil.com inbox.
 *          Downloads attached PDF invoices, parses data, correlates with POs,
 *          and notifies the team of discrepancies or matching statuses.
 * @author  Antigravity / Aria
 * @updated 2026-03-18
 */

// ─── Vendor Routing Rules ────────────────────────────────────────────────────
// DECISION(2026-03-18): Deterministic routing for known vendor types.
// Runs BEFORE LLM classification to save API calls and ensure correctness.
// - 'autopay'       → vendor is on autopay or recurring subscription; mark read, no Bill.com forward
// - 'dropship'      → forward to Bill.com, mark read, skip PO matching/reconciliation
// - 'ignore'        → skip entirely (e.g., internal forwarded emails from Will's inbox)
// - 'amazon_order'  → route to Amazon order parser for tracking + Slack request matching
interface VendorRoutingRule {
    /** Match criteria — at least one must be provided */
    match: {
        domain?: string;          // e.g., 'wwex.com' — matches sender email domain
        fromExact?: string;       // e.g., 'bill.selee@buildasoil.com' — exact sender match
        senderContains?: string;  // e.g., 'logan labs' — case-insensitive substring in From header
    };
    action: 'autopay' | 'dropship' | 'ignore' | 'amazon_order';
    label: string;  // Human-readable label for logging
}

const VENDOR_ROUTING_RULES: VendorRoutingRule[] = [
    // ── Autopay / recurring (mark read, no Bill.com forward) ─────────────
    // WWEX / Worldwide Express
    { match: { domain: 'wwex.com' }, action: 'autopay', label: 'Worldwide Express (Autopay)' },
    // DECISION(2026-03-19): Recurring utility and software subscriptions.
    // Not forwarded to Bill.com at this time. Saves LLM classification calls.
    { match: { senderContains: 'pioneer propane' }, action: 'autopay', label: 'Pioneer Propane' },
    { match: { domain: 'gorgias.com' }, action: 'autopay', label: 'Gorgias' },
    { match: { senderContains: 'gorgias' }, action: 'autopay', label: 'Gorgias' },
    { match: { domain: 'google.com' }, action: 'autopay', label: 'Google' },
    { match: { senderContains: 'google workspace' }, action: 'autopay', label: 'Google Workspace' },
    { match: { senderContains: 'google cloud' }, action: 'autopay', label: 'Google Cloud' },

    // ── Amazon (route to order parser for tracking) ──────────────────────
    // DECISION(2026-03-19): Amazon order/shipping confirmation emails are
    // parsed for order #, items, tracking, and matched to pending Slack
    // requests so the requester can be notified when their order ships.
    { match: { senderContains: 'auto-confirm@amazon' }, action: 'amazon_order', label: 'Amazon Order Confirmation' },
    { match: { senderContains: 'ship-confirm@amazon' }, action: 'amazon_order', label: 'Amazon Shipping' },
    { match: { senderContains: 'shipment-tracking@amazon' }, action: 'amazon_order', label: 'Amazon Tracking' },
    { match: { senderContains: 'order-update@amazon' }, action: 'amazon_order', label: 'Amazon Order Update' },

    // ── Dropship vendors (forward to Bill.com, no PO matching) ──────────
    { match: { senderContains: 'logan labs' }, action: 'dropship', label: 'Logan Labs (Dropship)' },
    { match: { senderContains: 'autopot' }, action: 'dropship', label: 'AutoPot (Dropship)' },
    // NOTE: Bill.com has historically had trouble recognizing their PDF invoices.
    { match: { senderContains: 'evergreen growers' }, action: 'dropship', label: 'Evergreen Growers (Dropship)' },

    // ── Internal ignores ────────────────────────────────────────────────
    { match: { fromExact: 'bill.selee@buildasoil.com' }, action: 'ignore', label: 'Internal (bill.selee)' },
];
export class APAgent {
    private bot: Telegraf;
    private slack: WebClient | null;
    private slackChannel: string;

    constructor(bot: Telegraf) {
        this.bot = bot;
        const slackToken = process.env.SLACK_BOT_TOKEN;
        this.slack = slackToken ? new WebClient(slackToken) : null;
        this.slackChannel = process.env.SLACK_MORNING_CHANNEL || "#purchasing";
    }

    /**
     * Match a sender against the deterministic vendor routing rules.
     * Returns the first matching rule, or null if no rule matches.
     */
    private matchVendorRouting(fromHeader: string): VendorRoutingRule | null {
        const fromLower = fromHeader.toLowerCase();
        // Extract bare email from "Display Name <email@domain.com>" format
        const emailMatch = fromLower.match(/<([^>]+)>/);
        const bareEmail = emailMatch ? emailMatch[1] : fromLower.trim();
        const domain = bareEmail.split('@')[1] || '';

        for (const rule of VENDOR_ROUTING_RULES) {
            if (rule.match.domain && domain === rule.match.domain) return rule;
            if (rule.match.fromExact && bareEmail === rule.match.fromExact.toLowerCase()) return rule;
            if (rule.match.senderContains && fromLower.includes(rule.match.senderContains.toLowerCase())) return rule;
        }
        return null;
    }

    private decodeBase64(data: string): string {
        return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    }

    private extractEmailText(payload: any, snippet: string): string {
        let combinedText = snippet + "\n";
        if (payload?.body?.data) {
            combinedText += this.decodeBase64(payload.body.data) + "\n";
        }
        const walkParts = (parts: any[]) => {
            for (const part of parts) {
                if (part.mimeType === "text/plain" && part.body?.data) {
                    combinedText += this.decodeBase64(part.body.data) + "\n";
                }
                if (part.parts?.length) walkParts(part.parts);
            }
        };
        if (payload?.parts) walkParts(payload.parts);
        return combinedText;
    }

    private generatePDF(text: string, title: string = "Invoice Details"): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument();
            const buffers: Buffer[] = [];
            doc.on("data", buffers.push.bind(buffers));
            doc.on("end", () => resolve(Buffer.concat(buffers)));
            doc.on("error", reject);

            doc.fontSize(16).text(title, { underline: true });
            doc.moveDown();
            doc.fontSize(10).text(text);
            doc.end();
        });
    }

    private async classifyEmailIntent(subject: string, from: string, snippet: string): Promise<string> {
        // reasoning omitted — we only need the label, dropping it saves output tokens on every call
        const schema = z.object({
            intent: z.enum(["INVOICE", "PREPAYMENT_REQUIRED", "STATEMENT", "ADVERTISEMENT", "HUMAN_INTERACTION"]),
        });

        // Recall rules to see if this vendor has specific handling instructions
        const memories = await recall(`Accounts Payable routing rules for vendor ${from} subject ${subject} `, { topK: 3, minScore: 0.5 });
        let memoryContext = "";
        if (memories.length > 0) {
            memoryContext = "\n\nPast Experiences & Specific Vendor Rules:\n" + memories.map(m => `- [${m.category}] ${m.content} `).join("\n");
        }

        const prompt = `Classify this AP inbox email.Reply with the single intent label only.
    From: ${from}
Subject: ${subject}
Snippet: ${snippet}
${memoryContext}

INVOICE - Standard vendor bill (may or may not have a PO).
        PREPAYMENT_REQUIRED - Proforma invoice or payment link indicating order will ship AFTER payment.
        STATEMENT - Account statement or aging summary.
            ADVERTISEMENT - Marketing, spam, or newsletter.
                HUMAN_INTERACTION - Payment question, order issue, or anything requiring a human reply.`;

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

    /**
     * Polls the ap@buildasoil.com inbox for unread emails and processes them based on intent.
     */
    async processUnreadInvoices() {
        console.log("🕵️‍♀️ [AP-Agent] Scanning ap@buildasoil.com for new invoices...");
        try {
            // "ap" designates the target token path (token-ap.json)
            let auth;
            try {
                auth = await getAuthenticatedClient("ap");
            } catch (err: any) {
                console.warn("   ⚠️ Missing 'ap' token, falling back to 'default' token...");
                auth = await getAuthenticatedClient("default");
            }
            const gmail = GmailApi({ version: "v1", auth });
            const supabase = createClient();

            // Find *ALL* unread emails in the inbox that haven't been marked as seen by the AP Agent.
            // Exclude bill.selee@buildasoil.com at the query level — ap@ is now the active inbox.
            const { data } = await gmail.users.messages.list({
                userId: "me",
                q: "is:unread in:inbox -from:bill.selee@buildasoil.com newer_than:3d",
                maxResults: 15
            });

            const messages = data.messages || [];
            if (messages.length === 0) {
                console.log("   No new actionable emails found.");
                return;
            }

            console.log(`   Found ${messages.length} unread email(s) in inbox.`);

            // Pre-fetch labels to optimize
            const invoiceFwdLabelId = await this.getOrCreateLabel(gmail, "Invoice Forward");
            const statementsLabelId = await this.getOrCreateLabel(gmail, "Statements");

            for (const m of messages) {
                let msg: any;
                try {
                    msg = await gmail.users.messages.get({ userId: "me", id: m.id! });
                } catch (fetchErr: any) {
                    const isQuota = fetchErr.code === 429 ||
                        String(fetchErr.message).toLowerCase().includes("quota") ||
                        String(fetchErr.message).toLowerCase().includes("ratelimit");
                    if (isQuota) {
                        console.warn("   ⚠️ Gmail API rate limit hit — stopping batch early.");
                        try {
                            await this.bot.telegram.sendMessage(
                                process.env.TELEGRAM_CHAT_ID || "",
                                `⚠️ Gmail API rate limit hit — AP inbox poll interrupted.Some emails may not have been processed.Will retry on next cycle.`
                            );
                        } catch { /* swallow */ }
                        break;
                    }
                    console.error(`   ❌ Failed to fetch message ${m.id}: `, fetchErr.message);
                    continue;
                }
                const payload = msg.data.payload;
                const headers = payload?.headers || [];

                const subject = headers.find((h: any) => h.name === "Subject")?.value || "No Subject";
                const from = headers.find((h: any) => h.name === "From")?.value || "Unknown Sender";
                const snippet = msg.data.snippet || "";

                console.log(`   Evaluating Email: "${subject}" from ${from} `);

                // ── Pre-classification: Deterministic vendor routing ──────────────
                // Known vendors are routed without burning an LLM call.
                const routingRule = this.matchVendorRouting(from);
                if (routingRule) {
                    console.log(`     -> Vendor routing match: ${routingRule.label} (${routingRule.action})`);

                    if (routingRule.action === 'ignore') {
                        // Skip entirely — archive and mark read so we don't scan again
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.id!,
                            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                        });
                        console.log(`     ⏭️ Ignored (${routingRule.label})`);
                        continue;
                    }

                    if (routingRule.action === 'autopay') {
                        // Autopay / recurring — mark as read, do NOT forward to Bill.com
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.id!,
                            requestBody: {
                                removeLabelIds: ["INBOX", "UNREAD"]
                            }
                        });
                        await this.logActivity(supabase, from, subject, "AUTOPAY",
                            `${routingRule.label} — marked read, no Bill.com forward`);
                        console.log(`     ✅ Autopay: ${routingRule.label} — marked read, no forward`);
                        continue;
                    }

                    if (routingRule.action === 'amazon_order') {
                        // DECISION(2026-03-19): Amazon emails are routed to a dedicated
                        // parser that extracts order data and matches to Slack requests.
                        // Mark as read but do NOT archive — Will may want to reference.
                        try {
                            const { AmazonOrderParser } = await import('./workers/amazon-order-parser');
                            const parser = new AmazonOrderParser();
                            const emailText = this.extractEmailText(payload, snippet);
                            await parser.processEmail({
                                gmailMessageId: m.id!,
                                from,
                                subject,
                                bodyText: emailText,
                                type: routingRule.label,
                            });
                            // Mark as read only (keep in inbox for Will's reference)
                            await gmail.users.messages.modify({
                                userId: "me",
                                id: m.id!,
                                requestBody: { removeLabelIds: ["UNREAD"] }
                            });
                            await this.logActivity(supabase, from, subject, "AMAZON_ORDER",
                                `${routingRule.label} — parsed and processed`);
                            console.log(`     📦 Amazon: ${routingRule.label} — parsed`);
                        } catch (err: any) {
                            console.error(`     ❌ Amazon parser failed:`, err.message);
                            await this.logActivity(supabase, from, subject, "AMAZON_ORDER",
                                `${routingRule.label} — parser error: ${err.message}`);
                        }
                        continue;
                    }

                    if (routingRule.action === 'dropship') {
                        // Dropship vendor — forward PDFs to Bill.com, mark read, skip PO matching
                        let forwardedAny = false;
                        const pdfPartsDropship: any[] = [];
                        function walkPartsDropship(parts: any[]): void {
                            for (const part of parts) {
                                if (part.mimeType === "application/pdf" && part.filename) {
                                    pdfPartsDropship.push(part);
                                }
                                if (part.parts?.length) walkPartsDropship(part.parts);
                            }
                        }
                        walkPartsDropship(payload?.parts || []);

                        for (const part of pdfPartsDropship) {
                            if (part.body?.attachmentId) {
                                console.log(`     📎 Downloading ${part.filename} for dropship forward...`);
                                const attachment = await gmail.users.messages.attachments.get({
                                    userId: "me",
                                    messageId: m.id!,
                                    id: part.body.attachmentId
                                });
                                const base64Data = attachment.data.data;
                                if (base64Data) {
                                    const forwarded = await this.forwardToBillCom(gmail, subject, part.filename!, base64Data);
                                    if (forwarded) forwardedAny = true;
                                    console.log(`     ${forwarded ? '✅' : '❌'} Bill.com forward: ${part.filename}`);

                                    // Archive into vendor_invoices (non-blocking, best-effort)
                                    try {
                                        await upsertVendorInvoice({
                                            vendor_name: routingRule.label.replace(/ \(.*\)$/, ''),
                                            invoice_number: null,
                                            invoice_date: new Date().toISOString().split('T')[0],
                                            po_number: null,
                                            subtotal: 0,
                                            freight: 0,
                                            tax: 0,
                                            total: 0,
                                            status: 'received',
                                            source: 'email_dropship',
                                            source_ref: m.id!,
                                        });
                                    } catch { /* dedup or non-critical */ }
                                }
                            }
                        }

                        // If no PDFs found, still try to forward the email body as a generated PDF
                        if (!forwardedAny && pdfPartsDropship.length === 0) {
                            const emailText = this.extractEmailText(payload, snippet);
                            if (emailText.length > 100) {
                                console.log(`     📄 No PDF — generating fallback from email body...`);
                                try {
                                    const pdfBuf = await this.generatePDF(emailText, `Dropship Invoice — ${routingRule.label}`);
                                    const pdfBase64 = pdfBuf.toString('base64');
                                    const fakeFilename = `dropship_${routingRule.label.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.pdf`;
                                    const forwarded = await this.forwardToBillCom(gmail, subject, fakeFilename, pdfBase64);
                                    if (forwarded) forwardedAny = true;
                                    console.log(`     ${forwarded ? '✅' : '❌'} Bill.com forward (generated PDF)`);
                                } catch (genErr: any) {
                                    console.error(`     ❌ Fallback PDF generation failed: ${genErr.message}`);
                                }
                            }
                        }

                        // Mark as read
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.id!,
                            requestBody: {
                                addLabelIds: [invoiceFwdLabelId],
                                removeLabelIds: ["INBOX", "UNREAD"]
                            }
                        });
                        const pdfNames = pdfPartsDropship.map((p: any) => p.filename).join(", ") || 'generated PDF';
                        await this.logActivity(supabase, from, subject, "DROPSHIP",
                            `${routingRule.label} — forwarded to Bill.com (${pdfNames}), no PO matching`,
                            { attachments: pdfNames, dropship: true, vendor: routingRule.label });
                        console.log(`     ✅ Dropship complete: forwarded, marked read, no PO matching`);
                        continue;
                    }
                }

                // ── Standard LLM classification (no vendor routing match) ─────────
                const intent = await this.classifyEmailIntent(subject, from, snippet);
                console.log(`     -> Classified as: ${intent} `);

                // Kaizen: record classification prediction (Pillar 3 — Prediction Accuracy)
                recordFeedback({
                    category: "prediction",
                    eventType: "email_classification",
                    agentSource: "ap_agent",
                    subjectType: "message",
                    subjectId: m.id!,
                    prediction: { intent, from: from.slice(0, 100), subject: subject.slice(0, 100) },
                    accuracyScore: 1.0, // assume correct until corrected
                    contextData: {},
                }).catch(() => { /* non-blocking */ });

                if (intent === "ADVERTISEMENT") {
                    // Mark as read and REMOVE from inbox (archive)
                    await gmail.users.messages.modify({
                        userId: "me",
                        id: m.id!,
                        requestBody: {
                            removeLabelIds: ["INBOX", "UNREAD"]
                        }
                    });
                    await this.logActivity(supabase, from, subject, "ADVERTISEMENT", "Archived and marked read");
                    continue;
                }

                if (intent === "STATEMENT") {
                    // Mark as read and label as Statements but leave in inbox
                    await gmail.users.messages.modify({
                        userId: "me",
                        id: m.id!,
                        requestBody: {
                            addLabelIds: [statementsLabelId],
                            removeLabelIds: ["INBOX", "UNREAD"]
                        }
                    });
                    await this.logActivity(supabase, from, subject, "STATEMENT", "Labeled as Statement, marked read");
                    continue;
                }

                if (intent === "HUMAN_INTERACTION") {
                    // We archive it and mark it read to ensure the pipeline isn't stalled and humans are alerted appropriately
                    await gmail.users.messages.modify({
                        userId: "me",
                        id: m.id!,
                        requestBody: {
                            removeLabelIds: ["INBOX", "UNREAD"]
                        }
                    });
                    // Do not logActivity to avoid dashboard clutter
                    continue;
                }

                if (intent === "PREPAYMENT_REQUIRED") {
                    console.log(`     ⚠️ Prepayment required. Alerting team.`);
                    const emailText = this.extractEmailText(payload, snippet);
                    const urls = emailText.match(/\bhttps?:\/\/[^\s"'<>()]+/gi) || [];
                    let urlSnippets = "";
                    if (urls.length > 0) {
                        urlSnippets = `\n\n*Possible Links:*\n` + urls.slice(0, 3).join("\n");
                    }

                    const warnMsg = `🚨 *Prepayment Required*\n*From:* ${from}\n*Subject:* _${subject}_\n\nThis vendor requires prepayment before shipping. Please review this email, click any payment links, or pay via credit card.${urlSnippets}`;
                    try {
                        await this.bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID || "", warnMsg, { parse_mode: "Markdown" });
                        if (this.slack) {
                            await this.slack.chat.postMessage({ channel: this.slackChannel, text: warnMsg.replace(/\*/g, "*"), mrkdwn: true });
                        }
                    } catch { /* swallow */ }
                    
                    // Archive and mark read, team was alerted via Telegram
                    await gmail.users.messages.modify({
                        userId: "me",
                        id: m.id!,
                        requestBody: {
                            removeLabelIds: ["INBOX", "UNREAD"]
                        }
                    });
                    await this.logActivity(supabase, from, subject, "PREPAYMENT", "Alerted team for manual prepayment.");
                    continue;
                }

                // --- INVOICE PROCESSING ---
                let processedAnyPDF = false;
                // Recursive part walker: vendors using Outlook/Gmail sometimes nest
                // PDFs under multipart/mixed → multipart/related → attachment.
                // A flat .parts scan misses these.
                const pdfParts: any[] = [];
                function walkParts(parts: any[]): void {
                    for (const part of parts) {
                        if (part.mimeType === "application/pdf" && part.filename) {
                            pdfParts.push(part);
                        }
                        if (part.parts?.length) {
                            walkParts(part.parts);
                        }
                    }
                }
                walkParts(payload?.parts || []);

                for (const part of pdfParts) {
                    if (part.body?.attachmentId) {
                        // Idempotency check — skip if this Gmail message was already processed
                        // Prevents double-forwarding to Bill.com on crash + re-poll scenarios
                        if (supabase) {
                            const { data: existing } = await supabase
                                .from("documents")
                                .select("id")
                                .eq("gmail_message_id", m.id!)
                                .limit(1)
                                .single();
                            if (existing) {
                                console.log(`   ⏭️ Skipping already - processed message ${m.id} (${part.filename})`);
                                processedAnyPDF = true; // treat as processed so we mark read + label
                                continue;
                            }
                        }

                        console.log(`     Downloading ${part.filename} `);

                        const attachment = await gmail.users.messages.attachments.get({
                            userId: "me",
                            messageId: m.id!,
                            id: part.body.attachmentId
                        });

                        const base64Data = attachment.data.data;
                        if (base64Data) {
                            processedAnyPDF = true;

                            // 1. Upload PDF to Supabase Storage BEFORE forwarding
                            const buffer = Buffer.from(base64Data, "base64");
                            let pdfStoragePath: string | null = null;
                            if (supabase) {
                                try {
                                    const safeFilename = m.id + "-" + part.filename!.replace(/[^a-zA-Z0-9.-]/g, "_");
                                    const { data: uploadData, error: uploadErr } = await supabase.storage.from("vendor_invoices").upload(safeFilename, buffer, {
                                        contentType: "application/pdf",
                                        upsert: true
                                    });
                                    if (!uploadErr && uploadData) {
                                        pdfStoragePath = uploadData.path;
                                        console.log(`     ✅ PDF safely archived prior to Bill.com forward (${pdfStoragePath})`);
                                    } else {
                                        console.warn(`     ⚠️ PDF Storage upload failed:`, uploadErr?.message || 'Unknown error');
                                    }
                                } catch (e: any) {
                                    console.warn(`     ⚠️ PDF Storage archival error:`, e.message);
                                }
                            }

                            // 2. Forward strictly to buildasoilap@bill.com IMMEDIATELY
                            // This ensures Bill.com gets the invoice perfectly regardless of our PO matching logic
                            const forwarded = await this.forwardToBillCom(gmail, subject, part.filename!, base64Data);
                            if (!forwarded) {
                                // Critical: Bill.com never received the invoice — alert Will immediately
                                try {
                                    await this.bot.telegram.sendMessage(
                                        process.env.TELEGRAM_CHAT_ID || "",
                                        `🚨 * BILL\\.COM FORWARD FAILED *\nFile: \`${part.filename!}\`\nSubject: _${subject}_\nFrom: ${from}\n\n⚠️ Invoice was NOT received by Bill\\.com\\. Please forward manually\\.`,
                                        { parse_mode: "MarkdownV2" }
                                    );
                                } catch { /* swallow — can't alert about the alert failure */ }
                            }

                            // 3. Process Database & Extraction matching in the background
                            // We do this non-blocking so it doesn't hold up the pipeline if it fails
                            const capturedFilename = part.filename!;
                            const capturedMessageId = m.id!;
                            this.processInvoiceBuffer(buffer, capturedFilename, subject, from, supabase, false, capturedMessageId, pdfStoragePath).catch(async (err) => {
                                console.error(`     ❌ Background processing failed for ${capturedFilename}:`, err);
                                try {
                                    await this.bot.telegram.sendMessage(
                                        process.env.TELEGRAM_CHAT_ID || "",
                                        `⚠️ *Invoice processing failed — manual review needed*\nFile: \`${capturedFilename}\`\nFrom: ${from}\nSubject: _${subject.substring(0, 80)}_\n\nError: ${err.message}\n\nForwarded to Bill\.com ${forwarded ? "✓" : "✗"} \| Finale reconciliation ✗`,
                                        { parse_mode: "MarkdownV2" }
                                    );
                                } catch { /* swallow */ }
                                // Best-effort Supabase log for the background failure
                                try {
                                    await supabase?.from("ap_activity_log").insert({
                                        email_from: from,
                                        email_subject: subject,
                                        intent: "PROCESSING_ERROR",
                                        action_taken: `Background processing failed: ${err.message}`,
                                        metadata: { filename: capturedFilename, error: err.message, billComForwarded: forwarded },
                                    });
                                } catch { /* swallow */ }
                            });
                        }
                    }
                }

                // If intent was invoice but we successfully downloaded a PDF, label as Forwarded and mark read
                if (processedAnyPDF) {
                    await gmail.users.messages.modify({
                        userId: "me",
                        id: m.id!,
                        requestBody: {
                            addLabelIds: [invoiceFwdLabelId],
                            removeLabelIds: ["INBOX", "UNREAD"]
                        }
                    });
                    const pdfNames = pdfParts.map((p: any) => p.filename).join(", ");
                    await this.logActivity(supabase, from, subject, "INVOICE", `Forwarded to Bill.com (${pdfNames})`, { attachments: pdfNames });
                } else {
                    console.log(`     ⚠️ No PDF found on INVOICE. Checking for inline links...`);
                    const emailText = this.extractEmailText(payload, snippet);
                    const urls = emailText.match(/\bhttps?:\/\/[^\s"'<>()]+/gi) || [];
                    let scrapedContent = "";
                    let hasScraped = false;
                    
                    if (urls.length > 0) {
                        const invoiceUrl = urls.find(u => u.toLowerCase().includes('invoice') || u.toLowerCase().includes('pay') || u.toLowerCase().includes('bill'));
                        if (invoiceUrl && process.env.FIRECRAWL_API_KEY) {
                            console.log(`     🔗 Found likely invoice URL: ${invoiceUrl}. Attempting to scrape with Firecrawl...`);
                            try {
                                const dev = await import("@mendable/firecrawl-js");
                                const app = new dev.default({ apiKey: process.env.FIRECRAWL_API_KEY });
                                const scrapeResult = await app.scrapeUrl(invoiceUrl, { formats: ['markdown'] }) as any;
                                if (scrapeResult.success && scrapeResult.markdown) {
                                    scrapedContent = scrapeResult.markdown;
                                    console.log(`     📄 Successfully scraped inline invoice link.`);
                                    hasScraped = true;
                                }
                            } catch (err: any) {
                                console.error(`     ❌ Firecrawl scraping failed: ${err.message}`);
                            }
                        }
                    }

                    if (hasScraped || (emailText.length > 150 && emailText.toLowerCase().includes("total"))) {
                        console.log(`     📄 Generating fallback PDF from ${hasScraped ? 'scraped URL' : 'email body'}...`);
                        try {
                            const pdfBuf = await this.generatePDF(hasScraped ? scrapedContent! : emailText, hasScraped ? "Scraped Invoice Link" : "Inline Email Invoice");
                            
                            // Let's pass it to processInvoiceBuffer so it can be parsed and forwarded
                            // We give it a fake name
                            const filename = `generated_invoice_${Date.now()}.pdf`;
                            await this.processInvoiceBuffer(pdfBuf, filename, subject, from, supabase, false, m.id!);
                            
                            // Label it so it's not scanned again and remove UNREAD
                            await gmail.users.messages.modify({
                                userId: "me",
                                id: m.id!,
                                requestBody: {
                                    addLabelIds: [invoiceFwdLabelId],
                                    removeLabelIds: ["INBOX", "UNREAD"]
                                }
                            });
                            await this.logActivity(supabase, from, subject, "INVOICE", "Generated PDF from inline data", { attachments: filename, inline: true });
                        } catch (err: any) {
                            console.error(`     ❌ Failed to process inline invoice: ${err.message}`);
                        }
                    } else {
                        // Archive and mark read to keep inbox clean, relies on Supabase logging for tracking
                        console.log(`     ⚠️ No clear inline invoice or link found. Archiving and marking read for exception review.`);
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.id!,
                            requestBody: {
                                removeLabelIds: ["INBOX", "UNREAD"]
                            }
                        });
                        // Do not logActivity to avoid dashboard clutter
                    }
                }
            }

        } catch (err: any) {
            console.error("❌ [AP-Agent] Error processing AP Inbox:", err.message);
        }
    }

    public async forwardToBillCom(gmail: any, originalSubject: string, filename: string, base64Data: string): Promise<boolean> {
        console.log(`     -> Forwarding ${filename} to buildasoilap@bill.com`);
        const boundary = "b_aria_forwarded_bill_" + Math.random().toString(36).substring(2);

        // Convert Gmail's base64url to standard base64 and wrap at 76 chars per RFC 2045
        const standardBase64 = base64Data.replace(/-/g, "+").replace(/_/g, "/");
        const chunkedBase64 = standardBase64.match(/.{1,76}/g)?.join("\r\n") || standardBase64;

        const mimeMessage = [
            `To: buildasoilap@bill.com`,
            `Subject: Fwd: ${originalSubject}`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            ``,
            `--${boundary}`,
            `Content-Type: text/plain; charset="UTF-8"`,
            ``,
            `Forwarded invoice.`,
            ``,
            `--${boundary}`,
            `Content-Type: application/pdf; name="${filename}"`,
            `Content-Transfer-Encoding: base64`,
            `Content-Disposition: attachment; filename="${filename}"`,
            ``,
            chunkedBase64,
            `--${boundary}--`
        ].join("\r\n");

        try {
            await gmail.users.messages.send({
                userId: "me",
                requestBody: {
                    raw: Buffer.from(mimeMessage).toString("base64url")
                }
            });
            return true;
        } catch (err: any) {
            console.error("     ❌ Failed to forward to bill.com:", err.message);
            return false;
        }
    }

    public async processInvoiceBuffer(buffer: Buffer, filename: string, subject: string, from: string, supabase: any, _unused = false, messageId?: string, pdfStoragePath: string | null = null) {
        try {
            // 1. Extract + parse
            const extracted = await extractPDF(buffer);
            const invoiceData: InvoiceData = await parseInvoice(extracted.rawText);

            // 1a. Vendor Alias Resolution (Tier 2 update)
            invoiceData.vendorName = await this.resolveVendorAlias(supabase, invoiceData.vendorName);

            // 1b. Vendor pattern check — consult stored handling rules before proceeding.
            // Non-blocking: if Pinecone is down, processing continues normally.
            setImmediate(async () => {
                try {
                    const { getVendorPattern } = await import("./vendor-memory");
                    const pattern = await getVendorPattern(invoiceData.vendorName);
                    if (pattern?.invoiceBehavior === "multi_page_split") {
                        console.warn(`⚠️ [vendor-memory] ${invoiceData.vendorName} requires multi_page_split — forwarded as single file`);
                        const chatId = process.env.TELEGRAM_CHAT_ID || "";
                        await this.bot.telegram.sendMessage(chatId,
                            `⚠️ *Vendor pattern: multi-page split required*\n` +
                            `Vendor: ${invoiceData.vendorName}\nFile: \`${filename}\`\n` +
                            `_${pattern.handlingRule}_\n\n` +
                            `PDF was forwarded as-is to Bill.com — please split manually if this is a multi-invoice bundle.`,
                            { parse_mode: "Markdown" }
                        ).catch(() => { });
                    }
                } catch {
                    // Non-fatal — vendor memory is advisory only
                }
            });

            // 1c. Low-confidence guard — garbled PDF, skip reconciliation entirely
            if (invoiceData.confidence === "low") {
                console.warn(`     ⚠️ Low-confidence parse for ${filename} — alerting Will.`);
                // C2 FIX: Persist the document even on OCR failure so it's never silently lost.
                // Without this, the email sits unread with zero audit trail in `documents`.
                try {
                    await supabase.from("documents").insert({
                        type: "invoice",
                        status: "ocr_failed",
                        source: "email",
                        source_ref: from,
                        email_from: from,
                        email_subject: subject,
                        raw_text: extracted.rawText,
                        action_required: true,
                        action_summary: `OCR low-confidence for ${filename} from ${from}`,
                        gmail_message_id: messageId || null,
                        ocr_strategy: extracted.ocrStrategy || null,
                        ocr_duration_ms: extracted.ocrDurationMs || null,
                    });
                } catch { /* best-effort — Telegram alert is the primary signal */ }
                const chatId = process.env.TELEGRAM_CHAT_ID || "";
                await this.bot.telegram.sendMessage(chatId,
                    `⚠️ *Low-confidence invoice parse*\nFile: \`${filename}\`\nVendor: ${invoiceData.vendorName}\nForwarded to Bill.com but no Finale reconciliation attempted. Please review manually.`,
                    { parse_mode: "Markdown" }
                );
                await this.logActivity(supabase, from, subject, "INVOICE", `Low-confidence parse — reconciliation skipped for ${filename}`);
                return;
            }

            // 1c. Zero-line-item guard — possible OCR failure on scanned/corrupted PDF
            if (!invoiceData.lineItems || invoiceData.lineItems.length === 0) {
                // C2 FIX: Persist the document so zero-line-item failures have an audit trail.
                try {
                    await supabase.from("documents").insert({
                        type: "invoice",
                        status: "ocr_failed",
                        source: "email",
                        source_ref: from,
                        email_from: from,
                        email_subject: subject,
                        raw_text: extracted.rawText,
                        action_required: true,
                        action_summary: `0 line items extracted for ${filename} — OCR failure`,
                        gmail_message_id: messageId || null,
                        ocr_strategy: extracted.ocrStrategy || null,
                        ocr_duration_ms: extracted.ocrDurationMs || null,
                    });
                } catch { /* best-effort */ }
                const warnMsg = `⚠️ *Invoice parsed with 0 line items — possible OCR failure*\nVendor: ${invoiceData.vendorName}\nInvoice: #${invoiceData.invoiceNumber}\nFile: \`${filename}\`\nForwarded to Bill.com. Finale reconciliation skipped — please review manually.`;
                try { await this.bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID || "", warnMsg, { parse_mode: "Markdown" }); } catch { }
                await this.logActivity(supabase, from, subject, "PROCESSING_ERROR",
                    `Invoice parsed with 0 line items — possible OCR failure (${filename})`,
                    { invoiceNumber: invoiceData.invoiceNumber, vendorName: invoiceData.vendorName, filename }
                );
                return;
            }

            // 2. Find matching PO — Finale direct, no Supabase middle layer
            // If invoice has a PO# printed on it, use it. Otherwise query Finale by
            // vendor name + invoice date to find the most plausible open PO.
            let finalePONumber: string | null = invoiceData.poNumber || null;
            let matchSource = "PO# on invoice";
            let forceApproval = false;

            // Subject-line PO is stored as a last-resort fallback only.
            // Vendor invoice references (e.g., "B123402") are often THEIR internal PO,
            // not BuildASoil's Finale PO. Only use it if no other candidates resolve.
            const subjectPoMatch = subject.match(/\bPO\s*#?\s*([A-Za-z]?\d{5,})/i);
            const subjectPoFallback = subjectPoMatch ? subjectPoMatch[1] : null;
            if (subjectPoFallback && !finalePONumber) {
                finalePONumber = subjectPoFallback;
                matchSource = "PO# from email subject (no OCR PO found) — REQUIRES APPROVAL";
                forceApproval = true; // Subject-line PO is unverified — require human confirmation
            }

            // If invoice printed multiple PO numbers (e.g., "B7732 B123402"), resolve
            // to the first token that exists in Finale.
            // Also try Finale's B(NNNN) parenthesized format — vendors often omit parens
            // on their invoices (e.g., "B123402" → Finale ID "B(123402)").
            // Single FinaleClient reused across both PO-resolution phases below
            const probeClient = new FinaleClient();

            if (finalePONumber) {
                const tokens = finalePONumber.includes(" ")
                    ? finalePONumber.split(/\s+/).filter(Boolean)
                    : [finalePONumber];
                const candidates: string[] = [];
                for (const t of tokens) {
                    candidates.push(t);
                    // Try Finale's parenthesized format: "B123402" → "B(123402)"
                    const withParens = t.replace(/^([A-Za-z]+)(\d+)$/, "$1($2)");
                    if (withParens !== t) candidates.push(withParens);
                    // Try just the numeric part and parens-only variant
                    const digitsOnly = t.replace(/^[A-Za-z]+/, "");
                    if (digitsOnly && digitsOnly !== t) {
                        candidates.push(digitsOnly);
                        candidates.push(`(${digitsOnly})`);
                        // OCR commonly transposes adjacent digit pairs. Add all single-swap variants.
                        for (let i = 0; i < digitsOnly.length - 1; i++) {
                            const arr = digitsOnly.split("");
                            [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
                            const swapped = arr.join("");
                            if (swapped !== digitsOnly) candidates.push(swapped);
                        }
                    }
                }
                if (candidates.length > 1) {
                    // Pass 1: collect all valid candidates
                    const validCandidates: string[] = [];
                    for (const candidate of candidates) {
                        try {
                            await probeClient.getOrderDetails(candidate);
                            validCandidates.push(candidate);
                        } catch {
                            // not found — try next
                        }
                    }

                    if (validCandidates.length === 1) {
                        console.log(`     → Resolved PO "${finalePONumber}" to: ${validCandidates[0]}`);
                        finalePONumber = validCandidates[0];
                    } else if (validCandidates.length > 1) {
                        // Multiple valid POs — disambiguate by vendor name similarity
                        console.log(`     → Multiple POs found: ${validCandidates.join(", ")} — disambiguating by vendor...`);
                        let bestCandidate = validCandidates[0];
                        let bestScore = -1;
                        const invoiceVendorWords = (invoiceData.vendorName || "")
                            .toLowerCase().split(/\s+/).filter(w => w.length > 2);
                        for (const candidate of validCandidates) {
                            try {
                                const summary = await probeClient.getOrderSummary(candidate);
                                if (!summary) continue;
                                const supplierLower = summary.supplier.toLowerCase();
                                const score = invoiceVendorWords.filter(w => supplierLower.includes(w)).length;
                                console.log(`     ↳ PO ${candidate}: supplier="${summary.supplier}", score=${score}`);
                                if (score > bestScore) { bestScore = score; bestCandidate = candidate; }
                            } catch {
                                /* leave current best */
                            }
                        }
                        console.log(`     → Best vendor match: PO ${bestCandidate}`);
                        finalePONumber = bestCandidate;
                    }
                }
            }

            if (!finalePONumber) {
                try {
                    const candidates = await probeClient.findPOByVendorAndDate(
                        invoiceData.vendorName,
                        invoiceData.invoiceDate,
                        30 // ±30-day window
                    );
                    // Filter to open/committed POs within 10% of invoice total
                    const plausible = candidates.filter(c =>
                        (c.status === "Committed" || c.status === "Open") &&
                        invoiceData.total > 0 &&
                        Math.abs(c.total - invoiceData.total) / invoiceData.total < 0.10
                    );
                    if (plausible.length > 0) {
                        plausible.sort((a, b) =>
                            Math.abs(a.total - invoiceData.total) - Math.abs(b.total - invoiceData.total)
                        );
                        finalePONumber = plausible[0].orderId;
                        matchSource = `Finale vendor+date match (${plausible[0].supplier}, ${plausible[0].orderDate}) — REQUIRES APPROVAL`;
                        console.log(`     → Finale fallback matched PO ${finalePONumber} for ${invoiceData.vendorName}`);
                    }
                } catch (err: any) {
                    console.warn(`     ⚠️ Finale fallback lookup failed: ${err.message}`);
                }
            }

            const matched = !!finalePONumber;
            console.log(`     → PO match: ${matched ? finalePONumber + " (" + matchSource + ")" : "none"}`);

            // 3. Save to DB — audit trail and daily recap source
            const { data: docData } = await supabase.from("documents").insert({
                type: "invoice",
                status: "PROCESSED",
                source: "email",
                source_ref: from,
                email_from: from,
                email_subject: subject,
                raw_text: extracted.rawText,
                action_required: !matched,
                action_summary: `Invoice from ${from} for $${invoiceData.total}`,
                gmail_message_id: messageId || null,
            }).select("id").single();

            await supabase.from("invoices").upsert({
                invoice_number: invoiceData.invoiceNumber,
                vendor_name: invoiceData.vendorName,
                po_number: finalePONumber,
                invoice_date: invoiceData.invoiceDate,
                due_date: invoiceData.dueDate || invoiceData.invoiceDate,
                payment_terms: invoiceData.paymentTerms,
                subtotal: invoiceData.subtotal,
                freight: invoiceData.freight || 0,
                tax: invoiceData.tax || 0,
                tariff: invoiceData.tariff || 0,
                labor: invoiceData.labor || 0,
                tracking_numbers: invoiceData.trackingNumbers || [],
                total: invoiceData.total,
                amount_due: invoiceData.amountDue,
                status: matched ? "matched_review" : "unmatched",
                document_id: docData?.id || null,
                raw_data: invoiceData
            }, { onConflict: "invoice_number" });

            // 3a. Archive into unified vendor_invoices table (non-blocking)
            try {
                await upsertVendorInvoice({
                    vendor_name: invoiceData.vendorName,
                    invoice_number: invoiceData.invoiceNumber,
                    invoice_date: invoiceData.invoiceDate,
                    due_date: invoiceData.dueDate || null,
                    po_number: finalePONumber || null,
                    subtotal: invoiceData.subtotal,
                    freight: invoiceData.freight || 0,
                    tax: invoiceData.tax || 0,
                    total: invoiceData.total,
                    status: matched ? 'received' : 'received',
                    source: 'email_attachment',
                    source_ref: messageId || `email-${from}`,
                    pdf_storage_path: pdfStoragePath,
                    line_items: invoiceData.lineItems?.map(li => ({
                        sku: li.sku || li.description,
                        description: li.description,
                        qty: li.quantity,
                        unit_price: li.unitPrice,
                        ext_price: li.extendedPrice || (li.quantity * li.unitPrice),
                    })),
                    raw_data: invoiceData as unknown as Record<string, unknown>,
                });
            } catch { /* dedup collision or non-critical failure */ }

            // 3b. Log Bill.com forward event with full invoice detail
            // The actual forward happened upstream in processUnreadInvoices before this buffer was queued.
            // We log here because vendor/invoice data isn't available until after parse.
            await this.logActivity(supabase, from, subject, "BILL_FORWARD",
                `Invoice #${invoiceData.invoiceNumber} forwarded to Bill.com — $${invoiceData.total.toLocaleString()} from ${invoiceData.vendorName}`,
                {
                    invoiceNumber: invoiceData.invoiceNumber,
                    vendorName: invoiceData.vendorName,
                    total: invoiceData.total,
                    poNumber: finalePONumber || null,
                    matched,
                    filename,
                }
            );

            // 3c. Pinecone vendor pattern memory — non-blocking, best-effort
            setImmediate(async () => {
                try {
                    const { remember } = await import("./memory");
                    const { storeVendorPattern } = await import("./vendor-memory");
                    const vendorSlug = invoiceData.vendorName.replace(/\s+/g, "_").toLowerCase().replace(/[^a-z0-9_]/g, "");
                    await remember({
                        category: "vendor_pattern",
                        content: `${invoiceData.vendorName} invoice: #${invoiceData.invoiceNumber}, $${invoiceData.total}. PO: ${finalePONumber || "no match"} via ${matchSource}. Confidence: ${invoiceData.confidence}. ${invoiceData.lineItems?.length || 0} line items. Terms: ${invoiceData.paymentTerms || "unknown"}.`,
                        tags: ["ap_invoice", vendorSlug, matched ? "matched" : "unmatched"],
                        source: "email",
                        relatedTo: invoiceData.vendorName,
                        priority: matched ? "normal" : "high",
                    });
                    await storeVendorPattern({
                        vendorName: invoiceData.vendorName,
                        documentType: "INVOICE",
                        pattern: `Sends invoices via email. PO# format on invoice: ${invoiceData.poNumber || "not printed"}. ${invoiceData.lineItems?.length || 0} line items. Payment terms: ${invoiceData.paymentTerms || "unknown"}.`,
                        handlingRule: `Forward to bill.com and reconcile against Finale PO. Match via: ${matchSource}`,
                        learnedFrom: "email_attachment",
                        confidence: invoiceData.confidence === "high" ? 0.9 : invoiceData.confidence === "medium" ? 0.7 : 0.5,
                    });
                } catch (memErr: any) {
                    console.warn("⚠️ AP vendor memory write failed:", memErr.message);
                }
            });

            // 4. Notify Will — unmatched gets info message
            await this.sendNotification(invoiceData, matched, finalePONumber, matchSource, from);

            // 5. Reconcile against Finale
            // Reconciler fetches the live PO, runs all guardrails, and either
            // auto-applies safe changes or sends a Telegram approval request.
            // forceApproval=true when PO was matched via vendor+date fallback (not exact PO#),
            // or via subject-line extraction — both require Will's confirmation before any Finale writes.
            forceApproval = forceApproval || matchSource.includes("REQUIRES APPROVAL");
            if (matched && finalePONumber) {
                await this.reconcileAndUpdate(invoiceData, finalePONumber, supabase, forceApproval, matchSource);
            }

        } catch (err: any) {
            console.error(`   Error processing buffer for ${filename}:`, err.message);
            // Alert Will — something in the pipeline failed after bill.com forward
            const chatId = process.env.TELEGRAM_CHAT_ID || "";
            try {
                await this.bot.telegram.sendMessage(
                    chatId,
                    `⚠️ *Invoice processing error — manual review needed*\nFile: \`${filename}\`\nFrom: ${from}\n\nError: ${err.message}\n\nBill\.com forward already sent\. Finale reconciliation did NOT run\.`,
                    { parse_mode: "MarkdownV2" }
                );
            } catch { /* swallow */ }
            try {
                await supabase?.from("ap_activity_log").insert({
                    email_from: from,
                    email_subject: subject,
                    intent: "PROCESSING_ERROR",
                    action_taken: `processInvoiceBuffer failed: ${err.message}`,
                    metadata: { filename, error: err.message, stage: "processInvoiceBuffer" },
                });
            } catch { /* swallow */ }
        }
    }

    private async resolveVendorAlias(supabase: any, vendorName: string): Promise<string> {
        if (!vendorName || !supabase) return vendorName;
        try {
            // 1. ILIKE case-handling fallback + trim
            const { data, error } = await supabase
                .from("vendor_aliases")
                .select("finale_supplier_name")
                .ilike("alias", vendorName.trim())
                .limit(1);
                
            if (!error && data && data.length > 0) {
                console.log(`     → Vendor alias resolved (exact): "${vendorName}" → "${data[0].finale_supplier_name}"`);
                return data[0].finale_supplier_name;
            }

            // 2. Fuzzy matching fallback (Fuse.js)
            const { data: allAliases, error: allErr } = await supabase
                .from("vendor_aliases")
                .select("alias, finale_supplier_name");
                
            if (!allErr && allAliases && allAliases.length > 0) {
                const fuse = new Fuse(allAliases, { keys: ["alias"], threshold: 0.25 });
                const matches = fuse.search(vendorName.trim());
                if (matches.length > 0) {
                    const bestMatch = matches[0].item;
                    console.log(`     → Vendor alias resolved (fuzzy): "${vendorName}" → "${bestMatch.finale_supplier_name}" (matched pattern: "${bestMatch.alias}")`);
                    return bestMatch.finale_supplier_name;
                }
            }

        } catch (err: any) {
            console.warn(`     ⚠️ Vendor alias lookup failed: ${err.message}`);
        }
        return vendorName;
    }

    private async sendNotification(
        invoice: InvoiceData,
        matched: boolean,
        poNumber: string | null,
        matchSource: string,
        from: string,
    ) {
        let msg = `🧾 *New Invoice Processed*\n`;
        msg += `From: ${from}\n`;
        msg += `Vendor: ${invoice.vendorName}\n`;
        msg += `Total: $${invoice.total.toLocaleString()} (Due: $${invoice.amountDue.toLocaleString()})\n`;
        msg += `━━━━━\n`;

        if (matched && poNumber) {
            msg += `✅ Matched to PO *#${poNumber}*\n`;
            msg += `_${matchSource}_\n`;
            msg += `Running reconciliation against Finale...\n`;
        } else {
            msg += `❌ *No PO found*\n`;
            msg += `Invoice #: ${invoice.invoiceNumber}\n`;
            msg += `_Searched Finale by vendor name + date_\n`;
        }

        const chatId = process.env.TELEGRAM_CHAT_ID || "";
        if (!matched) {
            this.bot.telegram.sendMessage(chatId, msg, { parse_mode: "Markdown" });
        }

        if (this.slack) {
            try {
                await this.slack.chat.postMessage({
                    channel: this.slackChannel,
                    text: msg.replace(/\*/g, "*"),
                    mrkdwn: true
                });
            } catch (err: any) {
                console.error("Slack post failed for AP Agent:", err.message);
            }
        }
    }

    /**
     * Reconcile a parsed invoice against a Finale PO.
     * Compares line prices, fees (freight/tax/tariff/labor), and tracking.
     * Auto-applies safe changes (≤3% variance); sends Telegram approval buttons for risky ones.
     *
     * DECISION(2026-02-26): Multi-layer safety guardrails per Will's requirement:
     *   - ≤3% price change → auto-approve, apply, notify
     *   - >3% but <10x → Telegram bot approval (inline keyboard buttons)
     *   - >10x magnitude shift → REJECT (likely decimal error: $2.60 → $26,000)
     *   - Total PO impact >$500 → require manual approval regardless
     */
    private async reconcileAndUpdate(
        invoice: InvoiceData,
        orderId: string,
        supabase: any,
        forceApproval = false,   // true when PO matched via vendor+date fallback — require human sign-off
        matchStrategy?: string   // M4: Which strategy matched this invoice to PO
    ): Promise<void> {
        try {
            const finaleClient = new FinaleClient();

            // Retry wrapper: Finale is occasionally unavailable. Exponential backoff
            // (2s, 4s, 8s) before giving up and alerting Will to retry manually.
            let result: ReconciliationResult;
            const maxAttempts = 3;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    result = await reconcileInvoiceToPO(invoice, orderId, finaleClient, matchStrategy);
                    break;
                } catch (retryErr: any) {
                    if (attempt === maxAttempts) throw retryErr;
                    const delayMs = 2000 * Math.pow(2, attempt - 1);
                    console.warn(`   ⚠️ Finale reconciliation attempt ${attempt}/${maxAttempts} failed: ${retryErr.message}. Retrying in ${delayMs}ms...`);
                    await new Promise(r => setTimeout(r, delayMs));
                }
            }
            result = result!;

            // If PO was matched via vendor+date fallback (not exact PO# on invoice), upgrade
            // any auto_approve verdict to needs_approval so Will confirms before we write Finale.
            if (forceApproval && result.overallVerdict === "auto_approve") {
                result.overallVerdict = "needs_approval";
                result.autoApplicable = false;
                for (const pc of result.priceChanges) {
                    if (pc.verdict === "auto_approve") {
                        pc.verdict = "needs_approval";
                        pc.reason += " | PO matched via vendor+date fallback — manual confirmation required";
                    }
                }
                console.log(`   ⚠️ Force-upgraded to needs_approval (fallback PO match)`);
            }

            // PHASE 3: Vendor-specific auto-approve threshold check.
            // If this vendor has a learned threshold (from 5+ past approvals at 80%+ rate),
            // and ALL price changes are under that threshold, downgrade needs_approval → auto_approve.
            // This is the autonomy loop: more approvals → tighter threshold → less human review.
            if (
                !forceApproval &&
                result.overallVerdict === "needs_approval" &&
                result.priceChanges.length > 0
            ) {
                try {
                    const { data: vendorProfile } = await supabase
                        .from("vendor_profiles")
                        .select("auto_approve_threshold")
                        .eq("vendor_name", result.vendorName)
                        .single();

                    if (vendorProfile?.auto_approve_threshold !== null && vendorProfile?.auto_approve_threshold !== undefined) {
                        const threshold = vendorProfile.auto_approve_threshold;
                        const maxVariance = result.priceChanges
                            .filter((pc: any) => pc.verdict === "needs_approval")
                            .reduce((max: number, pc: any) => Math.max(max, Math.abs(pc.percentChange * 100)), 0);

                        if (maxVariance <= threshold && maxVariance > 0) {
                            // All variances within learned threshold — downgrade to auto_approve
                            for (const pc of result.priceChanges) {
                                if (pc.verdict === "needs_approval") {
                                    pc.verdict = "auto_approve";
                                    pc.reason += ` | Phase 3 auto-approved (${maxVariance.toFixed(1)}% ≤ ${threshold}% vendor threshold)`;
                                }
                            }
                            result.overallVerdict = "auto_approve";
                            result.autoApplicable = true;
                            console.log(`   🤖 Phase 3: Auto-approved (max ${maxVariance.toFixed(1)}% ≤ ${threshold}% vendor threshold for ${result.vendorName})`);
                        }
                    }
                } catch {
                    // Non-blocking: if vendor profile lookup fails, fall through to normal approval flow
                }
            }

            console.log(`   📊 Reconciliation: ${result.overallVerdict} | Impact: $${result.totalDollarImpact.toFixed(2)}`);

            // Helper to fire Pinecone memory after any reconciliation outcome (non-blocking)
            const writeReconciliationMemory = (verdict: string) => {
                setImmediate(async () => {
                    try {
                        const { remember } = await import("./memory");
                        const vendorSlug = result.vendorName.replace(/\s+/g, "_").toLowerCase().replace(/[^a-z0-9_]/g, "");
                        const priceChangeSummary = result.priceChanges
                            .filter(pc => pc.verdict !== "no_change" && pc.verdict !== "no_match")
                            .map(pc => `${pc.productId}: $${pc.poPrice}→$${pc.invoicePrice} (${(pc.percentChange * 100).toFixed(1)}%)`)
                            .join(", ") || "none";
                        const feeSummary = result.feeChanges
                            .map(fc => `${fc.feeType}: $${fc.amount}`)
                            .join(", ") || "none";
                        const carrier = result.trackingUpdate?.carrierName ?? "unknown carrier";
                        const tracking = result.trackingUpdate?.trackingNumbers?.join(", ") ?? "no tracking";
                        await remember({
                            category: "decision",
                            content: `PO ${orderId} reconciled (${verdict}): ${result.vendorName} invoice #${result.invoiceNumber}. $${result.totalDollarImpact.toFixed(2)} impact. Price changes: ${priceChangeSummary}. Fees: ${feeSummary}. Carrier: ${carrier}. Tracking: ${tracking}. Forced approval: ${forceApproval}.`,
                            tags: ["reconciliation", verdict, orderId, vendorSlug],
                            source: "email",
                            relatedTo: result.vendorName,
                            priority: verdict === "rejected" || verdict === "needs_approval" ? "high" : "normal",
                        });
                    } catch (memErr: any) {
                        console.warn("⚠️ Reconciliation memory write failed:", memErr.message);
                    }
                });
            };

            if (result.overallVerdict === "auto_approve") {
                // Safe to auto-apply
                if (result.priceChanges.length > 0 || result.feeChanges.length > 0 || result.trackingUpdate) {
                    // C1 FIX: Write "pending" audit entry BEFORE Finale writes.
                    // If applyReconciliation() succeeds but logReconciliation() fails,
                    // checkDuplicateReconciliation() still finds this entry and stops re-processing.
                    let pendingLogId: string | null = null;
                    try {
                        const { data: pendingLog } = await supabase.from("ap_activity_log").insert({
                            email_from: result.vendorName,
                            email_subject: `Invoice ${result.invoiceNumber} → PO ${result.orderId}`,
                            intent: "RECONCILIATION",
                            action_taken: "Pending — applying to Finale...",
                            metadata: { invoiceNumber: result.invoiceNumber, orderId: result.orderId, status: "pending" },
                        }).select("id").single();
                        pendingLogId = pendingLog?.id ?? null;
                    } catch { /* proceed — Finale write is still safe, just loses idempotency guard */ }

                    const applyResult = await applyReconciliation(result, finaleClient);

                    if (applyResult.applied.length > 0) {
                        console.log(`   ✅ Applied ${applyResult.applied.length} change(s) to Finale PO ${orderId}`);
                    }
                    if (applyResult.errors.length > 0) {
                        console.error(`   ❌ ${applyResult.errors.length} error(s) applying to Finale:`, applyResult.errors);
                    }

                    // Update the pending entry to "applied" with full audit data,
                    // or fall back to a new row if the update fails.
                    if (pendingLogId) {
                        try {
                            await supabase.from("ap_activity_log").update({
                                action_taken: result.autoApplicable
                                    ? `Auto-applied: ${applyResult.applied.length} changes, ${applyResult.skipped.length} skipped`
                                    : `Flagged for review: ${result.overallVerdict}`,
                                notified_slack: !!this.slack,
                                metadata: buildAuditMetadata(result, applyResult, "auto"),
                                reconciliation_report: result.report ?? null,
                            }).eq("id", pendingLogId);

                            // Update structured invoice state (same logic as logReconciliation)
                            let newStatus = "matched_review";
                            if (result.overallVerdict === "auto_approve" || result.overallVerdict === "no_change") newStatus = "reconciled";
                            if (result.overallVerdict === ("no_match" as any)) newStatus = "unmatched";
                            const discrepancies = [
                                ...result.priceChanges.filter(pc => pc.verdict !== "no_change").map(pc => ({
                                    type: "price", productId: pc.productId, expected: pc.poPrice,
                                    actual: pc.invoicePrice, verdict: pc.verdict, reason: pc.reason
                                })),
                                ...result.feeChanges.map(fc => ({
                                    type: "fee", feeType: fc.feeType, expected: fc.existingAmount,
                                    actual: fc.amount, verdict: fc.verdict, reason: fc.reason
                                }))
                            ];
                            await supabase.from("invoices").update({ status: newStatus, discrepancies })
                                .eq("invoice_number", result.invoiceNumber)
                                .ilike("vendor_name", `%${result.vendorName}%`);
                        } catch {
                            // Fallback: write a new row (old pattern) if update failed
                            await this.logReconciliation(supabase, result, applyResult);
                        }
                    } else {
                        await this.logReconciliation(supabase, result, applyResult);
                    }
                }
                writeReconciliationMemory("auto_approve");
                await this.sendReconciliationNotification(result);

            } else if (result.overallVerdict === "needs_approval") {
                // Store for Telegram bot approval and send inline keyboard
                const approvalId = await storePendingApproval(result, finaleClient);
                writeReconciliationMemory("needs_approval");
                await this.sendApprovalRequest(result, approvalId);

            } else if (result.overallVerdict === "rejected") {
                // Magnitude error — alert but do NOT apply
                writeReconciliationMemory("rejected");
                await this.sendReconciliationNotification(result);

            } else if (result.overallVerdict === "duplicate") {
                // Already reconciled — alert Will but do NOT re-apply
                console.log(`   🔁 Duplicate: Invoice #${result.invoiceNumber} already reconciled against PO ${orderId}`);
                writeReconciliationMemory("duplicate");
                await this.sendReconciliationNotification(result);

            } else {
                // no_change — log so checkDuplicateReconciliation fires on re-processing
                // (prevents repeated "no change" notifications if the same invoice arrives again)
                if (result.overallVerdict === "no_change") {
                    await this.logReconciliation(supabase, result, { applied: [], skipped: [], errors: [] });
                }
                await this.sendReconciliationNotification(result);
            }

            // Kaizen: record reconciliation verdict (Pillar 3 — Prediction Accuracy)
            recordFeedback({
                category: "prediction",
                eventType: `reconciliation_${result.overallVerdict}`,
                agentSource: "ap_agent",
                subjectType: "po",
                subjectId: orderId,
                prediction: {
                    verdict: result.overallVerdict,
                    totalImpact: result.totalDollarImpact,
                    priceChanges: result.priceChanges.length,
                    feeChanges: result.feeChanges.length,
                },
                accuracyScore: result.overallVerdict === "auto_approve" || result.overallVerdict === "no_change" ? 1.0 : 0.5,
                contextData: {
                    vendor: result.vendorName,
                    invoice: result.invoiceNumber,
                    forceApproval,
                },
            }).catch(() => { /* non-blocking */ });

        } catch (err: any) {
            console.error(`   ❌ Reconciliation failed for PO ${orderId}:`, err.message);
            // Alert Will — Finale API failure means PO was not updated. Human must check manually.
            try {
                await this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID || "",
                    `🚨 *Reconciliation failed — manual action needed*\nPO: \`${orderId}\`\nVendor: ${invoice.vendorName}\nInvoice: ${invoice.invoiceNumber}\n\nError: ${err.message}\n\nBill\.com forward ✓ \| Finale PO update ✗\nPlease review PO ${orderId} manually\.`,
                    { parse_mode: "MarkdownV2" }
                );
            } catch { /* swallow */ }
            try {
                await this.logActivity(
                    supabase, invoice.vendorName,
                    `Invoice ${invoice.invoiceNumber} → PO ${orderId}`,
                    "RECONCILIATION_ERROR",
                    `Reconciliation failed: ${err.message}`,
                    { invoiceNumber: invoice.invoiceNumber, orderId, error: err.message }
                );
            } catch { /* swallow */ }
        }
    }

    private async logReconciliation(
        supabase: any,
        result: ReconciliationResult,
        applyResult: { applied: string[]; skipped: string[]; errors: string[] }
    ): Promise<void> {
        try {
            // Build the structured audit report — use cached result.report if present,
            // otherwise generate it on the spot (no extra API calls needed).
            const reconciliationReport = result.report ?? null;

            await supabase.from("ap_activity_log").insert({
                email_from: result.vendorName,
                email_subject: `Invoice ${result.invoiceNumber} → PO ${result.orderId}`,
                intent: "RECONCILIATION",
                action_taken: result.autoApplicable
                    ? `Auto-applied: ${applyResult.applied.length} changes, ${applyResult.skipped.length} skipped`
                    : `Flagged for review: ${result.overallVerdict}`,
                notified_slack: !!this.slack,
                metadata: buildAuditMetadata(result, applyResult, "auto"),
                reconciliation_report: reconciliationReport,
            });

            // Update structured invoice state
            let newStatus = "matched_review";
            if (result.overallVerdict === "auto_approve" || result.overallVerdict === "no_change") newStatus = "reconciled";
            if (result.overallVerdict === "no_match") newStatus = "unmatched";

            const discrepancies = [
                ...result.priceChanges.filter(pc => pc.verdict !== "no_change").map(pc => ({
                    type: "price",
                    productId: pc.productId,
                    expected: pc.poPrice,
                    actual: pc.invoicePrice,
                    verdict: pc.verdict,
                    reason: pc.reason
                })),
                ...result.feeChanges.map(fc => ({
                    type: "fee",
                    feeType: fc.feeType,
                    expected: fc.existingAmount,
                    actual: fc.amount,
                    verdict: fc.verdict,
                    reason: fc.reason
                }))
            ];

            await supabase.from("invoices").update({
                status: newStatus,
                discrepancies: discrepancies
            })
                .eq("invoice_number", result.invoiceNumber)
                .ilike("vendor_name", `%${result.vendorName}%`);

        } catch (err: any) {
            console.warn("⚠️ Failed to log reconciliation:", err.message);
        }
    }

    /**
     * Send reconciliation summary to Slack and Telegram.
     */
    private async sendReconciliationNotification(result: ReconciliationResult): Promise<void> {
        if (result.overallVerdict === "no_change") return;

        const msg = result.summary;

        // Telegram
        try {
            await this.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID || "",
                msg,
                { parse_mode: "Markdown" }
            );
        } catch (err: any) {
            console.error("Telegram reconciliation notification failed:", err.message);
        }

        // Slack
        if (this.slack) {
            try {
                await this.slack.chat.postMessage({
                    channel: this.slackChannel,
                    text: msg,
                    mrkdwn: true
                });
            } catch (err: any) {
                console.error("Slack reconciliation notification failed:", err.message);
            }
        }
    }

    /**
     * Send a Telegram message with inline Approve/Reject buttons.
     * When Will taps a button, the bot.action handler processes the response.
     *
     * DECISION(2026-02-26): Using Telegram (not Slack) for approvals per Will.
     * This keeps the approval flow in the same chat where Will already operates.
     * DECISION(2026-03-10): Capture the Telegram message_id after send so we can
     * back-fill it into pending_reconciliations for post-restart button recovery.
     */
    private async sendApprovalRequest(result: ReconciliationResult, approvalId: string): Promise<void> {
        const msg = result.summary + "\n\n☝️ *Tap to approve or reject these changes:*";

        try {
            const sentMsg = await this.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID || "",
                msg,
                {
                    parse_mode: "Markdown",
                    ...Markup.inlineKeyboard([
                        Markup.button.callback("✅ Approve & Apply", `approve_${approvalId}`),
                        Markup.button.callback("❌ Reject", `reject_${approvalId}`),
                    ])
                }
            );
            // Back-fill the Telegram message ID so it's available after a restart
            if (sentMsg?.message_id) {
                updatePendingApprovalMessageId(approvalId, sentMsg.message_id).catch(() => { /* non-blocking */ });
            }
        } catch (err: any) {
            console.error("Telegram approval request failed:", err.message);
            // Fallback: send without buttons
            try {
                await this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID || "",
                    msg + "\n\n(Buttons failed — reply /approve or /reject to this PO)",
                    { parse_mode: "Markdown" }
                );
            } catch { /* swallow */ }
        }
    }

    // ──────────────────────────────────────────────────
    // ACTIVITY LOGGING
    // ──────────────────────────────────────────────────

    /**
     * Logs every AP Agent action to the ap_activity_log table.
     * This powers the daily recap and provides an audit trail.
     */
    private async logActivity(
        supabase: any,
        emailFrom: string,
        emailSubject: string,
        intent: string,
        actionTaken: string,
        metadata?: Record<string, any>,
        notifiedSlack: boolean = false
    ) {
        if (!supabase) return;
        try {
            await supabase.from("ap_activity_log").insert({
                email_from: emailFrom,
                email_subject: emailSubject,
                intent,
                action_taken: actionTaken,
                notified_slack: notifiedSlack,
                metadata: metadata || null
            });
        } catch (err: any) {
            console.warn("⚠️ Failed to log AP activity:", err.message);
        }
    }

    /**
     * Sends a daily recap of all AP Agent actions to Telegram and Slack.
     * Groups by intent category for easy scanning.
     *
     * DECISION(2026-02-26): This provides a monitoring layer so Will can
     * spot-check the agent's decisions daily, especially during the early
     * rollout period. Trust but verify.
     */
    async sendDailyRecap() {
        const supabase = createClient();
        if (!supabase) return;

        // Get today's activity from midnight Denver time (America/Denver, UTC-6/7).
        // Using UTC midnight would miss emails processed in the early Denver morning hours.
        // Detect MDT vs MST dynamically so DST transitions don't break the query window.
        const _now = new Date();
        const _denverDate = _now.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
        const _tzName = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", timeZoneName: "short" })
            .formatToParts(_now).find(p => p.type === "timeZoneName")?.value ?? "MST";
        const _offset = _tzName === "MDT" ? "-06:00" : "-07:00";
        const todayStart = new Date(`${_denverDate}T00:00:00${_offset}`);

        const { data: logs, error } = await supabase
            .from("ap_activity_log")
            .select("*")
            .gte("created_at", todayStart.toISOString())
            .order("created_at", { ascending: true });

        if (error) {
            console.error("❌ Failed to fetch AP activity log:", error.message);
            return;
        }

        if (!logs || logs.length === 0) {
            console.log("📭 No AP activity today — skipping recap.");
            return;
        }

        // Group by intent — exclude ads from the recap (they're still logged to DB)
        const grouped: Record<string, typeof logs> = {};
        for (const log of logs) {
            if (log.intent === "ADVERTISEMENT") continue;
            if (!grouped[log.intent]) grouped[log.intent] = [];
            grouped[log.intent].push(log);
        }

        const adCount = logs.filter(l => l.intent === "ADVERTISEMENT").length;
        const actionableCount = logs.length - adCount;

        const intentEmoji: Record<string, string> = {
            INVOICE: "🧾",
            INLINE_INVOICE: "📧",
            STATEMENT: "📑",
            HUMAN_INTERACTION: "👤",
            PREPAYMENT: "🚨",
            BILL_FORWARD: "📤",
            RECONCILIATION: "📊",
            PROCESSING_ERROR: "⚠️",
            AUTOPAY: "💳",
            DROPSHIP: "📦",
        };

        let msg = `📊 *AP Agent Daily Recap* — ${actionableCount} email${actionableCount !== 1 ? 's' : ''} processed\n`;
        if (adCount > 0) msg += `_${adCount} ad${adCount !== 1 ? 's' : ''} auto-archived_\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

        for (const [intent, items] of Object.entries(grouped)) {
            const emoji = intentEmoji[intent] || "📧";
            msg += `${emoji} *${intent}* (${items.length})\n`;
            for (const item of items) {
                const from = (item.email_from || "Unknown").replace(/<.*>/, "").trim();
                msg += `  • ${from}: _${item.email_subject.substring(0, 60)}_\n`;
                msg += `    → ${item.action_taken}\n`;
            }
            msg += `\n`;
        }

        msg += `_Review any misclassifications and let me know — I learn from your feedback._`;

        // Send to Telegram
        try {
            await this.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID || "",
                msg,
                { parse_mode: "Markdown" }
            );
            console.log("📊 AP Daily Recap sent to Telegram.");
        } catch (err: any) {
            console.error("❌ Telegram recap failed:", err.message);
        }

    }
}
