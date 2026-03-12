/**
 * @file    inline-invoice-parser.ts
 * @purpose Detects and parses inline invoice data from vendor email bodies.
 *          Used when vendors send cost breakdowns in plain text instead of
 *          attaching a PDF invoice.
 * @author  Will
 * @created 2026-03-12
 * @updated 2026-03-12
 * @deps    invoice-parser (InvoiceSchema, InvoiceData), llm (unifiedObjectGeneration)
 */

import { InvoiceSchema, type InvoiceData } from '../pdf/invoice-parser';
import { unifiedObjectGeneration } from './llm';

/**
 * Heuristic detection: does this email body contain inline invoice data?
 *
 * DECISION(2026-03-12): Fast regex heuristic, not LLM. False positives are OK
 * because parseInlineInvoice sets confidence=low on non-invoice content.
 *
 * @param   emailBody        - Plain-text email body
 * @param   hasPdfAttachment - Whether the email already has a PDF
 * @returns true if the email likely contains inline invoice data
 */
export function detectInlineInvoice(emailBody: string, hasPdfAttachment: boolean): boolean {
    if (hasPdfAttachment) return false;

    const dollarPattern = /\$[\d,]+\.\d{2}/;
    if (!dollarPattern.test(emailBody)) return false;

    const text = emailBody.toLowerCase();
    const invoiceKeywords = [
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
    ];

    const matchCount = invoiceKeywords.filter(kw => kw.test(text)).length;
    return matchCount >= 2;
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
