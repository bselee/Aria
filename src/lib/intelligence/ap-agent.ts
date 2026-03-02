import { google } from "googleapis";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { Telegraf, Markup } from "telegraf";
import { WebClient } from "@slack/web-api";
import { extractPDF } from "../pdf/extractor";
import { parseInvoice, InvoiceData } from "../pdf/invoice-parser";
// matchInvoiceToPO kept for manual re-match flow in start-bot.ts invoice_has_po_ handler
// but is no longer in the hot path — ap-agent queries Finale directly
import { FinaleClient } from "../finale/client";
import {
    reconcileInvoiceToPO,
    applyReconciliation,
    ReconciliationResult,
    storePendingApproval,
} from "../finale/reconciler";
import { unifiedObjectGeneration } from "./llm";
import { storePendingDropship, getAllPendingDropships } from "./dropship-store";
import { z } from "zod";

// ──────────────────────────────────────────────────
// KNOWN DROPSHIP VENDORS
// ──────────────────────────────────────────────────
// DECISION(2026-02-27): These vendors always ship directly to customers —
// there is NEVER a matching Finale PO for them. Skip LLM classification and
// auto-route as DROPSHIP_INVOICE (forward to bill.com, no reconciliation).
// Add vendor name or email fragments (case-insensitive) as needed.
const KNOWN_DROPSHIP_KEYWORDS = [
    "autopot",
    "logan labs",
    "loganlab",
    "evergreen growers",
    "evergreengrow",
    // add more: "vendor name fragment" or "emaildomain.com"
];

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

    private isKnownDropshipVendor(from: string, subject: string): boolean {
        const haystack = `${from} ${subject}`.toLowerCase();
        return KNOWN_DROPSHIP_KEYWORDS.some(kw => haystack.includes(kw.toLowerCase()));
    }

    private async classifyEmailIntent(subject: string, from: string, snippet: string): Promise<string> {
        const schema = z.object({
            intent: z.enum(["INVOICE", "DROPSHIP_INVOICE", "STATEMENT", "ADVERTISEMENT", "HUMAN_INTERACTION"]),
            reasoning: z.string()
        });

        const prompt = `Classify this incoming email from our Accounts Payable inbox.
From: ${from}
Subject: ${subject}
Snippet: ${snippet}

CATEGORIES:
INVOICE - Vendor submitting a bill for goods we ordered via a standard purchase order (warehouse stock, bulk orders).
DROPSHIP_INVOICE - Vendor billing us for a DROPSHIP order shipped directly to a customer. Signals: "dropship", "ship to customer", a customer address on the invoice, or order type is clearly a customer fulfillment. No Finale PO reconciliation needed — just forward to bill.com.
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

                // Fast-path: skip LLM for known dropship vendors
                const intent = this.isKnownDropshipVendor(from, subject)
                    ? "DROPSHIP_INVOICE"
                    : await this.classifyEmailIntent(subject, from, snippet);
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

                // --- INVOICE / DROPSHIP PROCESSING ---
                const isDropship = intent === "DROPSHIP_INVOICE";
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
                            this.processInvoiceBuffer(buffer, part.filename!, subject, from, supabase, isDropship).catch(err => {
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
                    const logIntent = isDropship ? "DROPSHIP_INVOICE" : "INVOICE";
                    const logNote = isDropship
                        ? `Dropship — forwarded to Bill.com (${pdfNames}), no Finale reconciliation`
                        : `Forwarded to Bill.com (${pdfNames})`;
                    await this.logActivity(supabase, from, subject, logIntent, logNote, { attachments: pdfNames });
                } else {
                    // It was classified as an Invoice but had no PDF, so leave unread for human interaction.
                    const logIntent = isDropship ? "DROPSHIP_INVOICE" : "INVOICE";
                    console.log(`     ⚠️ No PDF found on ${logIntent}. Leaving unread for human check.`);
                    await this.logActivity(supabase, from, subject, logIntent, "No PDF found — left unread for human review");
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

    private async processInvoiceBuffer(buffer: Buffer, filename: string, subject: string, from: string, supabase: any, isDropship = false) {
        try {
            // 1. Extract + parse
            const extracted = await extractPDF(buffer);
            const invoiceData: InvoiceData = await parseInvoice(extracted.rawText);

            // 1b. Low-confidence guard — garbled PDF, skip reconciliation entirely
            if (invoiceData.confidence === "low") {
                console.warn(`     ⚠️ Low-confidence parse for ${filename} — alerting Will.`);
                const chatId = process.env.TELEGRAM_CHAT_ID || "";
                await this.bot.telegram.sendMessage(chatId,
                    `⚠️ *Low-confidence invoice parse*\nFile: \`${filename}\`\nVendor: ${invoiceData.vendorName}\nForwarded to Bill.com but no Finale reconciliation attempted. Please review manually.`,
                    { parse_mode: "Markdown" }
                );
                await this.logActivity(supabase, from, subject, "INVOICE", `Low-confidence parse — reconciliation skipped for ${filename}`);
                return;
            }

            // 2. Find matching PO — Finale direct, no Supabase middle layer
            // If invoice has a PO# printed on it, use it. Otherwise query Finale by
            // vendor name + invoice date to find the most plausible open PO.
            let finalePONumber: string | null = invoiceData.poNumber || null;
            let matchSource = "PO# on invoice";

            if (!finalePONumber && !isDropship) {
                try {
                    const finaleClient = new FinaleClient();
                    const candidates = await finaleClient.findPOByVendorAndDate(
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
                action_summary: `Invoice from ${from} for $${invoiceData.total}`
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

            // 4. Notify Will — unmatched gets action buttons
            let pendingDropshipId: string | null = null;
            if (!matched) {
                pendingDropshipId = storePendingDropship({
                    invoiceNumber: invoiceData.invoiceNumber,
                    vendorName: invoiceData.vendorName,
                    total: invoiceData.total,
                    subject,
                    from,
                    filename,
                    base64Pdf: buffer.toString("base64"),
                });
            }
            await this.sendNotification(invoiceData, matched, finalePONumber, matchSource, subject, from, isDropship, pendingDropshipId);

            // 5. Reconcile against Finale
            // Reconciler fetches the live PO, runs all guardrails, and either
            // auto-applies safe changes or sends a Telegram approval request.
            if (!isDropship && matched && finalePONumber) {
                await this.reconcileAndUpdate(invoiceData, finalePONumber, supabase);
            }

        } catch (err: any) {
            console.error(`   Error processing buffer for ${filename}:`, err.message);
        }
    }

    private async sendNotification(
        invoice: InvoiceData,
        matched: boolean,
        poNumber: string | null,
        matchSource: string,
        subject: string,
        from: string,
        isDropship = false,
        pendingDropshipId: string | null = null
    ) {
        let msg = isDropship
            ? `📦 *Dropship Invoice — Forwarded to Bill.com*\n`
            : `🧾 *New Invoice Processed*\n`;
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
            if (!isDropship) msg += `_Searched Finale by vendor name + date_\n`;
        }

        const chatId = process.env.TELEGRAM_CHAT_ID || "";
        if (!matched && pendingDropshipId) {
            this.bot.telegram.sendMessage(chatId, msg, {
                parse_mode: "Markdown",
                ...Markup.inlineKeyboard([
                    [Markup.button.callback("📦 Dropship — Forward to bill.com", `dropship_fwd_${pendingDropshipId}`)],
                    [
                        Markup.button.callback("📋 This Has a PO — Enter PO#", `invoice_has_po_${pendingDropshipId}`),
                        Markup.button.callback("⏭️ Skip", `invoice_skip_${pendingDropshipId}`),
                    ],
                ])
            });
        } else {
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
