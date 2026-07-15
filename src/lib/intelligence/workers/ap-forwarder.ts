import { gmail as GmailApi } from "@googleapis/gmail";
import type { Telegraf } from "telegraf";
import { getAuthenticatedClient } from "../../gmail/auth";
import { createClient } from "../../db";
import { applyMessageLabelPolicy } from "../gmail-policy";
import { APAgent } from "../ap-agent";
import { writeInvoiceSummary } from "../../obsidian/bridge";
import { getLocalDb } from "../../storage/local-db";
import { forwardInvoiceOnce } from "@/lib/intelligence/ap-single-forward";

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

        /**
         * Check local SQLite ap_local_forwards to see if the local forwarder
         * (runLocalApForward) already forwarded this invoice to Bill.com.
         * 
         * The local forwarder runs FIRST in the ap-polling cron. Without this
         * cross-system guard, the Supabase pipeline forwards the same invoice
         * a second time — producing duplicate Bill.com entries ("Fwd: Fwd:" chains).
         *
         * Two-layer dedup:
         *   Layer 1 (hash): When pdfContentHash is available, check ap_local_forwards
         *                    for any FORWARDED record with that hash (no time limit).
         *                    Catches same PDF arriving via different emails/subjects.
         *   Layer 2 (fallback): email_from + email_subject + pdf_filename (exact match)
         *                       within the last 72 hours. Used when hash is unavailable
         *                       (legacy records before pdf_content_hash was populated).
         */
        private isAlreadyForwardedLocally(
            emailFrom: string,
            emailSubject: string,
            pdfFilename: string,
            pdfContentHash?: string,
        ): boolean {
            try {
                const db = getLocalDb();

                // Layer 1: content hash — catches same PDF via different emails/subjects
                if (pdfContentHash) {
                    const byHash = db.prepare(
                        `SELECT 1 FROM ap_local_forwards
                         WHERE pdf_content_hash = ?
                         AND status IN ('FORWARDED', 'CLAIMED', 'PENDING_SEND')`
                    ).get(pdfContentHash);
                    if (byHash) return true;
                }

                // Layer 2: fallback — email + subject + filename within 72 hours
                const row = db.prepare(
                    `SELECT 1 FROM ap_local_forwards
                     WHERE email_from = ? AND email_subject = ? AND pdf_filename = ?
                     AND status IN ('FORWARDED', 'CLAIMED', 'PENDING_SEND')
                     AND forwarded_at > datetime('now', '-72 hours')`
                ).get(emailFrom, emailSubject, pdfFilename);
                return !!row;
            } catch {
                return false; // DB error → assume not forwarded (safe default)
            }
        }

        /**
         * Check billcom_bills_ref table to see if this vendor+invoice already
         * exists in Bill.com. The reference data is imported weekly from the
         * Bill.com CSV export.
         *
         * Uses LOWER() comparison on vendor_name for case-insensitive matching.
         * invoice_number is compared exactly (Bill.com preserves case).
         */
        private isAlreadyInBillCom(fromEmail: string, pdfFilename: string, invoiceNumber?: string, vendorName?: string): boolean {
            try {
                const db = getLocalDb();
                if (invoiceNumber && vendorName) {
                    // Check by vendor + invoice number (strongest match)
                    const row = db.prepare(
                        `SELECT 1 FROM billcom_bills_ref
                         WHERE LOWER(vendor_name) = LOWER(?) AND invoice_number = ?`
                    ).get(vendorName.trim(), invoiceNumber.trim());
                    if (row) return true;
                }
                return false;
            } catch {
                return false;
            }
        }

    private isQueueItemSentToBillCom(relatedItem: any): boolean {
        const sentMessageId = relatedItem.extracted_json?.billcom_sent_message_id;
        return typeof sentMessageId === "string" && sentMessageId.length > 0;
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

        const forwardedCount = relatedItems.filter((relatedItem: any) => this.isQueueItemSentToBillCom(relatedItem)).length;
        const allForwarded = relatedItems.length >= expectedForwardCount
            && forwardedCount >= expectedForwardCount
            && relatedItems.every((relatedItem: any) => this.isQueueItemSentToBillCom(relatedItem));

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
        // Deprecated path — the local-first forwarder (ap-local-forwarder.ts)
        // handles all forwarding via SQLite. This old path uses ap_inbox_queue
        // and is kept only for backward compatibility during transition.
        // Remove entirely once ap-local-forwarder is verified stable.
        if ((process.env.DEPRECATED_FORWARDER_ENABLED ?? "false").toLowerCase() !== "true") {
            console.log("📤 [AP-Forwarder] Skipped (DEPRECATED_FORWARDER_ENABLED != true). Use ap-local-forwarder.");
            return;
        }

        console.log("📤 [AP-Forwarder] Scanning queue for invoices to forward to Bill.com...");
        try {
            const db = createClient();
            if (!db) {
                console.error("   ❌ Supabase client not available.");
                return;
            }

            // HERMIA(2026-06-10): Also retry ERROR_FORWARDING items
            const { data: pendingItems, error: pendingError } = await supabase
                .from('ap_inbox_queue')
                .select('*')
                .eq('status', 'PENDING_FORWARD')
                .limit(10);

            const { data: retryItems, error: retryError } = await supabase
                .from('ap_inbox_queue')
                .select('*')
                .eq('status', 'ERROR_FORWARDING')
                .limit(5);

            if (pendingError) throw pendingError;
            if (retryError) throw retryError;

            const queueItems = [...(pendingItems || []), ...(retryItems || [])];
            if (queueItems.length === 0) {
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
                let billComSendVerified = false;
                const sourceMessageId = this.getSourceMessageId(item) || item.message_id;
                try {
                    // Try to lock the row by updating status to PROCESSING_FORWARD
                    // HERMIA(2026-06-10): Accept both PENDING_FORWARD and ERROR_FORWARDING
                    const { error: lockError, count: lockCount } = await supabase
                        .from('ap_inbox_queue')
                        .update({ status: 'PROCESSING_FORWARD' })
                        .eq('id', item.id)
                        .in('status', ['PENDING_FORWARD', 'ERROR_FORWARDING']);

                    if (lockError) {
                                            console.error(`   ❌ Failed to lock item ${item.id}:`, lockError.message);
                                            continue;
                                        }

                                        // ── Cross-system dedup: check local SQLite ──────────────────
                                        // The local forwarder (ap-local-forwarder.ts) runs FIRST in the
                                        // ap-polling cron. If it already forwarded this invoice, the
                                        // Supabase pipeline must NOT send a duplicate to Bill.com.
                                        const pdfHash = item.pdf_content_hash as string | undefined;
                                        if (
                                            item.email_from &&
                                            item.email_subject &&
                                            item.pdf_filename &&
                                            this.isAlreadyForwardedLocally(item.email_from, item.email_subject, item.pdf_filename, pdfHash)
                                        ) {
                                            const dedupReason = pdfHash
                                                ? `content-hash dedup (${pdfHash.slice(0, 12)}...)`
                                                : 'email+subject+filename dedup';
                                            console.log(`   ⏭️ Already forwarded locally: ${item.pdf_filename} (${dedupReason}) — marking FORWARDED, skip`);
                                            await supabase
                                                .from('ap_inbox_queue')
                                                .update({ status: 'FORWARDED', updated_at: new Date().toISOString() })
                                                .eq('id', item.id);
                                            await this.logActivity(
                                                supabase,
                                                item.email_from,
                                                item.email_subject,
                                                item.intent || 'INVOICE',
                                                `Suppressed duplicate: already forwarded by local pipeline (${item.pdf_filename})`,
                                                { reasonCode: "local_forwarder_dedup", gmailMessageId: sourceMessageId },
                                            );
                                            continue;
                                        }

                    // HERMIA(2026-06-10): Guard against null pdf_filename/pdf_path
                                        // These records were likely created by vendor routing without full PDF
                                        // metadata. Can't forward without a file — mark as error and skip.
                                        if (!item.pdf_filename || !item.pdf_path) {
                                            // HERMIA(2026-06-16): Dropship items from QuickBooks have no PDF to
                                            // forward — they are payment notifications, not invoices. Mark them
                                            // as FORWARDED (graceful completion) instead of ERROR_FORWARDING to
                                            // break the infinite retry loop (forwarder now fetches ERROR_FORWARDING).
                                            if ((item.extracted_json as any)?.vendor_routing_action === "dropship") {
                                                console.log(`     🚚 Dropship (no PDF — notification only): ${item.email_subject?.slice(0, 60)}`);
                                                await supabase
                                                    .from('ap_inbox_queue')
                                                    .update({ status: 'FORWARDED', updated_at: new Date().toISOString() })
                                                    .eq('id', item.id);
                                                await this.logActivity(supabase, item.email_from, item.email_subject, 'DROPSHIP',
                                                    `Dropship notification (QuickBooks) — no PDF to forward, marked complete`, {
                                                        vendor_routing_action: "dropship",
                                                        vendor_name: (item.extracted_json as any)?.vendor_name,
                                                    });
                                                await supabase
                                                    .from('email_inbox_queue')
                                                    .update({ processed_by_ap: true })
                                                    .eq('gmail_message_id', sourceMessageId);
                                                await this.finalizeSourceEmailIfReady(supabase, gmail, {
                                                    gmailMessageId: sourceMessageId,
                                                    addLabels: ["Invoice Forward"],
                                                    expectedForwardCount: (item.extracted_json as any)?.expected_forward_count,
                                                });
                                                continue;
                                            }
                                            // Non-dropship items without PDF — permanent error.
                                            // Set ERROR_FORWARDING but do NOT restore original status
                                            // (that would create an infinite retry loop).
                                            console.warn(`   Skipping ${item.id}: missing pdf_filename or pdf_path (vendor routing record, not a real invoice)`);
                                            await supabase
                                                .from('ap_inbox_queue')
                                                .update({
                                                    status: 'ERROR_FORWARDING',
                                                    updated_at: new Date().toISOString(),
                                                    extracted_json: {
                                                        ...(item.extracted_json || {}),
                                                        permanent_error: true,
                                                        error_reason: 'missing_pdf_metadata',
                                                    },
                                                })
                                                .eq('id', item.id);
                                            continue;
                                                    }

                                                    // Layer 3: Bill.com reference check — does this vendor+invoice already exist?
                                                    const billcomExists = this.isAlreadyInBillCom(
                                                        item.email_from,
                                                        item.pdf_filename,
                                                        item.invoice_number,
                                                        item.vendor_name,
                                                    );
                                                    if (billcomExists) {
                                                        console.log(`   ⏭️ Already in Bill.com: vendor=${item.vendor_name} inv=${item.invoice_number} — skipping forward`);
                                                        await supabase
                                                            .from('ap_inbox_queue')
                                                            .update({ status: 'FORWARDED', updated_at: new Date().toISOString() })
                                                            .eq('id', item.id);
                                                        await this.logActivity(
                                                            supabase,
                                                            item.email_from,
                                                            item.email_subject,
                                                            item.intent || 'INVOICE',
                                                            `Suppressed: already in Bill.com (${item.pdf_filename})`,
                                                            { reasonCode: "billcom_ref_dedup", invoiceNumber: item.invoice_number, vendorName: item.vendor_name },
                                                        );
                                                        continue;
                                                    }

                                            console.log(`   -> Forwarding ${item.pdf_filename} from ${item.email_from} (single-forward gate)`);

                    // Download PDF from local filesystem storage
                    const { downloadPDF } = await import("../../storage/supabase-storage");
                    const fileBuffer = await downloadPDF(item.pdf_path);

                    if (!fileBuffer) {
                        throw new Error(`Failed to download PDF from local storage: ${item.pdf_path}`);
                    }

                    const buffer = fileBuffer;
                    const once = await forwardInvoiceOnce({
                        gmailMessageId: sourceMessageId,
                        emailFrom: item.email_from || '',
                        emailSubject: item.email_subject || '',
                        pdfFilename: item.pdf_filename,
                        pdfBuffer: buffer,
                        vendorName: item.vendor_name || undefined,
                        invoiceNumber: item.invoice_number || undefined,
                        source: 'supabase-forwarder',
                        gmail,
                    });

                    if (once.status === 'already_forwarded') {
                        console.log(`   ⏭️ Single-gate suppressed: ${item.pdf_filename} (${once.reason})`);
                        await supabase
                            .from('ap_inbox_queue')
                            .update({ status: 'FORWARDED', updated_at: new Date().toISOString() })
                            .eq('id', item.id);
                        await this.logActivity(
                            supabase,
                            item.email_from,
                            item.email_subject,
                            item.intent || 'INVOICE',
                            `Suppressed duplicate via single-forward gate (${item.pdf_filename})`,
                            { reasonCode: 'single_forward_dedup', detail: once.reason, gmailMessageId: sourceMessageId },
                        );
                        continue;
                    }
                    if (once.status !== 'forwarded') {
                        throw new Error(once.reason || once.status);
                    }
                    sentMessageId = once.billcomSentMessageId;
                    billComSendVerified = true;

                    const ej = (item.extracted_json || {}) as Record<string, any>;

                    // KAIZEN(2026-06-05): Dropship invoices skip PO matching/reconciliation.
                    // The vendor routing in APIdentifier already classified this as dropship;
                    // we just need to forward the PDF to Bill.com — no OCR, no PO matching.
                    if ((item.extracted_json as any)?.vendor_routing_action === "dropship") {
                        console.log(`     🚚 Dropship (skip PO match): ${item.email_subject?.slice(0, 60)}`);
                        await supabase
                            .from('ap_inbox_queue')
                            .update({ status: 'FORWARDED', updated_at: new Date().toISOString() })
                            .eq('id', item.id);
                        await this.logActivity(supabase, item.email_from, item.email_subject, 'DROPSHIP',
                            `Dropship: forwarded to Bill.com (${item.pdf_filename}), no PO matching`, {
                                vendor_routing_action: "dropship",
                                billcom_sent_message_id: sentMessageId,
                            });
                        await supabase
                            .from('email_inbox_queue')
                            .update({ processed_by_ap: true })
                            .eq('gmail_message_id', sourceMessageId);
                        await this.finalizeSourceEmailIfReady(supabase, gmail, {
                            gmailMessageId: sourceMessageId,
                            addLabels: ["Invoice Forward"],
                            expectedForwardCount: ej.expected_forward_count,
                        });
                        continue;
                    }

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
                    // HERMIA(2026-06-10): If Bill.com received the invoice, mark FORWARDED.
                    // Post-processing failures (OCR, PO match) are logged but don't block
                    // the primary pipeline — the invoice is already at Bill.com.
                    const finalStatus = billComSendVerified ? "FORWARDED" : "ERROR_PROCESSING";
                    await supabase
                        .from('ap_inbox_queue')
                        .update({ status: finalStatus, extracted_json: extractedJson })
                        .eq('id', item.id);

                    // HERMIA(2026-06-10): If Bill.com send verified, always mark the
                    // email as processed — the invoice made it through the critical path.
                    // Post-processing failures are secondary (logged in extracted_json).
                    if (billComSendVerified) {
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
                        if (!processingResult.success) {
                            console.warn(`   ⚠️ Forwarded OK but post-processing failed: ${processingResult.error} — check /aphealth`);
                        }
                    } else {
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

                        // ── Obsidian bridge: write invoice summary to vault ──
                        // Non-blocking, silently caught — vault sync is best-effort.
                        try {
                            const extractedJson = item.extracted_json || {};
                            writeInvoiceSummary({
                                vendorName: extractedJson.vendor_name || item.email_from || "Unknown",
                                invoiceNumber: extractedJson.invoice_number || "unknown",
                                invoiceDate: extractedJson.invoice_date || new Date().toISOString().split("T")[0],
                                dueDate: extractedJson.due_date || null,
                                poNumber: extractedJson.po_number || null,
                                total: Number(extractedJson.total) || 0,
                                subtotal: Number(extractedJson.subtotal) || 0,
                                freight: Number(extractedJson.freight) || 0,
                                tax: Number(extractedJson.tax) || 0,
                                status: "received",
                                lineItemCount: Array.isArray(extractedJson.line_items) ? extractedJson.line_items.length : 0,
                                source: "email_attachment",
                                reconciledAt: null,
                                notes: null,
                            });
                        } catch {
                            // Non-critical — vault sync failure should never block AP pipeline
                        }
                    } else {
                        console.warn(`   ⚠️ Forwarded ${item.pdf_filename}, but downstream invoice processing needs review`);
                    }

                } catch (err: any) {
                    console.error(`   ❌ Forwarding failed for ${item.id}:`, err.message);
                    const failureStatus = billComSendVerified ? 'ERROR_PROCESSING' : 'ERROR_FORWARDING';
                    const failureJson = billComSendVerified
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
                    if (billComSendVerified) {
                        await supabase
                            .from('email_inbox_queue')
                            .update({ processed_by_ap: true })
                            .eq('gmail_message_id', sourceMessageId);
                        await this.finalizeSourceEmailIfReady(
                            supabase,
                            gmail,
                            {
                                ...item,
                                extracted_json: failureJson,
                            },
                        );
                    }
                    await this.logActivity(
                        supabase,
                        item.email_from,
                        item.email_subject,
                        item.intent || 'INVOICE',
                        billComSendVerified
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
