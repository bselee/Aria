import { google } from "googleapis";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { Telegraf, Markup } from "telegraf";
import { WebClient } from "@slack/web-api";
import { extractPDF } from "../pdf/extractor";
import { parseInvoice, InvoiceData } from "../pdf/invoice-parser";
import { matchInvoiceToPO, MatchResult } from "../matching/invoice-po-matcher";
import { FinaleClient } from "../finale/client";
import {
    reconcileInvoiceToPO,
    applyReconciliation,
    ReconciliationResult,
    storePendingApproval,
} from "../finale/reconciler";
import { unifiedObjectGeneration } from "./llm";
import { z } from "zod";

/**
 * @file    ap-agent.ts
 * @purpose Dedicated agent for the ap@buildasoil.com inbox.
 *          Downloads attached PDF invoices, parses data, correlates with POs,
 *          and notifies the team of discrepancies or matching statuses.
 * @author  Antigravity / Aria
 */
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

    private async classifyEmailIntent(subject: string, from: string, snippet: string): Promise<string> {
        const schema = z.object({
            intent: z.enum(["INVOICE", "STATEMENT", "ADVERTISEMENT", "HUMAN_INTERACTION"]),
            reasoning: z.string()
        });

        const prompt = `Classify this incoming email from our Accounts Payable inbox.
From: ${from}
Subject: ${subject}
Snippet: ${snippet}

CATEGORIES:
INVOICE - Vendor submitting a bill or invoice requiring payment.
STATEMENT - Vendor sending an account statement, aging summary, or reconciliation.
ADVERTISEMENT - Marketing, promotional spam, newsletters, or sales pitches.
HUMAN_INTERACTION - Payment questions, order issues, or generic emails that a human must read and reply to.

Classify carefully based on the sender, subject and text snippet.`;

        try {
            const res = await unifiedObjectGeneration({
                system: "You are an AP Routing Engine sorting a corporate inbox.",
                prompt,
                schema,
                schemaName: "EmailIntent"
            }) as { intent: string, reasoning: string };

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
            const auth = await getAuthenticatedClient("ap");
            const gmail = google.gmail({ version: "v1", auth });
            const supabase = createClient();

            // Find *ALL* unread emails in the inbox
            const { data } = await gmail.users.messages.list({
                userId: "me",
                q: "is:unread in:inbox",
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
                const msg = await gmail.users.messages.get({ userId: "me", id: m.id! });
                const payload = msg.data.payload;
                const headers = payload?.headers || [];

                const subject = headers.find((h: any) => h.name === "Subject")?.value || "No Subject";
                const from = headers.find((h: any) => h.name === "From")?.value || "Unknown Sender";
                const snippet = msg.data.snippet || "";

                console.log(`   Evaluating Email: "${subject}" from ${from}`);

                const intent = await this.classifyEmailIntent(subject, from, snippet);
                console.log(`     -> Classified as: ${intent}`);

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
                            removeLabelIds: ["UNREAD"]
                        }
                    });
                    await this.logActivity(supabase, from, subject, "STATEMENT", "Labeled as Statement, marked read");
                    continue;
                }

                if (intent === "HUMAN_INTERACTION") {
                    // We just leave it unread in the inbox so the user is forced to engage.
                    await this.logActivity(supabase, from, subject, "HUMAN_INTERACTION", "Left unread for human review");
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
                        console.log(`     Downloading ${part.filename}`);

                        const attachment = await gmail.users.messages.attachments.get({
                            userId: "me",
                            messageId: m.id!,
                            id: part.body.attachmentId
                        });

                        const base64Data = attachment.data.data;
                        if (base64Data) {
                            processedAnyPDF = true;

                            // 1. Forward strictly to buildasoilap@bill.com IMMEDIATELY
                            // This ensures Bill.com gets the invoice perfectly regardless of our PO matching logic
                            await this.forwardToBillCom(gmail, subject, part.filename!, base64Data);

                            // 2. Process Database & Extraction matching in the background
                            // We do this non-blocking so it doesn't hold up the pipeline if it fails
                            const buffer = Buffer.from(base64Data, "base64");
                            this.processInvoiceBuffer(buffer, part.filename!, subject, from, supabase).catch(err => {
                                console.error(`     ❌ Background matching failed for ${part.filename!}:`, err);
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
                            removeLabelIds: ["UNREAD"]
                        }
                    });
                    const pdfNames = pdfParts.map((p: any) => p.filename).join(", ");
                    await this.logActivity(supabase, from, subject, "INVOICE", `Forwarded to Bill.com (${pdfNames})`, { attachments: pdfNames });
                } else {
                    // It was classified as an Invoice but had no PDF, so leave unread for human interaction.
                    console.log(`     ⚠️ No PDF found on INVOICE. Leaving unread for human check.`);
                    await this.logActivity(supabase, from, subject, "INVOICE", "No PDF found — left unread for human review");
                }
            }

        } catch (err: any) {
            console.error("❌ [AP-Agent] Error processing AP Inbox:", err.message);
        }
    }

    private async forwardToBillCom(gmail: any, originalSubject: string, filename: string, base64Data: string) {
        console.log(`     -> Forwarding ${filename} to buildasoilap@bill.com`);
        const boundary = "b_aria_forwarded_bill_" + Math.random().toString(36).substring(2);
        const mimeMessage = [
            `To: buildasoilap@bill.com`,
            `Subject: Fwd: ${originalSubject}`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            ``,
            `--${boundary}`,
            `Content-Type: text/plain; charset="UTF-8"`,
            ``,
            `Forwarded Invoice via Aria AP Agent.`,
            ``,
            `--${boundary}`,
            `Content-Type: application/pdf; name="${filename}"`,
            `Content-Transfer-Encoding: base64`,
            `Content-Disposition: attachment; filename="${filename}"`,
            ``,
            base64Data,
            `--${boundary}--`
        ].join("\r\n");

        try {
            await gmail.users.messages.send({
                userId: "me",
                requestBody: {
                    raw: Buffer.from(mimeMessage).toString("base64url")
                }
            });
        } catch (err: any) {
            console.error("     ❌ Failed to forward to bill.com:", err.message);
        }
    }

    private async processInvoiceBuffer(buffer: Buffer, filename: string, subject: string, from: string, supabase: any) {
        try {
            // 1. Extract text and detect tables/images
            const extracted = await extractPDF(buffer);

            // 2. Parse invoice schema via unified LLM
            const invoiceData: InvoiceData = await parseInvoice(extracted.rawText);

            // 3. Attempt to match to an open PO
            const matchResult: MatchResult = await matchInvoiceToPO(invoiceData);

            // 4. Save to Database
            // Create corresponding document record first to track the generic file
            const { data: docData, error: docError } = await supabase.from("documents").insert({
                type: "invoice",
                status: "PROCESSED",
                source: "email",
                source_ref: from, // Email sender
                email_from: from,
                email_subject: subject,
                raw_text: extracted.rawText,
                action_required: !matchResult.matched || matchResult.discrepancies.length > 0,
                action_summary: `Invoice from ${from} for ${invoiceData.total}`
            }).select("id").single();

            let documentId = null;
            if (docData && !docError) {
                documentId = docData.id;
            } else if (docError) {
                console.error("   Error saving document:", docError.message);
            }

            // Upsert the specific invoice data
            const { data: invData, error: invError } = await supabase.from("invoices").upsert({
                invoice_number: invoiceData.invoiceNumber,
                vendor_name: invoiceData.vendorName,
                po_number: invoiceData.poNumber || matchResult.matchedPO?.poNumber || null,
                invoice_date: invoiceData.invoiceDate,
                due_date: invoiceData.dueDate || invoiceData.invoiceDate, // fallback
                payment_terms: invoiceData.paymentTerms,
                subtotal: invoiceData.subtotal,
                freight: invoiceData.freight || 0,
                tax: invoiceData.tax || 0,
                tariff: invoiceData.tariff || 0,
                labor: invoiceData.labor || 0,
                tracking_numbers: invoiceData.trackingNumbers || [],
                total: invoiceData.total,
                amount_due: invoiceData.amountDue,
                status: matchResult.matched ? (matchResult.autoApprove ? "matched_approved" : "matched_review") : "unmatched",
                discrepancies: matchResult.discrepancies,
                document_id: documentId,
                raw_data: invoiceData
            }, { onConflict: "invoice_number" }).select("id").single();

            if (invError) {
                console.error("   Error saving invoice to DB:", invError.message);
            }

            // 5. Build and send notifications
            await this.sendNotification(invoiceData, matchResult, subject, from);

            // 6. Reconcile against Finale (Phase 1)
            // If we matched to a PO, run the full reconciliation pipeline:
            // compare prices, detect fees, verify tracking, apply safe changes
            if (matchResult.matched && (invoiceData.poNumber || matchResult.matchedPO?.poNumber)) {
                const finalePONumber = invoiceData.poNumber || matchResult.matchedPO?.poNumber;
                if (finalePONumber) {
                    await this.reconcileAndUpdate(invoiceData, finalePONumber, supabase);
                }
            }

        } catch (err: any) {
            console.error(`   Error processing buffer for ${filename}:`, err.message);
        }
    }

    private async sendNotification(invoice: InvoiceData, match: MatchResult, subject: string, from: string) {
        let msg = `🧾 *New Invoice Processed*\n`;
        msg += `From: ${from}\n`;
        msg += `Vendor: ${invoice.vendorName}\n`;
        msg += `Total: $${invoice.total.toLocaleString()} (Due: $${invoice.amountDue.toLocaleString()})\n`;
        msg += `━━━━━\n`;

        if (match.matched) {
            const poNum = match.matchedPO?.poNumber || invoice.poNumber || "Unknown";
            msg += `✅ Matched to PO #${poNum} (${match.confidence} confidence)\n`;

            if (match.autoApprove) {
                msg += `✨ *Auto-Approved* - No discrepancies found.\n`;
            } else if (match.discrepancies.length > 0) {
                msg += `⚠️ *Action Required - Discrepancies:*\n`;
                for (const d of match.discrepancies) {
                    msg += `  • [${d.severity.toUpperCase()}] ${d.field}: Inv=${d.invoiceValue} vs PO=${d.poValue} (Δ ${d.delta})\n`;
                }
            } else {
                msg += `⚠️ *Manual Review Required* - ${match.matchStrategy}\n`;
            }
        } else {
            msg += `❌ *Unmatched Invoice*\n`;
            msg += `Could not confidently match to an open PO.\n`;
            msg += `Strategy: ${match.matchStrategy}\n`;
        }

        // Send to Telegram
        this.bot.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID || "",
            msg,
            { parse_mode: "Markdown" }
        );

        // Send to Slack
        if (this.slack) {
            try {
                await this.slack.chat.postMessage({
                    channel: this.slackChannel,
                    text: msg.replace(/\*/g, "*"), // Slack formatting
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
        supabase: any
    ): Promise<void> {
        try {
            const finaleClient = new FinaleClient();
            const result: ReconciliationResult = await reconcileInvoiceToPO(invoice, orderId, finaleClient);

            console.log(`   📊 Reconciliation: ${result.overallVerdict} | Impact: $${result.totalDollarImpact.toFixed(2)}`);

            if (result.overallVerdict === "auto_approve") {
                // Safe to auto-apply
                if (result.priceChanges.length > 0 || result.feeChanges.length > 0 || result.trackingUpdate) {
                    const applyResult = await applyReconciliation(result, finaleClient);

                    if (applyResult.applied.length > 0) {
                        console.log(`   ✅ Applied ${applyResult.applied.length} change(s) to Finale PO ${orderId}`);
                    }
                    if (applyResult.errors.length > 0) {
                        console.error(`   ❌ ${applyResult.errors.length} error(s) applying to Finale:`, applyResult.errors);
                    }

                    await this.logReconciliation(supabase, result, applyResult);
                }
                await this.sendReconciliationNotification(result);

            } else if (result.overallVerdict === "needs_approval") {
                // Store for Telegram bot approval and send inline keyboard
                const approvalId = storePendingApproval(result, finaleClient);
                await this.sendApprovalRequest(result, approvalId);

            } else if (result.overallVerdict === "rejected") {
                // Magnitude error — alert but do NOT apply
                await this.sendReconciliationNotification(result);

            } else if (result.overallVerdict === "duplicate") {
                // Already reconciled — alert Will but do NOT re-apply
                console.log(`   🔁 Duplicate: Invoice #${result.invoiceNumber} already reconciled against PO ${orderId}`);
                await this.sendReconciliationNotification(result);

            } else {
                // no_change — log so checkDuplicateReconciliation fires on re-processing
                // (prevents repeated "no change" notifications if the same invoice arrives again)
                if (result.overallVerdict === "no_change") {
                    await this.logReconciliation(supabase, result, { applied: [], skipped: [], errors: [] });
                }
                await this.sendReconciliationNotification(result);
            }

        } catch (err: any) {
            console.error(`   ❌ Reconciliation failed for PO ${orderId}:`, err.message);
        }
    }

    /**
     * Log reconciliation results to Supabase for audit trail.
     */
    private async logReconciliation(
        supabase: any,
        result: ReconciliationResult,
        applyResult: { applied: string[]; skipped: string[]; errors: string[] }
    ): Promise<void> {
        try {
            await supabase.from("ap_activity_log").insert({
                email_from: result.vendorName,
                email_subject: `Invoice ${result.invoiceNumber} → PO ${result.orderId}`,
                intent: "RECONCILIATION",
                action_taken: result.autoApplicable
                    ? `Auto-applied: ${applyResult.applied.length} changes, ${applyResult.skipped.length} skipped`
                    : `Flagged for review: ${result.overallVerdict}`,
                notified_slack: !!this.slack,
                metadata: {
                    orderId: result.orderId,
                    invoiceNumber: result.invoiceNumber,
                    verdict: result.overallVerdict,
                    totalImpact: result.totalDollarImpact,
                    applied: applyResult.applied,
                    skipped: applyResult.skipped,
                    errors: applyResult.errors,
                }
            });
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
     */
    private async sendApprovalRequest(result: ReconciliationResult, approvalId: string): Promise<void> {
        const msg = result.summary + "\n\n☝️ *Tap to approve or reject these changes:*";

        try {
            await this.bot.telegram.sendMessage(
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

        // Get today's activity (UTC day)
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);

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

        // Group by intent
        const grouped: Record<string, typeof logs> = {};
        for (const log of logs) {
            if (!grouped[log.intent]) grouped[log.intent] = [];
            grouped[log.intent].push(log);
        }

        const intentEmoji: Record<string, string> = {
            INVOICE: "🧾",
            STATEMENT: "📑",
            ADVERTISEMENT: "🗑️",
            HUMAN_INTERACTION: "👤"
        };

        let msg = `📊 *AP Agent Daily Recap* — ${logs.length} email${logs.length > 1 ? 's' : ''} processed\n`;
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

        // Send to Slack
        if (this.slack) {
            try {
                await this.slack.chat.postMessage({
                    channel: this.slackChannel,
                    text: msg.replace(/\*/g, "*"),
                    mrkdwn: true
                });
            } catch (err: any) {
                console.error("❌ Slack recap failed:", err.message);
            }
        }
    }
}
