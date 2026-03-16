/**
 * @file    inline-invoice-parser.ts
 * @purpose Detects and parses inline invoice data from vendor email bodies.
 *          Used when vendors send cost breakdowns in plain text instead of
 *          attaching a PDF invoice.
 *          Also detects "paid invoice" confirmation emails (e.g., AxiomPrint,
 *          Bill.com, Stripe) and extracts vendor, invoice #, amount for PO 
 *          correlation in Finale.
 * @author  Will
 * @created 2026-03-12
 * @updated 2026-03-16
 * @deps    invoice-parser (InvoiceSchema, InvoiceData), llm (unifiedObjectGeneration), zod
 */

import { InvoiceSchema, type InvoiceData } from '../pdf/invoice-parser';
import { unifiedObjectGeneration } from './llm';
import { z } from 'zod';

/**
 * Heuristic detection: does this email body contain inline invoice data?
 *
 * DECISION(2026-03-12): Fast regex heuristic, not LLM. False positives are OK
 * because parseInlineInvoice sets confidence=low on non-invoice content.
 *
 * DECISION(2026-03-13): Expanded keywords after PO #124462 failure. Real vendors
 * use casual language: "BREAKDOWN", "UPS GROUND", "PLUS $X", "SHIPPED".
 * Added PO-thread context boost: if subject references a PO# and email has $,
 * lower keyword threshold from 2 → 1.
 *
 * @param   emailBody        - Plain-text email body
 * @param   hasPdfAttachment - Whether the email already has a PDF
 * @param   emailSubject     - Optional subject line for PO-thread context
 * @returns true if the email likely contains inline invoice data
 */
export function detectInlineInvoice(emailBody: string, hasPdfAttachment: boolean, emailSubject?: string): boolean {
    if (hasPdfAttachment) return false;

    const dollarPattern = /\$[\d,]+\.\d{2}/;
    // Also match raw amounts like "1140.77" near money-context words
    const rawAmountPattern = /\b\d{2,},?\d*\.\d{2}\b/;
    if (!dollarPattern.test(emailBody) && !rawAmountPattern.test(emailBody)) return false;

    const text = emailBody.toLowerCase();
    const invoiceKeywords = [
        // Formal invoice terms
        /\btotal\b/,
        /\bsubtotal\b/,
        /\bamount\s+due\b/,
        /\bfreight\b/,
        /\bshipping\s+(cost|charge|fee)\b/,
        /\binvoice\b/,
        /\bbalance\s+due\b/,
        /\bpayment\s+due\b/,
        /\bcost\s*:/,
        /\bcharge\s*:/,
        // Vendor-common casual terms (learned from PO #124462)
        /\bbreakdown\b/,
        /\bplus\b/,
        /\bground\b/,
        /\bshipp(ed|ing)\b/,
        /\bups\b/,
        /\bfedex\b/,
        /\bbags?\b.*\d/,
        /\d+\s*#/,
    ];

    const matchCount = invoiceKeywords.filter(kw => kw.test(text)).length;

    // DECISION(2026-03-13): PO-thread context awareness.
    // If the email subject references a BuildASoil PO#, this is a vendor replying
    // to an active purchase order. Cost data in PO threads is almost always an
    // invoice/cost breakdown — lower threshold from 2 to 1.
    const isPOThread = emailSubject
        ? /\bPO\s*#?\s*\d+/i.test(emailSubject) || /\bpurchase\s*order\b/i.test(emailSubject)
        : false;

    const threshold = isPOThread ? 1 : 2;
    return matchCount >= threshold;
}

const INLINE_INVOICE_SYSTEM_PROMPT = `You are a precise invoice data extractor.
The user will provide an email body from a vendor that contains inline invoice information.

Extract the invoice data as if it were a formal invoice document:
- Line items with quantities, unit prices, and totals
- Freight/shipping charges separately
- Calculate subtotal and total
- PO number if referenced
- Vendor name from email signature or context
- If invoice number is not explicit, set to "UNKNOWN"

Be precise with dollar amounts. If data is ambiguous, set confidence to "low".`;

/**
 * Parse inline invoice data from email body using LLM extraction.
 *
 * @param   emailBody     - Plain-text email body
 * @param   emailSubject  - Email subject line
 * @param   emailFrom     - Sender address
 * @returns Structured invoice data matching InvoiceSchema
 */
export async function parseInlineInvoice(
    emailBody: string,
    emailSubject: string,
    emailFrom: string
): Promise<InvoiceData> {
    try {
        const contextParts = [
            `Email Subject: ${emailSubject}`,
            `Email From: ${emailFrom}`,
            ``,
            `Email Body:`,
            emailBody.slice(0, 15000),
        ];

        const data = await unifiedObjectGeneration({
            system: INLINE_INVOICE_SYSTEM_PROMPT,
            prompt: contextParts.join('\n'),
            schema: InvoiceSchema,
            schemaName: 'InlineInvoice',
        });

        return data as InvoiceData;
    } catch (err: any) {
        console.error('\u274C parseInlineInvoice failed:', err.message);
        return {
            documentType: 'invoice',
            invoiceNumber: 'UNKNOWN',
            vendorName: emailFrom.split('@')[0] || 'Unknown',
            invoiceDate: new Date().toISOString().split('T')[0],
            lineItems: [],
            subtotal: 0,
            total: 0,
            amountDue: 0,
            confidence: 'low',
        } as unknown as InvoiceData;
    }
}

// ──────────────────────────────────────────────────
// PAID INVOICE DETECTION & PARSING
// ──────────────────────────────────────────────────

/**
 * Schema for paid invoice extraction results.
 */
export const PaidInvoiceSchema = z.object({
    vendorName: z.string().describe('Vendor or company name that sent the payment confirmation'),
    invoiceNumber: z.string().describe('Invoice number referenced in the payment confirmation'),
    amountPaid: z.number().describe('Dollar amount that was paid'),
    datePaid: z.string().describe('Date the payment was made, in YYYY-MM-DD format'),
    poNumber: z.string().nullable().describe('Purchase Order number if referenced, or null'),
    productDescription: z.string().nullable().describe('Brief product/service description if mentioned, or null'),
    vendorAddress: z.string().nullable().describe('Vendor mailing address if present, or null'),
    confidence: z.enum(['high', 'medium', 'low']).describe('Confidence level of extraction accuracy'),
});

export type PaidInvoiceData = z.infer<typeof PaidInvoiceSchema>;

/**
 * Heuristic detection: is this email a "paid invoice" confirmation?
 *
 * DECISION(2026-03-16): Fast regex heuristic for paid invoice confirmations.
 * Catches patterns like:
 *   - "Invoice INV122172 paid $148.76 successfully"
 *   - "Payment of $500.00 for invoice #123 processed"
 *   - "Your payment was successful" + dollar amount
 *   - "Balance $0.00" with invoice reference
 *
 * False positives are acceptable — the LLM extraction step filters them.
 *
 * @param   emailSubject     - Email subject line
 * @param   emailBody        - Plain-text email body (or snippet)
 * @param   hasPdfAttachment - Whether the email already has a PDF
 * @returns true if this looks like a paid invoice confirmation
 */
export function detectPaidInvoice(
    emailSubject: string,
    emailBody: string,
    hasPdfAttachment: boolean = false
): boolean {
    // Don't intercept emails that have PDF attachments — those go through the
    // normal AP invoice pipeline (download, parse, reconcile).
    if (hasPdfAttachment) return false;

    const combined = `${emailSubject}\n${emailBody}`.toLowerCase();

    // Pattern 1: "Invoice ___ paid" or "paid ___ invoice"
    const paidInvoicePattern = /\binvoice\s+[#]?[a-z0-9-]+\s+paid\b/i;
    // Pattern 2: "paid $___" or "payment of $___" near "invoice" or "successfully"
    const paidAmountPattern = /\bpaid\s+\$[\d,]+\.\d{2}/i;
    // Pattern 3: "payment.*successful" or "successfully.*paid"
    const paymentSuccessPattern = /\bpayment\b.{0,30}\bsuccessful/i;
    const successfullyPaid = /\bsuccessfully\b.{0,20}\bpaid\b/i;
    // Pattern 4: "Balance $0.00" with invoice reference — payment completed
    const zeroBalancePattern = /\bbalance\b.{0,15}\$0\.00/i;
    const hasInvoiceRef = /\binvoice\b/i;

    // Strong signals — any one alone is sufficient
    if (paidInvoicePattern.test(combined)) return true;
    if (paymentSuccessPattern.test(combined) && /\$[\d,]+\.\d{2}/.test(combined)) return true;
    if (successfullyPaid.test(combined)) return true;

    // Medium signals — require two to fire
    const signals = [
        paidAmountPattern.test(combined),
        zeroBalancePattern.test(combined),
        hasInvoiceRef.test(combined) && /\bpaid\b/i.test(combined),
        /\breceipt\b/i.test(combined) && /\bpayment\b/i.test(combined),
        /\btransaction\b.{0,20}\bcomplete/i.test(combined),
    ].filter(Boolean).length;

    return signals >= 2;
}

const PAID_INVOICE_SYSTEM_PROMPT = `You are a precise data extractor for payment confirmation emails.
The user will provide an email that confirms a payment/invoice has been paid.

Extract:
- Vendor/company name (who was paid)
- Invoice number (the invoice that was settled)
- Amount paid (exact dollar amount)
- Date paid (when payment was processed)
- PO number if referenced anywhere in the email
- Brief product/service description if mentioned
- Vendor address if present

Be precise with numbers. If a field isn't clearly present, return null.
Set confidence to "high" if all key fields are clearly extractable,
"medium" if some inference was needed, "low" if data is ambiguous.`;

/**
 * Extract structured paid invoice data from an email body using LLM.
 *
 * @param   emailBody     - Plain-text email body
 * @param   emailSubject  - Email subject line
 * @param   emailFrom     - Sender address
 * @returns Structured paid invoice data
 */
export async function parsePaidInvoice(
    emailBody: string,
    emailSubject: string,
    emailFrom: string
): Promise<PaidInvoiceData> {
    try {
        const contextParts = [
            `Email Subject: ${emailSubject}`,
            `Email From: ${emailFrom}`,
            ``,
            `Email Body:`,
            emailBody.slice(0, 15000),
        ];

        const data = await unifiedObjectGeneration({
            system: PAID_INVOICE_SYSTEM_PROMPT,
            prompt: contextParts.join('\n'),
            schema: PaidInvoiceSchema,
            schemaName: 'PaidInvoice',
        });

        return data as PaidInvoiceData;
    } catch (err: any) {
        console.error('❌ parsePaidInvoice failed:', err.message);
        // Best-effort fallback: try regex extraction from subject
        const invMatch = emailSubject.match(/\bINV[A-Z0-9-]*\d+/i)
            || emailBody.match(/\binvoice\s+#?([A-Z0-9-]+)/i);
        const amtMatch = emailSubject.match(/\$([\d,]+\.\d{2})/)
            || emailBody.match(/\$([\d,]+\.\d{2})/);

        return {
            vendorName: emailFrom.split('@')[0]?.replace(/[._-]/g, ' ') || 'Unknown',
            invoiceNumber: invMatch ? (invMatch[1] || invMatch[0]) : 'UNKNOWN',
            amountPaid: amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0,
            datePaid: new Date().toISOString().split('T')[0],
            poNumber: null,
            productDescription: null,
            vendorAddress: null,
            confidence: 'low',
        };
    }
}
