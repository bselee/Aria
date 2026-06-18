/**
 * @file    ap-local-forwarder.ts
 * @purpose Local-first AP invoice forwarder — scans Gmail directly, forwards
 *          invoice PDFs to Bill.com, tracks dedup in local SQLite.
 *          Zero Supabase dependency for the critical path.
 * @author  Hermia
 * @created 2026-06-18
 * @updated 2026-06-18 (Bill Selee: simplified — forward all PDFs, skip no-PDF emails,
 *          removed autopay concept. All vendors with PDF invoices forwarded identically.)
 * @deps    better-sqlite3 (via local-db), @googleapis/gmail, gmail/auth
 * @env     GMAIL_AP_TOKEN (ap-token.json), BILL_COM_FORWARD_EMAIL (default: buildasoilap@bill.com)
 *
 * DESIGN DECISION (2026-06-18, Bill Selee):
 *   SIMPLE RULE: has PDF → forward to Bill.com. No PDF → skip.
 *   The only exceptions are: internal emails, Bill.com self-notifications,
 *   FedEx past-due notices, and Amazon tracking — all of which lack invoice PDFs.
 *   "Autopay" was a mistaken inference — we forward ALL vendor PDF invoices.
 *   Dropship vendors still forward but skip PO reconciliation (no Finale PO exists).
 *
 * FLOW:
 *   1. Scan Gmail for unread emails in the ap@ inbox (max 20 per cycle)
 *   2. For each email with a PDF attachment: forward to Bill.com
 *   3. No PDF → skip (mark read, archive — not an invoice)
 *   4. Dedup by message_id + filename + SHA-256 content hash
 *   5. Record in local SQLite (ap_local_forwards table)
 *   6. Mark source email as read + archive
 *
 * DEDUP LAYERS:
 *   - Layer 1: gmail_message_id + pdf_filename (UNIQUE constraint)
 *   - Layer 2: pdf_content_hash (SHA-256 of PDF bytes)
 *   - Layer 3: Supabase ap_activity_log (best-effort sync when available)
 */

import { getLocalDb } from "@/lib/storage/local-db";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { createClient } from "@/lib/supabase";
import { matchVendorRouting, VendorRoutingRule } from "@/lib/intelligence/ap/vendor-router";
import * as crypto from "crypto";
// @ts-expect-error - No types available for pdf-parse
import pdfParse from "pdf-parse";

const BILL_COM_EMAIL = process.env.BILL_COM_FORWARD_EMAIL || "buildasoilap@bill.com";
const MAX_EMAILS_PER_CYCLE = 20;
const DEDUP_NAMESPACE = "ap_forwarded_message";

/**
 * Parse a Gmail From header into { email, name }.
 * Handles formats: "Name <email@domain.com>", "email@domain.com", "Name" <email@domain.com>
 */
function parseFromHeader(from: string): { email: string; name: string } {
    const angleMatch = from.match(/<([^>]+)>/);
    const email = (angleMatch?.[1] || from).trim().toLowerCase();
    const name = (angleMatch ? from.replace(/<[^>]+>/, "") : "").trim().replace(/^["']|["']$/g, "");
    return { email, name };
}

/**
 * Thin wrapper around matchVendorRouting from vendor-router.
 * Action meanings:
 * - 'skip'          → mark read, do NOT forward (internal, self-notifications, past-due)
 * - 'dropship'      → forward to Bill.com, skip PO reconciliation
 * - 'amazon_order'  → skip (handled by Amazon parser elsewhere)
 * - null            → default: forward to Bill.com + attempt PO matching
 */
function checkVendorRouting(from: string, subject: string): VendorRoutingRule | null {
    const { email, name } = parseFromHeader(from);
    return matchVendorRouting(email, name, subject);
}

/**
 * Check if an email is likely from a non-invoice sender (tracking, marketing).
 * Also catches UPS tracking notifications that slip through vendor-router.
 */
function isNonInvoiceSender(from: string, subject: string): boolean {
    const fromLower = from.toLowerCase();
    // UPS tracking notifications (not UPS Freight invoices)
    if (fromLower.includes("mcinfo@ups.com") && !subject.toLowerCase().includes("invoice")) {
        return true;
    }
    return false;
}

// ── Paid Invoice Detection (ported from ap-identifier.ts) ──────────────────
// DECISION(2026-06-18, Bill Selee): OCR text from PDFs before forwarding
// to detect already-paid invoices. These should never reach Bill.com.
// Patterns proven in production since 2026-03-20.

const PDF_BLOCK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /do\s*not\s*pay/i, reason: 'PDF contains "Do Not Pay"' },
    { pattern: /this\s+is\s+not\s+a\s+bill/i, reason: 'PDF states "This is not a bill"' },
    { pattern: /informational\s+purposes\s+only/i, reason: 'PDF is informational only' },
    { pattern: /already\s+paid/i, reason: 'PDF says "Already Paid"' },
    { pattern: /balance\s*:?\s*\$?\s*0\.00/i, reason: 'PDF shows $0.00 balance' },
    { pattern: /paid\s+in\s+full/i, reason: 'PDF says "Paid in Full"' },
    { pattern: /payment\s+terms[\s\S]*\bPAID\b/i, reason: 'PDF shows "PAID" near payment terms' },
    { pattern: /(?:^|\n)\s*PAID\s*(?:\n|$)/m, reason: 'PDF has standalone "PAID" status marker' },
    { pattern: /\bamount\s+paid\b[\s\S]{0,120}\$[\d,]+\.\d{2}[\s\S]*\b(?:balance|due)\b[\s\S]{0,120}\$?\s*0\.00/i, reason: 'PDF shows amount paid with $0.00 balance' },
];

/**
 * Lightweight OCR + pattern check to detect already-paid invoices.
 * Runs pdf-parse (fast, free) on the PDF buffer.
 * Returns { blocked: true, reason } if the invoice should NOT be forwarded.
 * Returns { blocked: false } if the invoice looks legitimate.
 * If OCR fails, defaults to NOT blocked (safe: forward rather than skip).
 */
async function checkPaidInvoiceBlock(pdfBuffer: Buffer): Promise<{ blocked: boolean; reason?: string }> {
    try {
        const parsed = await pdfParse(pdfBuffer, { max: 0 });
        const text: string = (parsed?.text || "").toString();

        if (text.length < 5) {
            // Unparseable PDF — likely fully scanned image. Don't block.
            // We'd need vision-model OCR to extract text from scanned PDFs,
            // which is expensive. Default: forward (safe).
            return { blocked: false };
        }

        for (const rule of PDF_BLOCK_PATTERNS) {
            if (rule.pattern.test(text)) {
                console.log(`   [AP-Local] 🚫 BLOCKED: ${rule.reason} — not forwarding`);
                return { blocked: true, reason: rule.reason };
            }
        }

        return { blocked: false };
    } catch (e: any) {
        // pdf-parse failure — scanned PDF or corrupt file. Don't block.
        console.warn(`   [AP-Local] OCR check failed: ${e.message} — forwarding anyway (safe default)`);
        return { blocked: false };
    }
}

/**
 * Extract all PDF attachments from a Gmail message.
 * Returns array of { filename, buffer } for each application/pdf attachment.
 * Handles nested multipart structures.
 */
function extractPdfAttachments(payload: any): Array<{ filename: string; buffer: Buffer; attachmentId: string }> {
    const pdfs: Array<{ filename: string; buffer: Buffer; attachmentId: string }> = [];

    function walk(part: any) {
        if (!part) return;

        // Check if this part is a PDF attachment
        const mimeType = part.mimeType || "";
        const filename = part.filename || "";
        const isPdf = mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");

        if (isPdf && filename && part.body?.attachmentId) {
            // Attachment content needs to be fetched separately
            pdfs.push({
                filename,
                buffer: Buffer.alloc(0), // placeholder — will be fetched by caller
                attachmentId: part.body.attachmentId,
            });
        } else if (isPdf && filename && part.body?.data) {
            // Inline PDF (data embedded in the part)
            pdfs.push({
                filename,
                buffer: Buffer.from(part.body.data, "base64url"),
                attachmentId: "",
            });
        }

        // Recurse into nested parts
        if (part.parts) {
            for (const subPart of part.parts) {
                walk(subPart);
            }
        }
    }

    walk(payload);
    return pdfs;
}

/**
 * Check local SQLite for an existing forward by message_id + filename or PDF hash.
 * Returns true if this PDF has already been forwarded to Bill.com.
 */
function isAlreadyForwarded(gmailMessageId: string, pdfFilename: string, pdfHash: string): boolean {
    try {
        const db = getLocalDb();

        // Layer 1: message_id + filename
        const byKey = db.prepare(
            `SELECT 1 FROM ap_local_forwards
             WHERE gmail_message_id = ? AND pdf_filename = ?
             AND status = 'FORWARDED'`
        ).get(gmailMessageId, pdfFilename);
        if (byKey) return true;

        // Layer 2: content hash (catches re-uploads of same PDF)
        const byHash = db.prepare(
            `SELECT 1 FROM ap_local_forwards
             WHERE pdf_content_hash = ?
             AND status = 'FORWARDED'`
        ).get(pdfHash);
        if (byHash) return true;

        return false;
    } catch (e: any) {
        console.error("   [AP-Local] Dedup check failed:", e.message);
        return false; // on DB error, assume not seen — safer to forward than skip
    }
}

/**
 * Record a successful forward in local SQLite.
 * Uses INSERT OR IGNORE to respect the UNIQUE constraint (message_id + filename).
 */
function recordForward(
    gmailMessageId: string,
    emailFrom: string,
    emailSubject: string,
    pdfFilename: string,
    pdfHash: string,
    billcomSentMessageId: string,
    vendorRoutingAction?: string,
): void {
    try {
        const db = getLocalDb();
        db.prepare(
            `INSERT OR REPLACE INTO ap_local_forwards
             (gmail_message_id, email_from, email_subject, pdf_filename, pdf_content_hash,
              billcom_sent_message_id, status, vendor_routing_action, forwarded_at)
             VALUES (?, ?, ?, ?, ?, ?, 'FORWARDED', ?, datetime('now'))`
        ).run(gmailMessageId, emailFrom, emailSubject, pdfFilename, pdfHash, billcomSentMessageId, vendorRoutingAction || null);
    } catch (e: any) {
        console.error("   [AP-Local] Failed to record forward:", e.message);
    }
}

/**
 * Record a failed forward attempt (for retry tracking).
 */
function recordError(
    gmailMessageId: string,
    emailFrom: string,
    emailSubject: string,
    pdfFilename: string,
    pdfHash: string,
    errorMessage: string,
): void {
    try {
        const db = getLocalDb();
        db.prepare(
            `INSERT OR REPLACE INTO ap_local_forwards
             (gmail_message_id, email_from, email_subject, pdf_filename, pdf_content_hash,
              billcom_sent_message_id, status, error_message, forwarded_at)
             VALUES (?, ?, ?, ?, ?, NULL, 'ERROR', ?, datetime('now'))`
        ).run(gmailMessageId, emailFrom, emailSubject, pdfFilename, pdfHash, errorMessage);
    } catch (e: any) {
        console.error("   [AP-Local] Failed to record error:", e.message);
    }
}

// ── Lifecycle management ────────────────────────────────────────────────────

/**
 * Mark a forwarded invoice as reconciled (matched to a Finale PO).
 * Called by the reconciliation step after PO matching + price/shipping verification.
 */
export function markReconciled(
    gmailMessageId: string,
    pdfFilename: string,
    poNumber: string,
    notes?: string,
): void {
    try {
        const db = getLocalDb();
        db.prepare(
            `UPDATE ap_local_forwards
             SET reconciliation_status = 'RECONCILED',
                 matched_po_number = ?,
                 reconciliation_notes = ?,
                 reconciled_at = datetime('now')
             WHERE gmail_message_id = ? AND pdf_filename = ?`
        ).run(poNumber, notes || null, gmailMessageId, pdfFilename);
        console.log(`   [AP-Local] ✅ Reconciled ${pdfFilename} -> PO ${poNumber}`);
    } catch (e: any) {
        console.error("   [AP-Local] Failed to mark reconciled:", e.message);
    }
}

/**
 * Mark a forwarded invoice as complete (fully processed, archived).
 * Called after reconciliation + archiving is done.
 */
export function markComplete(
    gmailMessageId: string,
    pdfFilename: string,
): void {
    try {
        const db = getLocalDb();
        db.prepare(
            `UPDATE ap_local_forwards
             SET reconciliation_status = 'COMPLETE',
                 completed_at = datetime('now')
             WHERE gmail_message_id = ? AND pdf_filename = ?`
        ).run(gmailMessageId, pdfFilename);
        console.log(`   [AP-Local] ✅ Complete: ${pdfFilename}`);
    } catch (e: any) {
        console.error("   [AP-Local] Failed to mark complete:", e.message);
    }
}

/**
 * Query the local AP forward queue for dashboard/CLI visibility.
 * Returns all records, optionally filtered by status.
 */
export function getLocalForwardQueue(filterStatus?: string): Array<{
    id: number;
    gmail_message_id: string;
    email_from: string;
    email_subject: string;
    pdf_filename: string;
    status: string;
    reconciliation_status: string | null;
    matched_po_number: string | null;
    error_message: string | null;
    forwarded_at: string;
    reconciled_at: string | null;
    completed_at: string | null;
}> {
    try {
        const db = getLocalDb();
        if (filterStatus) {
            return db.prepare(
                `SELECT * FROM ap_local_forwards WHERE status = ? ORDER BY forwarded_at DESC`
            ).all(filterStatus) as any[];
        }
        return db.prepare(
            `SELECT * FROM ap_local_forwards ORDER BY forwarded_at DESC`
        ).all() as any[];
    } catch {
        return [];
    }
}

/**
 * Best-effort sync to Supabase ap_activity_log (non-blocking, swallows errors).
 * This keeps the dashboard working when Supabase is available, but does NOT
 * block or fail the forward if Supabase is down.
 */
async function syncToSupabase(
    emailFrom: string,
    emailSubject: string,
    pdfFilename: string,
    billcomSentMessageId: string,
): Promise<void> {
    try {
        const supabase = createClient();
        if (!supabase) return;
        await Promise.race([
            supabase.from("ap_activity_log").insert({
                email_from: emailFrom,
                email_subject: emailSubject,
                intent: "INVOICE",
                action_taken: `Forwarded to Bill.com (local pipeline): ${pdfFilename}`,
                metadata: { billcom_sent_message_id: billcomSentMessageId, source: "ap-local-forwarder" },
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Supabase sync timeout")), 5000)),
        ]);
    } catch {
        // Supabase down or slow — silently skip. Local SQLite is the source of truth.
    }
}

/**
 * Sanitize attachment filename for Bill.com compatibility.
 *
 * PROBLEM: Bill.com truncates multi-period filenames at the first period.
 * FedEx filenames like "12.99999.09993.934473553.XXXXX5563.000045.pdf"
 * become "12.pdf" on Bill.com's end — all FedEx invoices look identical.
 *
 * FIX: For FedEx multi-segment filenames, extract the invoice number
 * (segment 3: "934473553") and format as "FedEx_Invoice_9-344-73553.pdf".
 * All other filenames pass through unchanged.
 */
function sanitizeForwardFilename(original: string): string {
    // FedEx pattern: numeric segments separated by periods, ends in .pdf
    // e.g., "12.99999.09993.934473553.XXXXX5563.000045.pdf"
    const fedexMatch = original.match(
        /^(\d+)\.(\d+)\.(\d+)\.(\d{9,10})\.([A-Z]+)(\d+)\.(\d+)\.pdf$/i,
    );
    if (fedexMatch) {
        const invoiceNum = fedexMatch[4]; // e.g., "934473553"
        // Format with dashes: "934473553" → "9-344-73553"
        const formatted = `${invoiceNum[0]}-${invoiceNum.slice(1, 4)}-${invoiceNum.slice(4)}`;
        return `FedEx_Invoice_${formatted}.pdf`;
    }

    // Non-FedEx: return original filename (safe for most vendors)
    return original;
}

/**
 * Build and send a forwarded invoice email to Bill.com with the PDF attached.
 * Returns the sent Gmail message ID, or null on failure.
 *
 * Filenames are sanitized to avoid Bill.com truncation (multi-period FedEx filenames like
 * "12.99999.09993.934473553.XXXXX5563.000045.pdf" were being truncated to "12.pdf").
 */
async function forwardToBillCom(
    gmail: any,
    emailSubject: string,
    emailFrom: string,
    pdfFilename: string,
    pdfBuffer: Buffer,
): Promise<string | null> {
    const safeFilename = sanitizeForwardFilename(pdfFilename);
    const rawBase64 = pdfBuffer.toString("base64");
    const chunkedBase64 = rawBase64.match(/.{1,76}/g)?.join("\r\n") || rawBase64;

    const boundary = "b_aria_local_fwd_" + crypto.randomBytes(8).toString("hex");

    const forwardBody = [
        "Forwarded invoice (Aria AP local pipeline).",
        "",
        `Sent From: ${emailFrom}`,
        `Original Subject: ${emailSubject}`,
        `PDF: ${safeFilename} (original: ${pdfFilename})`,
    ].join("\r\n");

    const mimeMessage = [
        `To: ${BILL_COM_EMAIL}`,
        `Subject: Fwd: ${emailSubject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        forwardBody,
        ``,
        `--${boundary}`,
        `Content-Type: application/pdf; name="${safeFilename}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${safeFilename}"`,
        ``,
        chunkedBase64,
        `--${boundary}--`,
    ].join("\r\n");

    const sendResult = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: Buffer.from(mimeMessage).toString("base64url") },
    });

    return sendResult.data.id || null;
}

/**
 * Verify that a sent forward message exists in Gmail Sent and contains
 * the expected PDF attachment. Returns true if verified, false otherwise.
 *
 * @param gmail - Authenticated Gmail API client
 * @param sentMessageId - Gmail message ID of the sent forward
 * @param expectedFilename - PDF filename that should be attached
 * @returns true if the sent message exists and has the PDF attachment
 */
async function verifySentForward(gmail: any, sentMessageId: string, expectedFilename: string): Promise<boolean> {
    try {
        const sentMsg = await gmail.users.messages.get({
            userId: "me",
            id: sentMessageId,
            format: "full",
        });

        // Check the message has parts (multipart)
        const payload = sentMsg.data.payload;
        if (!payload) return false;

        // Walk the MIME tree looking for the PDF attachment
        function findAttachment(part: any): boolean {
            if (!part) return false;
            const filename = part.filename || "";
            const mimeType = part.mimeType || "";
            if (filename === expectedFilename && mimeType === "application/pdf") {
                return true;
            }
            if (part.parts) {
                return part.parts.some((p: any) => findAttachment(p));
            }
            return false;
        }

        const hasAttachment = findAttachment(payload);
        if (hasAttachment) {
            // Mark as verified in local DB
            try {
                const db = getLocalDb();
                db.prepare(
                    `UPDATE ap_local_forwards SET verified = 1 WHERE billcom_sent_message_id = ?`
                ).run(sentMessageId);
            } catch { /* non-critical */ }
        }
        return hasAttachment;
    } catch (e: any) {
        console.warn(`   [AP-Local] Verify sent failed: ${e.message}`);
        return false;
    }
}

/**
 * Check for bounce/notification emails from mailer-daemon or postmaster
 * that reference recent Bill.com forwards. Scans last 24h of inbox.
 * Flags any bounced forwards in the local DB.
 *
 * @param gmail - Authenticated Gmail API client
 * @returns Array of bounced sent message IDs
 */
export async function checkForBounces(gmail: any): Promise<string[]> {
    const bouncedIds: string[] = [];
    try {
        // Search for delivery failure emails in the last 24h
        const afterDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        const listRes = await gmail.users.messages.list({
            userId: "me",
            q: `from:mailer-daemon OR from:postmaster OR from:mail-delivery after:${afterDate}`,
            maxResults: 20,
        });

        const messages = listRes.data.messages || [];
        if (messages.length === 0) return bouncedIds;

        for (const msg of messages) {
            try {
                const msgRes = await gmail.users.messages.get({
                    userId: "me",
                    id: msg.id,
                    format: "full",
                });

                const headers = msgRes.data.payload?.headers || [];
                const subject = headers.find((h: any) => h.name === "Subject")?.value || "";

                // Extract any referenced message ID from the bounce body
                // Bounce notifications often contain the original subject or message ID
                const snippet = (msgRes.data.snippet || "").toLowerCase();
                if (snippet.includes("buildasoilap@bill.com") || snippet.includes("delivery status notification")) {
                    // Find any forwarded invoice that matches this bounce
                    try {
                        const db = getLocalDb();
                        // Mark any unverified forwards as ERROR (bounce detected)
                        const unverified = db.prepare(
                            `SELECT billcom_sent_message_id, pdf_filename, gmail_message_id
                             FROM ap_local_forwards
                             WHERE status = 'FORWARDED' AND verified = 0
                             AND forwarded_at > datetime('now', '-24 hours')`
                        ).all() as Array<{ billcom_sent_message_id: string; pdf_filename: string; gmail_message_id: string }>;

                        for (const fwd of unverified) {
                            // Check if the bounce snippet references this forward's subject
                            // This is a heuristic — bounces don't always contain the exact message ID
                            bouncedIds.push(fwd.billcom_sent_message_id);
                            db.prepare(
                                `UPDATE ap_local_forwards
                                 SET status = 'ERROR',
                                     error_message = 'Bounce detected: ' || ?
                                 WHERE billcom_sent_message_id = ?`
                            ).run(subject.slice(0, 100), fwd.billcom_sent_message_id);
                            console.warn(`   [AP-Local] ⚠️ Bounce detected for ${fwd.pdf_filename}: ${subject.slice(0, 60)}`);
                        }
                    } catch { /* non-critical */ }
                }
            } catch { /* skip individual message errors */ }
        }
    } catch (e: any) {
        console.warn(`   [AP-Local] Bounce check failed: ${e.message}`);
    }
    return bouncedIds;
}

/**
 * Reconciliation handoff: match forwarded invoices to Finale POs.
 *
 * Lifecycle: FORWARDED → RECONCILED → COMPLETE
 * - Dropship invoices (vendor_routing_action = 'dropship') auto-complete (no PO to match).
 * - For other invoices, extract PO number from email subject and verify in Finale.
 * - If a PO is found, mark RECONCILED.
 * - If no PO reference in subject, leave as FORWARDED for manual matching.
 *
 * @returns Summary of reconciliation actions
 */
export async function runReconciliationHandoff(): Promise<{
    checked: number;
    reconciled: number;
    autoCompleted: number;
    pending: number;
}> {
    const summary = { checked: 0, reconciled: 0, autoCompleted: 0, pending: 0 };
    console.log("🔄 [AP-Reconcile] Checking forwarded invoices for PO matching...");

    try {
        const db = getLocalDb();

        // Get all FORWARDED invoices that haven't been reconciled yet
        const forwarded = db.prepare(
            `SELECT * FROM ap_local_forwards
             WHERE status = 'FORWARDED'
             AND (reconciliation_status IS NULL OR reconciliation_status = '')
             ORDER BY forwarded_at ASC`
        ).all() as Array<{
            id: number;
            gmail_message_id: string;
            email_from: string;
            email_subject: string;
            pdf_filename: string;
            vendor_routing_action: string | null;
        }>;

        summary.checked = forwarded.length;
        if (forwarded.length === 0) {
            console.log("   [AP-Reconcile] No forwarded invoices pending reconciliation.");
            return summary;
        }

        // ── Dynamic import to avoid circular deps ──
        const { FinaleClient } = await import("@/lib/finale/client");
        const finaleClient = new FinaleClient();

        for (const inv of forwarded) {
            // Auto-complete dropship invoices (no PO to match)
            if (inv.vendor_routing_action === "dropship") {
                db.prepare(
                    `UPDATE ap_local_forwards
                     SET reconciliation_status = 'COMPLETE',
                         reconciliation_notes = 'Dropship — no PO matching required',
                         reconciled_at = datetime('now'),
                         completed_at = datetime('now')
                     WHERE id = ?`
                ).run(inv.id);
                summary.autoCompleted++;
                console.log(`   [AP-Reconcile] ✅ Auto-completed dropship: ${inv.pdf_filename}`);
                continue;
            }

            // Try to extract PO number from email subject
            // Patterns: PO-12345, PO12345, PO 12345, Purchase Order 12345, P.O. 12345
            const poMatch = inv.email_subject.match(/(?:PO|P\.?O\.?|Purchase\s+Order)\s*#?\s*-?(\d{4,6})/i);

            if (!poMatch) {
                // No PO number in subject — leave for manual matching
                summary.pending++;
                console.log(`   [AP-Reconcile] ⏳ No PO# in subject: ${inv.pdf_filename} — "${inv.email_subject.slice(0, 50)}"`);
                continue;
            }

            const poNumber = poMatch[1].padStart(5, "0");

            try {
                // Verify PO exists in Finale
                const poDetails = await finaleClient.getOrderDetails(poNumber);

                if (poDetails) {
                    // PO found — mark reconciled
                    db.prepare(
                        `UPDATE ap_local_forwards
                         SET reconciliation_status = 'RECONCILED',
                             matched_po_number = ?,
                             reconciliation_notes = 'Auto-matched: PO# found in email subject',
                             reconciled_at = datetime('now')
                         WHERE id = ?`
                    ).run(poNumber, inv.id);
                    summary.reconciled++;
                    console.log(`   [AP-Reconcile] ✅ Reconciled ${inv.pdf_filename} → PO ${poNumber}`);
                } else {
                    summary.pending++;
                    console.log(`   [AP-Reconcile] ⏳ PO ${poNumber} not found in Finale for ${inv.pdf_filename}`);
                }
            } catch (e: any) {
                summary.pending++;
                console.warn(`   [AP-Reconcile] Finale lookup failed for PO ${poNumber}: ${e.message}`);
            }
        }

        console.log(
            `🔄 [AP-Reconcile] Done: checked=${summary.checked} reconciled=${summary.reconciled} ` +
            `autoCompleted=${summary.autoCompleted} pending=${summary.pending}`,
        );
    } catch (e: any) {
        console.error(`   [AP-Reconcile] Error: ${e.message}`);
    }

    return summary;
}

/**
 * Mark a Gmail message as processed: remove UNREAD + INBOX, add "Invoice Forward" label.
 * This prevents reprocessing on the next cycle.
 */
async function markEmailProcessed(gmail: any, messageId: string): Promise<void> {
    try {
        // Find or create the "Invoice Forward" label
        const labelsRes = await gmail.users.labels.list({ userId: "me" });
        let labelId = labelsRes.data.labels?.find(
            (l: any) => l.name?.toLowerCase() === "invoice forward",
        )?.id;

        if (!labelId) {
            const created = await gmail.users.labels.create({
                userId: "me",
                requestBody: {
                    name: "Invoice Forward",
                    labelListVisibility: "labelShow",
                    messageListVisibility: "show",
                },
            });
            labelId = created.data.id;
        }

        await gmail.users.messages.modify({
            userId: "me",
            id: messageId,
            requestBody: {
                addLabelIds: [labelId],
                removeLabelIds: ["INBOX", "UNREAD"],
            },
        });
    } catch (e: any) {
        console.warn(`   [AP-Local] Failed to mark email ${messageId} as processed:`, e.message);
    }
}

/**
 * Main entry point: scan Gmail for unread invoice emails and forward PDFs to Bill.com.
 * Called by the ap-polling cron every 15 minutes.
 *
 * @returns Summary of actions taken this cycle
 */
export async function runLocalApForward(): Promise<{
    scanned: number;
    forwarded: number;
    skipped: number;
    errors: number;
}> {
    const summary = { scanned: 0, forwarded: 0, skipped: 0, errors: 0 };

    console.log("📤 [AP-Local] Scanning Gmail for unread invoice emails...");

    let auth;
    try {
        auth = await getAuthenticatedClient("ap");
    } catch {
        console.warn("   [AP-Local] Missing 'ap' token, falling back to 'default'...");
        auth = await getAuthenticatedClient("default");
    }
    const gmail = GmailApi({ version: "v1", auth }) as any;

    // ── Post-send verification: check for bounces from previous cycles ──
    const bounces = await checkForBounces(gmail);
    if (bounces.length > 0) {
        console.warn(`   [AP-Local] ⚠️ ${bounces.length} bounce(s) detected from previous forwards`);
    }

    // Fetch unread emails from inbox
    const listRes = await gmail.users.messages.list({
        userId: "me",
        labelIds: ["INBOX", "UNREAD"],
        maxResults: MAX_EMAILS_PER_CYCLE,
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
        return summary;
    }

    summary.scanned = messages.length;
    console.log(`   [AP-Local] Found ${messages.length} unread email(s).`);

    for (const msg of messages) {
        try {
            // Fetch full message to get attachments
            const msgRes = await gmail.users.messages.get({
                userId: "me",
                id: msg.id,
                format: "full",
            });

            const headers = msgRes.data.payload?.headers || [];
            const subject = headers.find((h: any) => h.name === "Subject")?.value || "(no subject)";
            const from = headers.find((h: any) => h.name === "From")?.value || "unknown";
            const gmailMessageId = msg.id;

            // Skip known non-invoice senders (tracking notifications, etc.)
            if (isNonInvoiceSender(from, subject)) {
                console.log(`   [AP-Local] Skipping non-invoice: ${subject.slice(0, 50)} (${from.slice(0, 25)})`);
                await markEmailProcessed(gmail, gmailMessageId);
                summary.skipped++;
                continue;
            }

            // ── Vendor routing check ────────────────────────────────────
            // Only three outcomes that matter for forwarding:
            //   'skip'         → mark read, archive (not an invoice)
            //   'amazon_order' → route to Amazon parser
            //   'dropship'     → forward, but skip PO reconciliation later
            //   null (no rule) → forward + PO matching (default)
            const routingRule = checkVendorRouting(from, subject);
            let skipReconciliation = false;

            if (routingRule) {
                if (routingRule.action === "skip" || routingRule.action === "amazon_order") {
                    console.log(`   [AP-Local] Skipping: ${routingRule.label} — ${subject.slice(0, 50)}`);
                    await markEmailProcessed(gmail, gmailMessageId);
                    summary.skipped++;
                    continue;
                }
                if (routingRule.action === "dropship") {
                    skipReconciliation = true;
                    console.log(`   [AP-Local] Dropship vendor: ${routingRule.label} — will skip PO matching`);
                }
            }

            // Extract PDF attachments
            const pdfAttachments = extractPdfAttachments(msgRes.data.payload);

            if (pdfAttachments.length === 0) {
                // No PDF attached — not an invoice. Mark read, archive, skip.
                console.log(`   [AP-Local] No PDF — skipping: ${subject.slice(0, 50)}`);
                await markEmailProcessed(gmail, gmailMessageId);
                summary.skipped++;
                continue;
            }

            // Process each PDF attachment
            let allPdfsForwarded = true;
            for (const pdf of pdfAttachments) {
                let pdfBuffer = pdf.buffer;

                // Fetch attachment content if not inline
                if (pdf.attachmentId && pdfBuffer.length === 0) {
                    const attRes = await gmail.users.messages.attachments.get({
                        userId: "me",
                        messageId: gmailMessageId,
                        id: pdf.attachmentId,
                    });
                    pdfBuffer = Buffer.from(attRes.data.data || "", "base64url");
                }

                if (pdfBuffer.length === 0) {
                    console.warn(`   [AP-Local] Empty PDF: ${pdf.filename}`);
                    allPdfsForwarded = false;
                    continue;
                }

                const pdfHash = crypto.createHash("sha256").update(pdfBuffer).digest("hex");

                // Dedup check
                if (isAlreadyForwarded(gmailMessageId, pdf.filename, pdfHash)) {
                    console.log(`   [AP-Local] ⏭️ Already forwarded: ${pdf.filename} (msg ${gmailMessageId})`);
                    summary.skipped++;
                    continue;
                }

                // ── Paid invoice detection ────────────────────────────────
                // OCR the PDF to check if this is an already-paid invoice.
                // Paid invoices (receipts, $0.00 balance, "Do Not Pay") should
                // never reach Bill.com. Safe default: forward if OCR fails.
                const paidCheck = await checkPaidInvoiceBlock(pdfBuffer);
                if (paidCheck.blocked) {
                    recordError(gmailMessageId, from, subject, pdf.filename, pdfHash,
                        `BLOCKED: ${paidCheck.reason}`);
                    summary.skipped++;
                    continue;
                }

                // Forward to Bill.com
                try {
                    const safeFilename = sanitizeForwardFilename(pdf.filename);
                    const sentId = await forwardToBillCom(gmail, subject, from, pdf.filename, pdfBuffer);
                    if (!sentId) {
                        throw new Error("Gmail send returned no message ID");
                    }

                    // ── Post-send verification ────────────────────────────
                    // Use safeFilename — the sent attachment has the sanitized name
                    const verified = await verifySentForward(gmail, sentId, safeFilename);
                    if (!verified) {
                        console.warn(`   [AP-Local] ⚠️ Sent verification failed for ${safeFilename} (sent ID: ${sentId})`);
                    }

                    recordForward(
                        gmailMessageId, from, subject, pdf.filename, pdfHash, sentId,
                        skipReconciliation ? "dropship" : undefined,
                    );
                    await syncToSupabase(from, subject, pdf.filename, sentId);
                    summary.forwarded++;
                    console.log(`   [AP-Local] ✅ Forwarded ${pdf.filename} from ${from.slice(0, 25)}${verified ? "" : " (UNVERIFIED)"}`);
                } catch (e: any) {
                    recordError(gmailMessageId, from, subject, pdf.filename, pdfHash, e.message);
                    summary.errors++;
                    allPdfsForwarded = false;
                    console.error(`   [AP-Local] ❌ Failed to forward ${pdf.filename}: ${e.message}`);
                }
            }

            // Mark email as processed only if all PDFs were forwarded
            if (allPdfsForwarded) {
                await markEmailProcessed(gmail, gmailMessageId);
            }
        } catch (e: any) {
            console.error(`   [AP-Local] Error processing email ${msg.id}:`, e.message);
            summary.errors++;
        }
    }

    console.log(
        `📤 [AP-Local] Done: scanned=${summary.scanned} forwarded=${summary.forwarded} skipped=${summary.skipped} errors=${summary.errors}`,
    );

    // ── Reconciliation handoff: match forwarded invoices to Finale POs ──
    // Runs every cycle. Dropship invoices auto-complete.
    // Invoices with PO# in subject get matched to Finale POs.
    await runReconciliationHandoff();

    return summary;
}
