import { google } from "googleapis";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { Telegraf } from "telegraf";
import { WebClient } from "@slack/web-api";
import { extractPDF } from "../pdf/extractor";
import { parseInvoice, InvoiceData } from "../pdf/invoice-parser";
import { matchInvoiceToPO, MatchResult } from "../matching/invoice-po-matcher";
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
                    continue;
                }

                if (intent === "HUMAN_INTERACTION") {
                    // We just leave it unread in the inbox so the user is forced to engage.
                    continue;
                }

                // --- INVOICE PROCESSING ---
                let processedAnyPDF = false;
                const parts = payload?.parts || [];
                const pdfParts = parts.filter((p: any) => p.mimeType === "application/pdf" && p.filename);

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

                            // 1. Process Database & Extraction matching
                            const buffer = Buffer.from(base64Data, "base64");
                            await this.processInvoiceBuffer(buffer, part.filename!, subject, from, supabase);

                            // 2. Forward strictly to buildasoilap@bill.com
                            await this.forwardToBillCom(gmail, subject, part.filename!, base64Data);
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
                } else {
                    // It was classified as an Invoice but had no PDF, so leave unread for human interaction.
                    console.log(`     ⚠️ No PDF found on INVOICE. Leaving unread for human check.`);
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
}
