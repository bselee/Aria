/**
 * @file    inline-invoice-handler.ts
 * @purpose Autonomous handler for inline (text-only) vendor invoices like
 *          Ed Zybura / Organic AG Products. Detects casual cost breakdowns
 *          in email bodies, finds the correlating Finale PO, generates a
 *          proper PDF invoice, and forwards it to Bill.com via Gmail.
 *          Zero Supabase dependency — uses direct Gmail + Finale GraphQL.
 * @author  Hermia
 * @created 2026-06-29
 * @deps    inline-invoice-parser, invoice-generator, @googleapis/gmail
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 *          BILL_COM_FORWARD_EMAIL (default: buildasoilap@bill.com)
 */

import { detectInlineInvoice, parseInlineInvoice } from "./inline-invoice-parser";
import { generateInvoicePDF } from "../pdf/invoice-generator";
import type { InvoiceData } from "../pdf/invoice-parser";
import { createHash, randomBytes } from "crypto";
import { isDuplicate } from "./ap-dedup";
import { forwardInvoiceOnce } from "./ap-single-forward";
import { getLocalDb } from "../storage/local-db";

const BILL_COM_EMAIL = process.env.BILL_COM_FORWARD_EMAIL || "buildasoilap@bill.com";

/**
 * Inline invoice auto-PDF is ONLY for known free-text vendors.
 * HARD GATE (2026-07-10): Belt Power shipment notifications (and any other
 * non-Organic-AG no-PDF mail) were matching the loose dollar heuristic, then
 * this handler always stamped vendorName="Organic AG Products" and forwarded
 * fabricated invoices to Bill.com under the wrong subject — 9x for one
 * Belt Power shipment notice on 2026-07-09.
 */
const INLINE_INVOICE_SENDER_ALLOWLIST: RegExp[] = [
    /organicag/i,
    /organic\s*ag/i,
    /zybura/i,
    /ed@organicag/i,
    /@organicagproducts/i,
];

const INLINE_INVOICE_SUBJECT_ALLOWLIST: RegExp[] = [
    /organic\s*ag/i,
    /zybura/i,
];

function isAllowedInlineVendor(from: string, subject: string): boolean {
    const hay = `${from}\n${subject}`;
    if (INLINE_INVOICE_SENDER_ALLOWLIST.some((re) => re.test(hay))) return true;
    if (INLINE_INVOICE_SUBJECT_ALLOWLIST.some((re) => re.test(subject))) return true;
    return false;
}

function recordInlineForward(
    gmailMessageId: string,
    emailFrom: string,
    emailSubject: string,
    pdfFilename: string,
    pdfHash: string,
    billcomSentMessageId: string,
): void {
    try {
        const db = getLocalDb();
        db.prepare(
            `INSERT OR IGNORE INTO ap_local_forwards
             (gmail_message_id, email_from, email_subject, pdf_filename,
              pdf_content_hash, billcom_sent_message_id, status, vendor_routing_action)
             VALUES (?, ?, ?, ?, ?, ?, 'FORWARDED', 'inline_invoice')`,
        ).run(
            gmailMessageId,
            emailFrom,
            emailSubject,
            pdfFilename,
            pdfHash,
            billcomSentMessageId,
        );
    } catch (e: any) {
        console.warn(`   [inline] Failed to record local forward: ${e.message}`);
    }
}

// ─── Finale GraphQL Helpers ─────────────────────────────────────────────────

interface FinalePO {
    orderId: string;
    status: string;
    orderDate: string;
    supplier: { name: string };
    totalAmount?: { amount: string };
}

/**
 * Build Finale GraphQL auth header from environment variables.
 */
function finaleAuthHeader(): string {
    const apiKey = process.env.FINALE_API_KEY || "";
    const apiSecret = process.env.FINALE_API_SECRET || "";
    return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
}

/**
 * Get the Finale GraphQL endpoint URL.
 */
function finaleGraphqlUrl(): string {
    const base = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const account = process.env.FINALE_ACCOUNT_PATH || "";
    return `${base}/${account}/api/graphql`;
}

/**
 * Search Finale for purchase orders from a supplier within a date window.
 * Returns POs sorted by date descending.
 *
 * @param supplierKeywords - Terms to match against supplier name (e.g. ["organic ag", "zybura"])
 * @param daysBack          - How many days back to search (default 120)
 * @returns Matching POs, newest first
 */
async function findPOsBySupplier(
    supplierKeywords: string[],
    daysBack: number = 120
): Promise<FinalePO[]> {
    const now = new Date();
    const begin = new Date(now);
    begin.setDate(begin.getDate() - daysBack);
    const beginStr = begin.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const endStr = now.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

    const query = {
        query: `{
            orderViewConnection(
                first: 200
                type: ["PURCHASE_ORDER"]
                orderDate: { begin: "${beginStr}", end: "${endStr}" }
                sort: [{ field: "orderDate", mode: "desc" }]
            ) {
                edges { node {
                    orderId status orderDate
                    supplier { name }
                    totalAmount { amount }
                }}
            }
        }`,
    };

    const res = await fetch(finaleGraphqlUrl(), {
        method: "POST",
        headers: {
            Authorization: finaleAuthHeader(),
            "Content-Type": "application/json",
        },
        body: JSON.stringify(query),
    });

    if (!res.ok) {
        throw new Error(`Finale API returned ${res.status}: ${await res.text().then(t => t.substring(0, 200))}`);
    }

    const json: any = await res.json();
    if (json.errors?.length > 0) {
        throw new Error(`Finale GraphQL error: ${json.errors[0].message}`);
    }

    const edges: any[] = json.data?.orderViewConnection?.edges || [];
    const allPOs: FinalePO[] = edges.map((e: any) => ({
        orderId: String(e.node.orderId),
        status: e.node.status,
        orderDate: e.node.orderDate,
        supplier: e.node.supplier,
        totalAmount: e.node.totalAmount,
    }));

    // Filter by supplier name keywords
    const lowerKeys = supplierKeywords.map(k => k.toLowerCase());
    return allPOs.filter(po =>
        lowerKeys.some(kw => (po.supplier?.name || "").toLowerCase().includes(kw))
    );
}

/**
 * Find the most likely correlating PO for Ed's invoice.
 *
 * Strategy (per Bill, 2026-06-29):
 *   "You can look and see the PO date as the exact one that's going to be
 *    next in line." — Find the most recent PO from Organic AG Products
 *    that has NOT yet been reconciled (non-CLOSED status preferred) or
 *    the most recent by date if all are closed.
 *
 * @returns PO number string, or null if not found
 */
async function findCorrelatingPO(): Promise<string | null> {
    try {
        const keywords = ["organic ag", "organicag", "zybura", "ed ag"];
        const pos = await findPOsBySupplier(keywords, 120);

        if (pos.length === 0) {
            console.warn("   ⚠️ No Organic AG POs found in Finale (120-day window)");
            return null;
        }

        // Prefer the most recent non-CLOSED PO
        const openPO = pos.find(po => po.status !== "CLOSED" && po.status !== "CANCELLED");
        if (openPO) {
            console.log(`   ✅ Found open PO ${openPO.orderId} (${openPO.status}) — ${openPO.orderDate}`);
            return openPO.orderId;
        }

        // Fallback: most recent by date
        const latest = pos[0];
        console.log(`   ⚠️ All Organic AG POs closed. Using latest: PO ${latest.orderId} (${latest.orderDate})`);
        return latest.orderId;
    } catch (err: any) {
        console.warn(`   ⚠️ Finale PO search failed: ${err.message}`);
        return null;
    }
}

// ─── Bill.com Forwarding ────────────────────────────────────────────────────

/**
 * Forward a PDF invoice to Bill.com via Gmail, matching the same MIME format
 * used by ap-local-forwarder.ts.
 *
 * @param gmail           - Authenticated Gmail API client
 * @param emailSubject    - Original email subject (used as "Fwd: <subject>")
 * @param emailFrom       - Original sender email
 * @param pdfFilename     - Desired filename for the attached PDF
 * @param pdfBuffer       - PDF bytes
 * @returns Sent Gmail message ID, or null on failure
 */
async function forwardToBillCom(
    gmail: any,
    emailSubject: string,
    emailFrom: string,
    pdfFilename: string,
    pdfBuffer: Buffer,
): Promise<string | null> {
    const rawBase64 = pdfBuffer.toString("base64");
    const chunkedBase64 = rawBase64.match(/.{1,76}/g)?.join("\r\n") || rawBase64;
    const boundary = "b_aria_inline_" + randomBytes(8).toString("hex");

    const forwardBody = [
        "Forwarded invoice (auto-generated from vendor email).",
        "",
        `Vendor: ${emailFrom}`,
        `Original Subject: ${emailSubject}`,
        `PDF: ${pdfFilename}`,
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
        `Content-Type: application/pdf; name="${pdfFilename}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${pdfFilename}"`,
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

// ─── Main Handler ───────────────────────────────────────────────────────────

export interface InlineInvoiceParams {
    /** Authenticated Gmail API client for the source inbox */
    gmail: any;
    /** Gmail message ID of the source email */
    gmailMessageId: string;
    /** Sender email address (e.g. "Ed Zybura <ed@organicag.com>") */
    from: string;
    /** Email subject line */
    subject: string;
    /** Email body text (plain text) */
    body: string;
    /** Date the email was received (YYYY-MM-DD) */
    date: string;
}

export interface InlineInvoiceResult {
    success: boolean;
    /** Sent Gmail message ID if forwarded successfully */
    forwardedMessageId?: string;
    /** Correlating PO number found (or null if not found) */
    poNumber?: string | null;
    /** Invoice number extracted/assigned */
    invoiceNumber?: string;
    /** Total amount extracted */
    totalAmount?: number;
    error?: string;
}

/**
 * Handle an inline invoice email: parse, find PO, generate PDF, forward to Bill.com.
 *
 * Designed to be called from ap-identifier.ts when an email is detected as an
 * inline invoice (detectInlineInvoice returns true). Completely autonomous —
 * no Supabase dependency, no manual steps.
 *
 * @param params - Email context and Gmail client
 * @returns Result with success status and metadata
 */
export async function handleInlineInvoice(
    params: InlineInvoiceParams
): Promise<InlineInvoiceResult> {
    const { gmail, gmailMessageId, from, subject, body, date } = params;

    console.log(`📧 Inline Invoice Handler — ${from} — ${subject.slice(0, 60)}`);

    // ── Step 0a: Vendor allowlist (Organic AG / Ed Zybura only) ──────────
    // The PDF generator and Finale PO lookup are hardcoded to Organic AG.
    // Never run this path for other vendors — it fabricates wrong bills.
    if (!isAllowedInlineVendor(from, subject)) {
        console.log(`   ⏭️ Inline handler skipped — sender not on allowlist: ${from.slice(0, 50)}`);
        return {
            success: false,
            error: `Inline invoice handler only supports Organic AG / Ed Zybura (got: ${from})`,
        };
    }

    // ── Step 0b: Pattern pre-flight ───────────────────────────────────────
    if (!detectInlineInvoice(body, false, subject)) {
        return { success: false, error: "Email does not match inline invoice pattern" };
    }

    try {
        // ── Step 1: Parse invoice via LLM ──────────────────────────────────
        console.log(`   🔍 LLM parsing...`);
        const data = await parseInlineInvoice(body, subject, from);

        // ── Step 2: Extract amounts from raw body (Ed's format: BREAK DOWN $X) ──
        const sm = body.match(/BREAK\s*DOWN\s*\$?(\d[\d,]*)/i);
        const fm = body.match(/FREIGHT.*?\$?(\d+\.?\d*)/i);
        const tm = body.match(/TOTAL\s*\$?([\d,]+\.?\d*)/i);
        const subtotal = sm ? parseFloat(sm[1].replace(/,/g, "")) : (data.subtotal || 0);
        const freight = fm ? parseFloat(fm[1].replace(/,/g, "")) : (data.freight || 0);
        const total = tm ? parseFloat(tm[1].replace(/,/g, "")) : (data.total || subtotal + freight);

        console.log(`   📊 Parsed: $${subtotal.toFixed(2)} + $${freight.toFixed(2)} = $${total.toFixed(2)}`);

        // Refuse zero/garbage totals — do not invent bills
        if (!total || total <= 0 || !Number.isFinite(total)) {
            return { success: false, error: `Invalid inline invoice total: ${total}` };
        }

        // ── Step 3: Find correlating PO ────────────────────────────────────
        console.log(`   🔍 Searching Finale for Organic AG PO...`);
        const poNumber = data.poNumber || await findCorrelatingPO();
        if (poNumber) {
            console.log(`   📎 Correlated to PO ${poNumber}`);
        }

        // ── Step 4: Assemble invoice data for PDF generation ───────────────
        const invNumber = data.invoiceNumber !== "UNKNOWN" && data.invoiceNumber
            ? data.invoiceNumber
            : subject.match(/INVOICE\s+#?(\d+)/i)?.[1] || "UNKNOWN";

        if (invNumber === "UNKNOWN") {
            return {
                success: false,
                error: "Inline invoice has no invoice number — refusing to fabricate UNKNOWN bill",
            };
        }

        const invoiceData: InvoiceData = {
            documentType: "invoice",
            invoiceNumber: invNumber,
            vendorName: data.vendorName || "Organic AG Products",
            vendorEmail: from.match(/<([^>]+)>/)?.[1] || from,
            poNumber: poNumber || undefined,
            invoiceDate: date,
            lineItems: data.lineItems?.length ? data.lineItems : [{
                description: poNumber
                    ? `Organic AG Products — PO ${poNumber} — per Ed Zybura ${date}`
                    : `Organic AG Products — per Ed Zybura ${date}`,
                qty: 1,
                unitPrice: subtotal,
                total: subtotal,
            }],
            subtotal,
            freight,
            total,
            amountDue: total,
            notes: data.notes || "Auto-generated from vendor email. Paper copy to follow per Ed.",
            confidence: "medium",
        };

        // ── Step 5: Generate PDF ──────────────────────────────────────────
        console.log(`   📄 Generating PDF invoice...`);
        const pdfBuffer = await generateInvoicePDF(invoiceData, date);
        const pdfHash = createHash("sha256").update(pdfBuffer).digest("hex");
        const safeFilename = `Organic_AG_Invoice_${invNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;

        // ── Step 6: Forward via single-forward gate (DB claim + one send) ──
        console.log(`   📤 Forwarding to ${BILL_COM_EMAIL} (${(pdfBuffer.length / 1024).toFixed(1)} KB) via single-gate...`);
        const once = await forwardInvoiceOnce({
            gmailMessageId,
            emailFrom: from,
            emailSubject: subject,
            pdfFilename: safeFilename,
            pdfBuffer,
            vendorName: "Organic AG Products",
            invoiceNumber: invNumber,
            source: "inline-invoice",
            gmail,
            vendorRoutingAction: "inline_invoice",
        });

        if (once.status === "already_forwarded") {
            console.log(`   ⏭️ Already forwarded inline invoice ${safeFilename} (${once.reason})`);
            return {
                success: true,
                forwardedMessageId: once.existingBillcomMessageId || undefined,
                poNumber,
                invoiceNumber: invNumber,
                totalAmount: total,
            };
        }
        if (once.status !== "forwarded") {
            return { success: false, error: once.reason || once.status };
        }

        console.log(`   ✅ Forwarded! Gmail message ID: ${once.billcomSentMessageId}`);
        return {
            success: true,
            forwardedMessageId: once.billcomSentMessageId,
            poNumber,
            invoiceNumber: invNumber,
            totalAmount: total,
        };
    } catch (err: any) {
        console.error(`   ❌ Inline invoice handler failed: ${err.message}`);
        return { success: false, error: err.message };
    }
}
