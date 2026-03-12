# Inline Invoice Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect inline invoice data in vendor emails (no PDF attached), generate a professional PDF invoice, forward it to Bill.com, reconcile against Finale PO, and auto-reply to the vendor with confirmation.

**Architecture:** Three new components work together: (1) a PDF invoice generator using `pdf-lib` that creates professional-looking invoices from structured data, (2) an inline invoice detector that plugs into the acknowledgement-agent's classification pipeline, and (3) a handler that ties detection → generation → forwarding → reconciliation → vendor reply into a single flow. The generated PDF is clean and vendor-branded with a small footer noting "Created from email correspondence — Internally generated document."

**Tech Stack:** pdf-lib (already installed), Zod schemas, LLM extraction via `unifiedObjectGeneration`, Gmail API for forwarding/replying, Finale API for PO cross-check.

---

## Task 1: PDF Invoice Generator

Create the core PDF generation utility that converts structured invoice data into a clean, professional PDF document.

**Files:**
- Create: `src/lib/pdf/invoice-generator.ts`
- Test: `src/lib/pdf/invoice-generator.test.ts`

### Step 1: Write the failing test

```typescript
// src/lib/pdf/invoice-generator.test.ts
import { describe, it, expect } from 'vitest';
import { generateInvoicePDF } from './invoice-generator';
import type { InvoiceData } from './invoice-parser';
import { PDFDocument } from 'pdf-lib';

const sampleInvoice: InvoiceData = {
    documentType: 'invoice',
    invoiceNumber: 'IG-2026-0312-124462',
    poNumber: '124462',
    vendorName: 'Organic AG Products',
    vendorEmail: 'ed@organicag.com',
    invoiceDate: '2026-03-12',
    lineItems: [
        { description: '15-1-1 (1# bags)', qty: 55, unitPrice: 19.00, total: 1045.00 }
    ],
    subtotal: 1045.00,
    freight: 95.77,
    total: 1140.77,
    amountDue: 1140.77,
    confidence: 'high',
    notes: 'UPS Ground shipping',
};

describe('generateInvoicePDF', () => {
    it('should return a valid PDF buffer', async () => {
        const buffer = await generateInvoicePDF(sampleInvoice);
        expect(buffer).toBeInstanceOf(Buffer);
        expect(buffer.length).toBeGreaterThan(500);
        const doc = await PDFDocument.load(buffer);
        expect(doc.getPageCount()).toBe(1);
    });

    it('should include vendor name and PO number in the PDF text', async () => {
        const buffer = await generateInvoicePDF(sampleInvoice);
        const text = buffer.toString('latin1');
        expect(text).toContain('Organic AG Products');
        expect(text).toContain('124462');
    });

    it('should include the internally generated footer', async () => {
        const buffer = await generateInvoicePDF(sampleInvoice);
        const text = buffer.toString('latin1');
        expect(text).toContain('Internally generated');
    });

    it('should handle invoices with no line items gracefully', async () => {
        const emptyInvoice: InvoiceData = {
            ...sampleInvoice,
            lineItems: [],
            subtotal: 0,
            total: 95.77,
            amountDue: 95.77,
        };
        const buffer = await generateInvoicePDF(emptyInvoice);
        expect(buffer).toBeInstanceOf(Buffer);
        const doc = await PDFDocument.load(buffer);
        expect(doc.getPageCount()).toBe(1);
    });

    it('should generate a unique invoice number when not provided', async () => {
        const noInvNum: InvoiceData = {
            ...sampleInvoice,
            invoiceNumber: 'UNKNOWN',
        };
        const buffer = await generateInvoicePDF(noInvNum);
        const text = buffer.toString('latin1');
        expect(text).toContain('IG-');
    });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/lib/pdf/invoice-generator.test.ts`
Expected: FAIL — `generateInvoicePDF` not found.

### Step 3: Write the implementation

```typescript
// src/lib/pdf/invoice-generator.ts
/**
 * @file    invoice-generator.ts
 * @purpose Generates a professional PDF invoice from structured data extracted
 *          from an email body. Used when vendors send invoice details inline
 *          (no PDF attachment). The generated PDF is forwarded to Bill.com.
 * @author  Will
 * @created 2026-03-12
 * @updated 2026-03-12
 * @deps    pdf-lib, invoice-parser (InvoiceData type)
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { InvoiceData } from './invoice-parser';

/**
 * Generates a clean, professional PDF invoice from structured invoice data.
 *
 * The PDF is vendor-branded (uses vendor name as header) with a subtle footer
 * noting it was internally generated from email correspondence.
 *
 * DECISION(2026-03-12): PDF is styled as a vendor invoice document, not a
 * BuildASoil internal document. This is intentional — Bill.com parses vendor
 * invoices, so the format must match their expectations. A small footer
 * distinguishes it from original vendor-issued documents.
 *
 * @param   invoice  - Structured invoice data (from LLM extraction)
 * @param   sourceEmailDate - Optional date of the source email
 * @returns PDF buffer ready for email attachment
 */
export async function generateInvoicePDF(
    invoice: InvoiceData,
    sourceEmailDate?: string
): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]); // US Letter
    const { width, height } = page.getSize();

    const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const black = rgb(0, 0, 0);
    const darkGray = rgb(0.3, 0.3, 0.3);
    const medGray = rgb(0.5, 0.5, 0.5);
    const lightGray = rgb(0.85, 0.85, 0.85);
    const headerBg = rgb(0.15, 0.22, 0.35);
    const white = rgb(1, 1, 1);

    const margin = 50;
    let y = height - margin;

    // ── HEADER BAR ─────────────────────────────────────
    page.drawRectangle({
        x: 0, y: height - 90, width, height: 90,
        color: headerBg,
    });
    page.drawText(invoice.vendorName || 'Vendor Invoice', {
        x: margin, y: height - 55, size: 22, font: fontBold, color: white,
    });
    page.drawText('INVOICE', {
        x: width - margin - fontBold.widthOfTextAtSize('INVOICE', 20),
        y: height - 55, size: 20, font: fontBold, color: white,
    });

    y = height - 120;

    // ── INVOICE METADATA ───────────────────────────────
    const invoiceNumber = invoice.invoiceNumber !== 'UNKNOWN'
        ? invoice.invoiceNumber
        : generateInvoiceNumber(invoice.poNumber || null, invoice.invoiceDate);

    const metaRows: [string, string][] = [
        ['Invoice #:', invoiceNumber],
        ['Date:', invoice.invoiceDate || new Date().toISOString().split('T')[0]],
    ];
    if (invoice.poNumber) metaRows.push(['PO Reference:', `#${invoice.poNumber}`]);
    if (invoice.paymentTerms) metaRows.push(['Terms:', invoice.paymentTerms]);

    // Left column: Bill To
    page.drawText('Bill To:', { x: margin, y, size: 10, font: fontBold, color: darkGray });
    y -= 16;
    page.drawText('BuildASoil', { x: margin, y, size: 10, font: fontRegular, color: black });
    y -= 14;
    page.drawText('1455 Branding Iron Dr', { x: margin, y, size: 9, font: fontRegular, color: medGray });
    y -= 12;
    page.drawText('Montrose, CO 81401', { x: margin, y, size: 9, font: fontRegular, color: medGray });

    // Right column: metadata
    let metaY = height - 120;
    const metaX = width - margin - 200;
    for (const [label, value] of metaRows) {
        page.drawText(label, { x: metaX, y: metaY, size: 9, font: fontBold, color: darkGray });
        page.drawText(value, { x: metaX + 85, y: metaY, size: 9, font: fontRegular, color: black });
        metaY -= 16;
    }

    y = Math.min(y, metaY) - 30;

    // ── LINE ITEMS TABLE ───────────────────────────────
    const colX = { desc: margin, qty: margin + 280, unit: margin + 340, total: width - margin - 70 };

    page.drawRectangle({
        x: margin - 5, y: y - 4, width: width - 2 * margin + 10, height: 20, color: lightGray,
    });
    page.drawText('Description', { x: colX.desc, y, size: 9, font: fontBold, color: darkGray });
    page.drawText('Qty', { x: colX.qty, y, size: 9, font: fontBold, color: darkGray });
    page.drawText('Unit Price', { x: colX.unit, y, size: 9, font: fontBold, color: darkGray });
    page.drawText('Total', { x: colX.total, y, size: 9, font: fontBold, color: darkGray });
    y -= 22;

    for (const item of invoice.lineItems) {
        const desc = truncate(item.description || item.sku || 'Item', 45);
        page.drawText(desc, { x: colX.desc, y, size: 9, font: fontRegular, color: black });
        page.drawText(String(item.qty), { x: colX.qty, y, size: 9, font: fontRegular, color: black });
        page.drawText(fmtCurrency(item.unitPrice), { x: colX.unit, y, size: 9, font: fontRegular, color: black });
        page.drawText(fmtCurrency(item.total || item.qty * item.unitPrice), {
            x: colX.total, y, size: 9, font: fontRegular, color: black,
        });
        y -= 18;
        if (y < 120) break;
    }

    // ── TOTALS ─────────────────────────────────────────
    y -= 10;
    page.drawLine({
        start: { x: colX.unit - 10, y: y + 8 }, end: { x: width - margin + 5, y: y + 8 },
        thickness: 0.5, color: lightGray,
    });

    const totalsX = colX.unit - 10;
    const totalsValX = colX.total;

    if (invoice.subtotal > 0) {
        page.drawText('Subtotal:', { x: totalsX, y, size: 9, font: fontRegular, color: darkGray });
        page.drawText(fmtCurrency(invoice.subtotal), { x: totalsValX, y, size: 9, font: fontRegular, color: black });
        y -= 16;
    }
    if (invoice.freight) {
        page.drawText('Freight/Shipping:', { x: totalsX, y, size: 9, font: fontRegular, color: darkGray });
        page.drawText(fmtCurrency(invoice.freight), { x: totalsValX, y, size: 9, font: fontRegular, color: black });
        y -= 16;
    }
    if (invoice.tax) {
        page.drawText('Tax:', { x: totalsX, y, size: 9, font: fontRegular, color: darkGray });
        page.drawText(fmtCurrency(invoice.tax), { x: totalsValX, y, size: 9, font: fontRegular, color: black });
        y -= 16;
    }
    if (invoice.fuelSurcharge) {
        page.drawText('Fuel Surcharge:', { x: totalsX, y, size: 9, font: fontRegular, color: darkGray });
        page.drawText(fmtCurrency(invoice.fuelSurcharge), { x: totalsValX, y, size: 9, font: fontRegular, color: black });
        y -= 16;
    }

    y -= 8;
    page.drawLine({
        start: { x: totalsX, y: y + 14 }, end: { x: width - margin + 5, y: y + 14 },
        thickness: 1, color: headerBg,
    });
    page.drawText('TOTAL:', { x: totalsX, y, size: 12, font: fontBold, color: headerBg });
    page.drawText(fmtCurrency(invoice.total || invoice.amountDue), {
        x: totalsValX, y, size: 12, font: fontBold, color: headerBg,
    });

    // ── NOTES ──────────────────────────────────────────
    if (invoice.notes) {
        y -= 35;
        page.drawText('Notes:', { x: margin, y, size: 9, font: fontBold, color: darkGray });
        y -= 14;
        page.drawText(truncate(invoice.notes, 100), { x: margin, y, size: 9, font: fontRegular, color: medGray });
    }

    // ── FOOTER ─────────────────────────────────────────
    const footerY = 35;
    page.drawLine({
        start: { x: margin, y: footerY + 12 }, end: { x: width - margin, y: footerY + 12 },
        thickness: 0.5, color: lightGray,
    });
    page.drawText(
        'Created from email correspondence \u2014 Internally generated document',
        { x: margin, y: footerY, size: 7, font: fontRegular, color: medGray }
    );
    const genDate = sourceEmailDate || new Date().toISOString().split('T')[0];
    const rightFooter = `Generated ${genDate}`;
    page.drawText(rightFooter, {
        x: width - margin - fontRegular.widthOfTextAtSize(rightFooter, 7),
        y: footerY, size: 7, font: fontRegular, color: medGray,
    });

    const pdfBytes = await doc.save();
    return Buffer.from(pdfBytes);
}

/** Generate a synthetic invoice number. Format: IG-YYYY-MMDD-<PO#> */
function generateInvoiceNumber(poNumber: string | null, invoiceDate: string): string {
    const d = invoiceDate || new Date().toISOString().split('T')[0];
    const parts = d.split('-');
    const datePart = parts.length >= 3 ? `${parts[0]}-${parts[1]}${parts[2]}` : d.replace(/-/g, '');
    const poRef = poNumber || Math.random().toString(36).slice(2, 8).toUpperCase();
    return `IG-${datePart}-${poRef}`;
}

function fmtCurrency(n: number): string {
    return `$${n.toFixed(2)}`;
}

function truncate(s: string, maxLen: number): string {
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '\u2026' : s;
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/lib/pdf/invoice-generator.test.ts`
Expected: All 5 tests PASS.

### Step 5: Commit

```bash
git add src/lib/pdf/invoice-generator.ts src/lib/pdf/invoice-generator.test.ts
git commit -m "feat(pdf): add invoice generator for inline email invoices"
```

---

## Task 2: Inline Invoice Email Parser

Create the heuristic detector and LLM parser that identifies and extracts inline invoice data.

**Files:**
- Create: `src/lib/intelligence/inline-invoice-parser.ts`
- Test: `src/lib/intelligence/inline-invoice-parser.test.ts`
- Reference: `src/lib/pdf/invoice-parser.ts` (reuses `InvoiceSchema`)

### Step 1: Write the failing test

```typescript
// src/lib/intelligence/inline-invoice-parser.test.ts
import { describe, it, expect } from 'vitest';
import { detectInlineInvoice } from './inline-invoice-parser';

describe('detectInlineInvoice', () => {
    it('should detect an email with dollar amounts and cost breakdown', () => {
        const body = `Hi Bill,
        55 - 1# bags of 15-1-1
        Product cost: $1045.00
        Shipping: $95.77 UPS Ground
        Total: $1140.77`;
        expect(detectInlineInvoice(body, false)).toBe(true);
    });

    it('should NOT detect when a PDF is already attached', () => {
        const body = 'Here is your invoice for $500.00. Total: $500.00.';
        expect(detectInlineInvoice(body, true)).toBe(false);
    });

    it('should NOT detect casual price mentions without total/cost pattern', () => {
        const body = 'The product normally costs $20 per unit. Let me know if interested.';
        expect(detectInlineInvoice(body, false)).toBe(false);
    });

    it('should detect "total" + dollar amount pattern', () => {
        const body = `Invoice for PO #124462
        Subtotal: $500.00
        Freight: $50.00
        Total: $550.00`;
        expect(detectInlineInvoice(body, false)).toBe(true);
    });

    it('should detect "amount due" pattern', () => {
        const body = 'Amount due: $1,234.56. Shipping cost: $50.00. Please remit payment.';
        expect(detectInlineInvoice(body, false)).toBe(true);
    });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/lib/intelligence/inline-invoice-parser.test.ts`
Expected: FAIL — module not found.

### Step 3: Write the implementation

```typescript
// src/lib/intelligence/inline-invoice-parser.ts
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
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/lib/intelligence/inline-invoice-parser.test.ts`
Expected: All 5 tests PASS.

### Step 5: Commit

```bash
git add src/lib/intelligence/inline-invoice-parser.ts src/lib/intelligence/inline-invoice-parser.test.ts
git commit -m "feat(intelligence): add inline invoice detector and parser"
```

---

## Task 3: Inline Invoice Handler

Create the orchestrator that ties detection → parse → PDF → Bill.com → Finale → reply → notify.

**Files:**
- Create: `src/lib/intelligence/inline-invoice-handler.ts`

### Step 1: Create the handler

See full implementation in the brainstorming doc. Key orchestration steps:

1. Gate 1: `detectInlineInvoice()` heuristic check
2. Gate 2: `parseInlineInvoice()` LLM extraction — skip if confidence=low AND total=0
3. PO cross-reference via `FinaleClient.getOrderSummary(poNumber)`
4. Generate PDF via `generateInvoicePDF(invoiceData)`
5. Forward PDF to `buildasoilap@bill.com` via Gmail MIME
6. Reply "Got it, thank you!" to vendor (threaded)
7. Log to `invoices` and `ap_activity_log` tables
8. Notify via Telegram with full status summary

The handler class (`InlineInvoiceHandler`) takes a `Telegraf` bot in its constructor. It is lazy-loaded from the acknowledgement agent via `await import()`.

### Step 2: Commit

```bash
git add src/lib/intelligence/inline-invoice-handler.ts
git commit -m "feat(intelligence): add inline invoice handler workflow"
```

---

## Task 4: Wire Into Acknowledgement Agent

Add `INLINE_INVOICE` as a new intent to the ack agent classification.

**Files:**
- Modify: `src/lib/intelligence/acknowledgement-agent.ts`
  - Update LLM classification prompt to include `INLINE_INVOICE` intent definition
  - Add processing branch for `INLINE_INVOICE` in the main loop

### Step 1: Update classification prompt

Add to the intent definitions in `classifyEmailIntent()`:

```
INLINE_INVOICE — The email body contains cost breakdowns, dollar amounts, totals, freight charges, or other invoice-like data but NO PDF is attached. This is a structured cost breakdown (not a casual price mention).
```

### Step 2: Add processing branch

In `processUnreadEmails()`, after existing intent handling:

```typescript
if (intent === 'INLINE_INVOICE') {
    const { InlineInvoiceHandler } = await import('./inline-invoice-handler');
    const handler = new InlineInvoiceHandler(this.bot);
    const result = await handler.process(bodyText, subject, from, m.gmail_message_id, m.gmail_thread_id || m.gmail_message_id, hasPdf);
    if (result.processed) {
        await supabase.from('email_inbox_queue').update({ processed_by_ack: true }).eq('id', m.id);
    }
    continue;
}
```

### Step 3: Commit

```bash
git add src/lib/intelligence/acknowledgement-agent.ts
git commit -m "feat(intelligence): add INLINE_INVOICE intent to ack agent"
```

---

## Task 5: Daily Recap Update

Add `INLINE_INVOICE` to the daily recap emoji map.

**Files:**
- Modify: `src/lib/intelligence/ap-agent.ts:1220-1225` — add to `intentEmoji` map

### Step 1: Update emoji map

```typescript
const intentEmoji: Record<string, string> = {
    INVOICE: "\uD83E\uDDFE",
    STATEMENT: "\uD83D\uDCD1",
    HUMAN_INTERACTION: "\uD83D\uDC64",
    INLINE_INVOICE: "\uD83D\uDCE7",  // <-- ADD
};
```

### Step 2: Commit

```bash
git add src/lib/intelligence/ap-agent.ts
git commit -m "feat(ap-agent): add INLINE_INVOICE to daily recap"
```

---

## Task 6: Build Verification

### Step 1: TypeScript check

Run: `npx tsc --noEmit`
Expected: No type errors.

### Step 2: Run all tests

Run: `npx vitest run`
Expected: All tests pass.

### Step 3: Final commit

```bash
git add -A
git commit -m "feat(intelligence): complete inline invoice workflow

- PDF generator creates professional vendor-styled invoices from email data
- Inline invoice detector uses heuristic + LLM extraction pipeline
- Handler orchestrates: detect > parse > gen PDF > Bill.com > reply > notify
- Ack agent routes INLINE_INVOICE intent to new handler
- Daily recap includes inline invoice summaries"
```
