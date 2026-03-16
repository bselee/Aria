/**
 * @file    inline-invoice-handler.ts
 * @purpose Orchestrator for tracking inline email invoices without PDF attachments
 * @author  Will
 * @created 2026-03-12
 * @updated 2026-03-12
 */

import { generateInvoicePDF } from '../pdf/invoice-generator';
import { parseInlineInvoice, detectInlineInvoice } from './inline-invoice-parser';
import { finaleClient } from '../finale/client';
import { getAuthenticatedClient } from '../gmail/auth';
import { gmail as GmailApi } from '@googleapis/gmail';
import { createClient } from '../supabase';
import type { Telegraf, Context } from 'telegraf';
import { randomUUID } from 'crypto';

const supabase = createClient();

export class InlineInvoiceHandler {
    constructor(private readonly bot: Telegraf<Context>) { }

    /**
     * Processes an email body looking for inline invoice data.
     * Generates a PDF, forwards to Bill.com, and replies to the vendor.
     * 
     * @returns { processed: boolean, logs: string[] }
     */
    async process(
        bodyText: string,
        subject: string,
        fromEmail: string,
        messageId: string,
        threadId: string,
        hasPdfAttachment: boolean
    ): Promise<{ processed: boolean; logs: string[] }> {
        const logs: string[] = [];

        try {
            // Gate 1: Heuristic Detection
            if (!detectInlineInvoice(bodyText, hasPdfAttachment, subject)) {
                logs.push("Skipped: No inline invoice patterns detected.");
                return { processed: false, logs };
            }

            // Gate 2: LLM Extraction
            logs.push("Detected potential inline invoice. Extracting data via LLM...");
            const invoiceData = await parseInlineInvoice(bodyText, subject, fromEmail);

            if (invoiceData.confidence === 'low' && invoiceData.total === 0) {
                logs.push("Skipped: LLM could not extract valid invoice data (confidence low, total 0).");
                return { processed: false, logs };
            }

            logs.push(`Extracted invoice data: ${invoiceData.invoiceNumber || 'UNKNOWN'} for ${invoiceData.vendorName} - Total $${invoiceData.total || invoiceData.amountDue}`);

            // 3. Optional: PO Cross-Reference
            let finalPoNumber = invoiceData.poNumber || null;
            if (finalPoNumber) {
                logs.push(`Cross-referencing PO #${finalPoNumber} in Finale...`);
                try {
                    const poSummary = await finaleClient.getOrderSummary(finalPoNumber);
                    if (poSummary) {
                        logs.push(`✔️ Found matching PO in Finale.`);
                    } else {
                        logs.push(`⚠️ PO #${finalPoNumber} not found in Finale.`);
                    }
                } catch (e: any) {
                    logs.push(`⚠️ Error checking PO in Finale: ${e.message}`);
                }
            } else {
                logs.push(`No PO number extracted to cross-reference.`);
            }

            // 4. Generate PDF
            logs.push(`Generating formal Vendor PDF invoice...`);
            const pdfBuffer = await generateInvoicePDF(invoiceData);
            const pdfFilename = `Inline_Invoice_${invoiceData.vendorName.replace(/[^a-z0-9]/gi, '_')}.pdf`;

            // 5. Forward to Bill.com
            logs.push(`Forwarding PDF to Bill.com...`);
            const billComEmail = process.env.BILL_COM_EMAIL || 'buildasoilap@bill.com';
            
            const rawMessage = this.createMimeMessageWithAttachment(
                billComEmail,
                `Fwd: ${subject}`,
                `Forwarded inline invoice encoded from email body by Aria.`,
                pdfFilename,
                pdfBuffer
            );
            
            await this.sendRawEmail(rawMessage, 'ap');
            logs.push(`✔️ Successfully sent to ${billComEmail}`);

            // 6. DB Activity Logging (invoices, ap_activity_log)
            const internalId = randomUUID();
            await supabase.from('invoices').insert([{
                id: internalId,
                vendor_name: invoiceData.vendorName,
                invoice_number: invoiceData.invoiceNumber !== 'UNKNOWN' ? invoiceData.invoiceNumber : `IG-${Date.now()}`,
                po_number: finalPoNumber,
                amount: invoiceData.total || invoiceData.amountDue || 0,
                status: 'forwarded_to_bill_com',
                source_email: fromEmail,
                source_thread_id: threadId,
                created_at: new Date().toISOString()
            }]);

            await supabase.from('ap_activity_log').insert([{
                vendor_name: invoiceData.vendorName,
                activity_type: 'invoice_forwarded',
                description: `Forwarded generated inline invoice PDF for ${invoiceData.vendorName} total $${invoiceData.total || invoiceData.amountDue}.`,
                details: { type: 'inline_pdf_generation', success: true }
            }]);

            // 7. Auto-reply to vendor
            logs.push(`Replying to vendor...`);
            const replyMessage = this.createReplyMimeMessage(
                fromEmail,
                `Re: ${subject}`,
                `Got it, thank you! The invoice details have been routed to our AP team for processing.`,
                messageId,
                threadId
            );
            await this.sendRawEmail(replyMessage, 'ap');

            // 8. Output to Telegram Notification
            const telegramMsg = `\uD83D\uDCE7 **Inline Invoice Handled**\n\n` +
                `**Vendor:** ${invoiceData.vendorName}\n` +
                `**Total:** $${invoiceData.total || invoiceData.amountDue}\n` +
                `**PO:** ${finalPoNumber || 'None'}\n\n` +
                `Generated PDF and forwarded to Bill.com.\nAuto-replied to vendor.`;
                
            if (process.env.TELEGRAM_CHAT_ID) {
                await this.bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, telegramMsg, { parse_mode: 'Markdown' }).catch(console.error);
            }

            return { processed: true, logs };

        } catch (e: any) {
            logs.push(`❌ Error processing inline invoice: ${e.message}`);
            console.error('[InlineInvoiceHandler] ERROR: ', e);
             
            if (process.env.TELEGRAM_CHAT_ID) {
                await this.bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `❌ **Aria Inline Invoice Error**\n\nFailed to process inline invoice from ${fromEmail}: ${e.message}`, { parse_mode: 'Markdown' }).catch(console.error);
            }
            return { processed: false, logs };
        }
    }

    private createMimeMessageWithAttachment(to: string, subject: string, text: string, filename: string, buffer: Buffer): string {
        const boundary = 'AriaBoundaryString' + Math.random().toString(36).substring(2);
        
        let message = `To: ${to}\r\n`;
        message += `Subject: ${subject}\r\n`;
        message += `MIME-Version: 1.0\r\n`;
        message += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
        
        // Text body
        message += `--${boundary}\r\n`;
        message += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
        message += `${text}\r\n\r\n`;
        
        // PDF Attachment
        message += `--${boundary}\r\n`;
        message += `Content-Type: application/pdf; name="${filename}"\r\n`;
        message += `Content-Disposition: attachment; filename="${filename}"\r\n`;
        message += `Content-Transfer-Encoding: base64\r\n\r\n`;
        message += `${buffer.toString('base64')}\r\n\r\n`;
        
        message += `--${boundary}--\r\n`;
        
        return message;
    }

    private createReplyMimeMessage(to: string, subject: string, text: string, inReplyTo: string, threadId: string): string {
        let message = `To: ${to}\r\n`;
        message += `Subject: ${subject}\r\n`;
        message += `In-Reply-To: ${inReplyTo}\r\n`;
        message += `References: ${inReplyTo}\r\n`;
        message += `MIME-Version: 1.0\r\n`;
        message += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
        message += `${text}`;
        
        return message;
    }

    private async sendRawEmail(rawMessage: string, inboxKey: string): Promise<void> {
        try {
            const auth = await getAuthenticatedClient(inboxKey);
            const gmail = GmailApi({ version: "v1", auth });
            
            await gmail.users.messages.send({
                userId: "me",
                requestBody: {
                    raw: Buffer.from(rawMessage).toString("base64url")
                }
            });
        } catch (e: any) {
             console.error(`[InlineInvoiceHandler] Failed to send email via ${inboxKey}: ${e.message}`);
             throw e;
        }
    }
}
