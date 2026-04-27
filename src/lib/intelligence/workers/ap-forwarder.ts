import { gmail as GmailApi } from "@googleapis/gmail";
import type { Telegraf } from "telegraf";
import { getAuthenticatedClient } from "../../gmail/auth";
import { createClient } from "../../supabase";
import { applyMessageLabelPolicy } from "../gmail-policy";
import { APAgent } from "../ap-agent";

/**
 * @file ap-forwarder.ts
 * @purpose Agent 2 of the decoupled AP pipeline (The "Hands").
 *          Polls ap_inbox_queue for PENDING_FORWARD items, downloads the
 *          associated PDF from Storage, constructs a MIME message, and sends
 *          it to buildasoilap@bill.com. Updates status to FORWARDED on success.
 *
 *          Pipeline flow:
 *            AP Identifier → ap_inbox_queue (PENDING_FORWARD)
 *              → AP Forwarder (PROCESSING_FORWARD → FORWARDED / ERROR_FORWARDING)
 *
 *          Status lifecycle:
 *            PENDING_FORWARD → PROCESSING_FORWARD → FORWARDED
 *                                                 → ERROR_FORWARDING (on failure)
 *
 * @author Antigravity / Aria
 * @updated 2026-03-19 — Changed success status from PROCESSED to FORWARDED for
 *          clearer pipeline semantics.
 */
export class APForwarderAgent {
    private invoiceProcessor: APAgent;

    constructor(bot?: Telegraf) {
        const fallbackBot = bot ?? ({
            telegram: {
                sendMessage: async () => undefined,
            },
        } as any);
        this.invoiceProcessor = new APAgent(fallbackBot);
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

    private getSourceMessageId(item: any): string | null {
        const sourceMessageId = item.extracted_json?.source_gmail_message_id;
        if (sourceMessageId) return sourceMessageId;

        const messageId = item.message_id as string | undefined;
        if (!messageId) return null;

        return messageId.split("_split_")[0].split("_")[0] || null;
    }

    private getExpectedForwardCount(item: any): number {
        const expected = Number(item.extracted_json?.expected_forward_count);
        return Number.isFinite(expected) && expected > 0 ? expected : 1;
    }

    private async verifySentMessage(gmail: any, sentMessageId: string): Promise<void> {
        const sentMessage = await gmail.users.messages.get({
            userId: "me",
            id: sentMessageId,
            format: "metadata",
        });
        const labelIds: string[] = sentMessage.data.labelIds || [];
        if (!labelIds.includes("SENT")) {
            throw new Error(`Gmail did not confirm SENT state for ${sentMessageId}`);
        }
    }

    private isQueueItemComplete(relatedItem: any): boolean {
        return relatedItem.status === "FORWARDED"
            && relatedItem.extracted_json?.processing_success === true;
    }

    private async finalizeSourceEmailIfReady(
        supabase: any,
        gmail: any,
        item: any,
    ): Promise<void> {
        const sourceMessageId = this.getSourceMessageId(item);
        if (!sourceMessageId) return;

        const expectedForwardCount = this.getExpectedForwardCount(item);
        const { data: relatedItems, error } = await supabase
            .from("ap_inbox_queue")
            .select("message_id, status, extracted_json")
            .like("message_id", `${sourceMessageId}%`);

        if (error || !relatedItems) {
            throw new Error(`Failed to load related queue items: ${error?.message || "unknown error"}`);
        }

        const forwardedCount = relatedItems.filter((relatedItem: any) => this.isQueueItemComplete(relatedItem)).length;
        const allForwarded = relatedItems.length >= expectedForwardCount
            && forwardedCount >= expectedForwardCount
            && relatedItems.every((relatedItem: any) => this.isQueueItemComplete(relatedItem));

        if (!allForwarded) {
            return;
        }

        await applyMessageLabelPolicy({
            gmail,
            gmailMessageId: sourceMessageId,
            addLabels: ["Invoice Forward"],
            removeLabels: ["INBOX", "UNREAD"],
        });
    }

    async processPendingForwards() {
        console.log("📤 [AP-Forwarder] Scanning queue for invoices to forward to Bill.com...");
        try {
            const supabase = createClient();
            if (!supabase) {
                console.error("   ❌ Supabase client not available.");
                return;
            }

            const { data: queueItems, error } = await supabase
                .from('ap_inbox_queue')
                .select('*')
                .eq('status', 'PENDING_FORWARD')
                .limit(10);

            if (error) throw error;

            if (!queueItems || queueItems.length === 0) {
                return;
            }

            console.log(`   Found ${queueItems.length} invoice(s) pending forward.`);

            let auth;
            try {
                auth = await getAuthenticatedClient("ap");
            } catch (err: any) {
                console.warn("   ⚠️ Missing 'ap' token, falling back to 'default'...");
                auth = await getAuthenticatedClient("default");
            }
                const gmail = GmailApi({ version: "v1", auth });

            for (const item of queueItems) {
                let sentMessageId: string | null = null;
                const sourceMessageId = this.getSourceMessageId(item) || item.message_id;
                try {
                    // Try to lock the row by updating status to PROCESSING_FORWARD
                    const { error: lockError } = await supabase
                        .from('ap_inbox_queue')
                        .update({ status: 'PROCESSING_FORWARD' })
                        .eq('id', item.id)
                        .eq('status', 'PENDING_FORWARD');

                    if (lockError) {
                        console.error(`   ❌ Failed to lock item ${item.id}:`, lockError.message);
                        continue;
                    }

                    console.log(`   -> Forwarding ${item.pdf_filename} from ${item.email_from}`);

                    // Download PDF from Supabase Storage
                    const { data: fileData, error: downloadError } = await supabase.storage
                        .from('ap_invoices')
                        .download(item.pdf_path);

                    if (downloadError || !fileData) {
                        throw new Error(`Failed to download PDF from storage: ${downloadError?.message}`);
                    }

                    const buffer = Buffer.from(await fileData.arrayBuffer());
                    const rawBase64 = buffer.toString('base64');
                    // RFC 2045 requires base64 to be split into lines no longer than 76 characters.
                    const chunkedBase64 = rawBase64.match(/.{1,76}/g)?.join("\r\n") || rawBase64;

                    const boundary = "b_aria_fwd_" + Math.random().toString(36).substring(2);

                    const mimeMessage = [
                        `To: buildasoilap@bill.com`,
                        `Subject: Fwd: ${item.email_subject}`,
                        `MIME-Version: 1.0`,
                        `Content-Type: multipart/mixed; boundary="${boundary}"`,
                        ``,
                        `--${boundary}`,
                        `Content-Type: text/plain; charset="UTF-8"`,
                        ``,
                        `Forwarded invoice.`,
                        ``,
                        `--${boundary}`,
                        `Content-Type: application/pdf; name="${item.pdf_filename}"`,
                        `Content-Transfer-Encoding: base64`,
                        `Content-Disposition: attachment; filename="${item.pdf_filename}"`,
                        ``,
                        chunkedBase64,
                        `--${boundary}--`
                    ].join("\r\n");

                    const sendResult = await gmail.users.messages.send({
                        userId: "me",
                        requestBody: { raw: Buffer.from(mimeMessage).toString("base64url") }
                    });
                    sentMessageId = sendResult.data.id || null;
                    if (!sentMessageId) {
                        throw new Error(`Gmail send did not return a sent message id for ${item.id}`);
                    }
                    await this.verifySentMessage(gmail, sentMessageId);

                    const sendExtractedJson = {
                        ...(item.extracted_json || {}),
                        billcom_sent_message_id: sentMessageId,
                        billcom_sent_at: new Date().toISOString(),
                    };
                    const processingResult = await this.invoiceProcessor.processInvoiceBuffer(
                        buffer,
                        item.pdf_filename,
                        item.email_subject,
                        item.email_from,
                        supabase,
                        false,
                        sourceMessageId,
                        item.pdf_path,
                    );
                    const extractedJson = {
                        ...sendExtractedJson,
                        processing_success: processingResult.success,
                        processing_state: processingResult.state,
                        processing_error: processingResult.error || null,
                        reconciliation_verdict: processingResult.reconciliationVerdict || null,
                        matched_po: processingResult.matchedPO,
                        matched_po_number: processingResult.poNumber || null,
                        processed_invoice_number: processingResult.invoiceNumber || null,
                    };
                    const finalStatus = processingResult.success ? "FORWARDED" : "ERROR_PROCESSING";
                    await supabase
                        .from('ap_inbox_queue')
                        .update({ status: finalStatus, extracted_json: extractedJson })
                        .eq('id', item.id);

                    if (!processingResult.success) {
                        await supabase
                            .from('email_inbox_queue')
                            .update({ processed_by_ap: false })
                            .eq('gmail_message_id', sourceMessageId);
                    } else {
                        await supabase
                            .from('email_inbox_queue')
                            .update({ processed_by_ap: true })
                            .eq('gmail_message_id', sourceMessageId);
                        await this.finalizeSourceEmailIfReady(
                            supabase,
                            gmail,
                            {
                                ...item,
                                extracted_json: extractedJson,
                            },
                        );
                    }

                    await this.logActivity(
                        supabase,
                        item.email_from,
                        item.email_subject,
                        item.intent || 'INVOICE',
                        processingResult.success
                            ? `Forwarded to Bill.com + processed invoice: ${item.pdf_filename}`
                            : `Forwarded to Bill.com but invoice processing needs review: ${item.pdf_filename}`,
                        {
                            sentMessageId,
                            sourceMessageId,
                            processingState: processingResult.state,
                            processingError: processingResult.error || null,
                            reconciliationVerdict: processingResult.reconciliationVerdict || null,
                        },
                    );

                    if (processingResult.success) {
                        console.log(`   ✅ Successfully forwarded and processed ${item.pdf_filename}`);
                    } else {
                        console.warn(`   ⚠️ Forwarded ${item.pdf_filename}, but downstream invoice processing needs review`);
                    }

                } catch (err: any) {
                    console.error(`   ❌ Forwarding failed for ${item.id}:`, err.message);
                    const failureStatus = sentMessageId ? 'ERROR_PROCESSING' : 'ERROR_FORWARDING';
                    const failureJson = sentMessageId
                        ? {
                            ...(item.extracted_json || {}),
                            billcom_sent_message_id: sentMessageId,
                            billcom_sent_at: new Date().toISOString(),
                            processing_success: false,
                            processing_state: 'processing_error',
                            processing_error: err.message,
                        }
                        : undefined;
                    await supabase
                        .from('ap_inbox_queue')
                        .update(
                            failureJson
                                ? { status: failureStatus, extracted_json: failureJson }
                                : { status: failureStatus }
                        )
                        .eq('id', item.id);
                    if (sentMessageId) {
                        const sourceMessageId = this.getSourceMessageId(item) || item.message_id;
                        await supabase
                            .from('email_inbox_queue')
                            .update({ processed_by_ap: false })
                            .eq('gmail_message_id', sourceMessageId);
                    }
                    await this.logActivity(
                        supabase,
                        item.email_from,
                        item.email_subject,
                        item.intent || 'INVOICE',
                        sentMessageId
                            ? `Error after Bill.com forward: ${err.message}`
                            : `Error forwarding to Bill.com: ${err.message}`
                    );
                }
            }
        } catch (err: any) {
            console.error("❌ [AP-Forwarder] Critical Error:", err.message);
        }
    }
}
