# AAA Cooper Statement Splitter — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When the AP Identifier classifies an email as `STATEMENT` and the vendor is known to bundle invoices (AAA Cooper-style), automatically split the PDF into individual invoices and queue each for Bill.com forwarding.

**Architecture:** Add a `handleMultiInvoiceStatement()` method to `APIdentifierAgent` that runs between `intent === "STATEMENT"` detection and the current dead-end label+archive. It checks if the sender matches a known multi-invoice vendor pattern, downloads the PDF, runs per-page LLM classification, splits out invoice pages by PRO number, uploads each to Supabase Storage, and queues each as `PENDING_FORWARD`. All existing building blocks (splitPdf, extractPerPage, ap_inbox_queue, ap-forwarder) are reused — no new infrastructure.

**Tech Stack:** TypeScript, pdf-lib (split), pdf-parse (extract), LLM (page classification via unifiedTextGeneration), Supabase Storage + ap_inbox_queue, existing AP Forwarder pipeline.

---

### Task 1: Add AAA Cooper sender detection constant

**Files:**
- Modify: `src/lib/intelligence/workers/ap-identifier.ts:31-90`

**Step 1: Add the multi-invoice vendor patterns array**

After the existing `PDF_BLOCK_PATTERNS` array (~line 90), add:

```typescript
// ── MULTI-INVOICE STATEMENT VENDORS ──────────────────────────────
// DECISION(2026-03-23): Some vendors send "statements" that are actually
// bundles of 3-6 individual invoices mixed with BOLs and cover letters.
// When these are classified as STATEMENT, we must split them into
// individual invoice PDFs and queue each for Bill.com forwarding.
const MULTI_INVOICE_STATEMENT_VENDORS: Array<{
    senderMatch: RegExp;
    filenameMatch?: RegExp;
    label: string;
}> = [
    {
        senderMatch: /aaa\s*cooper/i,
        filenameMatch: /ACT_STMD/i,
        label: 'AAA Cooper',
    },
];
```

**Step 2: Verify no lint/type errors**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "ap-identifier"`
Expected: No errors from ap-identifier.ts

**Step 3: Commit**

```bash
git add src/lib/intelligence/workers/ap-identifier.ts
git commit -m "feat(ap): add multi-invoice statement vendor detection constant"
```

---

### Task 2: Add the `handleMultiInvoiceStatement` method

**Files:**
- Modify: `src/lib/intelligence/workers/ap-identifier.ts` (add import + new method)

**Step 1: Add the unifiedTextGeneration import**

At the imports section (~line 25), add:

```typescript
import { unifiedTextGeneration } from "../llm";
```

(unifiedObjectGeneration is already imported from the same file — add unifiedTextGeneration alongside it.)

**Step 2: Add the method to APIdentifierAgent class**

Add this new private method to the class, after the existing `handlePaidInvoice` method (before `escapeHtml`):

```typescript
    // ──────────────────────────────────────────────────────────────────────────
    // MULTI-INVOICE STATEMENT HANDLER (AAA Cooper-style)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Splits a multi-invoice "statement" PDF into individual invoice PDFs.
     * 
     * AAA Cooper (and similar vendors) bundle 3-6 invoices into one PDF along
     * with BOLs, delivery receipts, and cover letters. Each invoice has its
     * own PRO number and needs to be sent individually to Bill.com.
     *
     * Process:
     * 1. Download the PDF attachment from Gmail
     * 2. Extract text per-page using pdf-lib + pdf-parse
     * 3. LLM classifies each page as INVOICE / BOL / COVER / OTHER
     * 4. For each INVOICE page: extract into its own PDF, name by PRO/invoice #
     * 5. Upload each to Supabase Storage
     * 6. Queue each as PENDING_FORWARD in ap_inbox_queue
     * 7. Existing AP Forwarder picks them up and sends to Bill.com
     *
     * @returns true if statement was successfully split and queued, false if
     *          it should fall through to default STATEMENT handling.
     */
    private async handleMultiInvoiceStatement(
        emailRow: any,
        gmail: any,
        supabase: any,
        vendorLabel: string,
    ): Promise<boolean> {
        const subject = emailRow.subject || 'No Subject';
        const from = emailRow.from_email || 'Unknown';
        const msgId = emailRow.gmail_message_id;

        console.log(`     ✂️ Multi-invoice statement detected (${vendorLabel}): "${subject}"`);

        // Step 1: Fetch full message and find PDF attachments
        let msg: any;
        try {
            msg = await gmail.users.messages.get({ userId: 'me', id: msgId });
        } catch (err: any) {
            console.error(`     ❌ Failed to fetch message for statement split:`, err.message);
            return false;
        }

        const pdfParts: any[] = [];
        const walkParts = (parts: any[]): void => {
            for (const part of parts) {
                if (part.filename && part.filename.toLowerCase().endsWith('.pdf')) {
                    pdfParts.push(part);
                }
                if (part.parts?.length) walkParts(part.parts);
            }
        };
        walkParts(msg.data.payload?.parts || []);

        if (pdfParts.length === 0) {
            console.log(`     ⚠️ No PDF attachment found on statement email — falling through`);
            return false;
        }

        // Process the first PDF attachment (statements are typically single-PDF)
        const pdfPart = pdfParts[0];
        if (!pdfPart.body?.attachmentId) return false;

        let buffer: Buffer;
        try {
            const response = await gmail.users.messages.attachments.get({
                userId: 'me',
                messageId: msgId,
                id: pdfPart.body.attachmentId,
            });
            const attachmentData = response.data.data;
            if (!attachmentData) return false;
            buffer = Buffer.from(attachmentData, 'base64url');
        } catch (err: any) {
            console.error(`     ❌ Failed to download PDF attachment:`, err.message);
            return false;
        }

        console.log(`     📄 Downloaded ${pdfPart.filename} (${(buffer.length / 1024).toFixed(0)} KB)`);

        // Step 2: Per-page text extraction
        const { extractPerPage } = await import('../../pdf/extractor');
        const { PDFDocument } = await import('pdf-lib');
        const pages = await extractPerPage(buffer);

        if (pages.length < 2) {
            console.log(`     ⚠️ Only ${pages.length} page(s) — not a multi-invoice statement`);
            return false;
        }

        console.log(`     🔬 Analyzing ${pages.length} pages for invoice identification...`);

        // Step 3: LLM per-page classification
        const pageAnalysis = await unifiedTextGeneration({
            system: `You analyze freight carrier statement documents page by page. These "statements" contain a mix of individual invoices, bills of lading (BOL), delivery receipts, and cover letters.

For each page, determine:
- INVOICE: An individual freight invoice with charges, a PRO number, shipper/consignee, and a total amount
- BOL: Bill of lading or delivery receipt
- COVER: Cover letter, summary page, or remittance advice
- OTHER: Any other page type

Return ONLY a JSON array with one object per page:
[{"page":1,"type":"COVER"},{"page":2,"type":"BOL"},{"page":3,"type":"INVOICE","invoiceNumber":"64471573","amount":470.51}]

For INVOICE pages, extract:
- invoiceNumber: The PRO number or invoice number (critical for filename)
- amount: The total charge amount

If no invoice number is found, use null.`,
            prompt: `${pages.length} pages from a ${vendorLabel} statement:\n\n${pages.map(p =>
                `=== PAGE ${p.pageNumber} ===\n${p.text.slice(0, 1000)}\n`
            ).join('\n')}`,
        });

        // Parse the LLM response
        let pageResults: Array<{
            page: number;
            type: string;
            invoiceNumber?: string | null;
            amount?: number | null;
        }> = [];
        try {
            const jsonMatch = pageAnalysis.match(/\[[\s\S]*?\]/);
            if (jsonMatch) pageResults = JSON.parse(jsonMatch[0]);
        } catch {
            console.error(`     ❌ Failed to parse page analysis JSON — aborting split`);
            return false;
        }

        const invoicePages = pageResults.filter(p => p.type === 'INVOICE');

        if (invoicePages.length === 0) {
            console.log(`     ⚠️ No invoice pages identified in statement — falling through`);
            return false;
        }

        console.log(`     📋 Found ${invoicePages.length} invoice(s): ${invoicePages.map(p => p.invoiceNumber || `page${p.page}`).join(', ')}`);

        // Step 4: Split PDF and queue each invoice
        const sourcePdf = await PDFDocument.load(buffer);
        let queuedCount = 0;

        for (const invPage of invoicePages) {
            const pageIdx = invPage.page - 1;
            if (pageIdx < 0 || pageIdx >= sourcePdf.getPageCount()) continue;

            const invNum = invPage.invoiceNumber || `page${invPage.page}`;
            const safeInvNum = invNum.replace(/[^a-zA-Z0-9-]/g, '_');
            const invFilename = `${safeInvNum}.pdf`;

            // Create single-page PDF
            const singlePdf = await PDFDocument.create();
            const [copiedPage] = await singlePdf.copyPages(sourcePdf, [pageIdx]);
            singlePdf.addPage(copiedPage);
            const pageBuffer = Buffer.from(await singlePdf.save());

            // Dedup check: same PRO number from same sender within 7 days
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const { data: existingInv } = await supabase
                .from('ap_inbox_queue')
                .select('id')
                .eq('email_from', from)
                .eq('pdf_filename', invFilename)
                .gte('created_at', sevenDaysAgo)
                .maybeSingle();

            if (existingInv) {
                console.log(`     ⚠️ DEDUP: ${invFilename} already queued from ${from} — skipping`);
                continue;
            }

            // Upload to Supabase Storage
            const storagePath = `${msgId}/split_${Date.now()}_${invFilename}`;
            const { error: uploadError } = await supabase.storage
                .from('ap_invoices')
                .upload(storagePath, pageBuffer, {
                    contentType: 'application/pdf',
                    upsert: true,
                });

            if (uploadError) {
                console.error(`     ❌ Storage upload failed for ${invFilename}:`, uploadError.message);
                continue;
            }

            // Queue as PENDING_FORWARD
            const uniqueMsgId = `${msgId}_split_${safeInvNum}`;
            const { error: insertError } = await supabase.from('ap_inbox_queue').insert({
                message_id: uniqueMsgId,
                email_from: from,
                email_subject: `${vendorLabel} Invoice ${invNum}`,
                intent: 'INVOICE',
                pdf_path: storagePath,
                pdf_filename: invFilename,
                status: 'PENDING_FORWARD',
                source_inbox: emailRow.source_inbox || 'ap',
            });

            if (insertError) {
                console.error(`     ❌ Queue insert failed for ${invFilename}:`, insertError.message);
                continue;
            }

            const amountStr = invPage.amount ? ` ($${invPage.amount.toFixed(2)})` : '';
            console.log(`     ✅ Queued ${invFilename}${amountStr} → PENDING_FORWARD`);
            queuedCount++;
        }

        if (queuedCount > 0) {
            await this.logActivity(
                supabase, from, subject, 'MULTI_INVOICE_STATEMENT',
                `Split ${vendorLabel} statement: ${queuedCount} invoice(s) queued for Bill.com`,
                {
                    vendor: vendorLabel,
                    invoicesFound: invoicePages.length,
                    invoicesQueued: queuedCount,
                    invoiceNumbers: invoicePages.map(p => p.invoiceNumber).filter(Boolean),
                    sourceFilename: pdfPart.filename,
                }
            );

            // Telegram notification
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId && this.bot) {
                const invoiceList = invoicePages
                    .map(p => {
                        const num = p.invoiceNumber || `page${p.page}`;
                        const amt = p.amount ? ` — $${p.amount.toFixed(2)}` : '';
                        return `  • ${num}${amt}`;
                    })
                    .join('\n');
                const total = invoicePages.reduce((sum, p) => sum + (p.amount || 0), 0);
                const totalStr = total > 0 ? `\n\n<b>Statement Total:</b> $${total.toFixed(2)}` : '';

                try {
                    await this.bot.telegram.sendMessage(chatId, [
                        `✂️ <b>${vendorLabel} Statement Split</b>`,
                        ``,
                        `Split <b>${queuedCount}</b> invoice(s) from statement:`,
                        invoiceList,
                        totalStr,
                        ``,
                        `📤 Queued for Bill.com forwarding`,
                    ].filter(Boolean).join('\n'), { parse_mode: 'HTML' });
                } catch { /* non-critical */ }
            }
        }

        return queuedCount > 0;
    }
```

**Step 3: Verify no lint/type errors**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "ap-identifier"`
Expected: No errors

**Step 4: Commit**

```bash
git add src/lib/intelligence/workers/ap-identifier.ts
git commit -m "feat(ap): add handleMultiInvoiceStatement method for AAA Cooper-style splitting"
```

---

### Task 3: Wire the handler into the STATEMENT classification path

**Files:**
- Modify: `src/lib/intelligence/workers/ap-identifier.ts:364-377` (the STATEMENT block)

**Step 1: Replace the STATEMENT dead-end with multi-invoice check**

Replace the current STATEMENT handler block:

```typescript
                if (intent === "STATEMENT") {
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: {
                                addLabelIds: [(await getLabels(sourceInbox)).statements],
                                removeLabelIds: ["INBOX", "UNREAD"]
                            }
                        });
                        await this.logActivity(supabase, from, subject, "STATEMENT", "Labeled as Statement, marked read");
                    } catch (e) { /* ignore */ }
                    continue;
                }
```

With:

```typescript
                if (intent === "STATEMENT") {
                    // ── CHECK: Is this a multi-invoice "statement"? ──────────
                    // DECISION(2026-03-23): Some vendors (AAA Cooper) send bundled
                    // invoices labeled as "statements." Before dead-ending, check
                    // if the sender matches a known multi-invoice vendor pattern.
                    // If so, split the PDF and queue individual invoices.
                    const pdfNames: string[] = m.pdf_filenames || [];
                    const multiInvVendor = MULTI_INVOICE_STATEMENT_VENDORS.find(v =>
                        v.senderMatch.test(from) ||
                        (v.filenameMatch && pdfNames.some((f: string) => v.filenameMatch!.test(f)))
                    );

                    if (multiInvVendor && m.gmail_message_id) {
                        try {
                            const handled = await this.handleMultiInvoiceStatement(
                                m, gmail, supabase, multiInvVendor.label,
                            );
                            if (handled) {
                                // Successfully split — label as processed and archive
                                try {
                                    await gmail.users.messages.modify({
                                        userId: "me",
                                        id: m.gmail_message_id,
                                        requestBody: {
                                            addLabelIds: [(await getLabels(sourceInbox)).invoiceFwd],
                                            removeLabelIds: ["INBOX", "UNREAD"]
                                        }
                                    });
                                } catch (e) { /* ignore */ }
                                continue;
                            }
                            // Fall through to normal STATEMENT handling if split failed
                        } catch (err: any) {
                            console.error(`     ❌ Multi-invoice statement split failed:`, err.message);
                            await this.logActivity(supabase, from, subject, "STATEMENT",
                                `Multi-invoice split failed: ${err.message} — falling back to label`);
                            // Fall through to normal STATEMENT handling
                        }
                    }

                    // Default STATEMENT handling: label and archive
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: {
                                addLabelIds: [(await getLabels(sourceInbox)).statements],
                                removeLabelIds: ["INBOX", "UNREAD"]
                            }
                        });
                        await this.logActivity(supabase, from, subject, "STATEMENT", "Labeled as Statement, marked read");
                    } catch (e) { /* ignore */ }
                    continue;
                }
```

**Step 2: Verify no lint/type errors**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "ap-identifier"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/lib/intelligence/workers/ap-identifier.ts
git commit -m "feat(ap): wire multi-invoice statement handler into STATEMENT classification path"
```

---

### Task 4: Update vendor memory seed with richer AAA Cooper pattern

**Files:**
- Modify: `src/lib/intelligence/vendor-memory.ts:186-197`

**Step 1: Update the AAA Cooper seed pattern**

Replace the existing AAACooper pattern:

```typescript
        {
            vendorName: 'AAACooper',
            documentType: 'STATEMENT',
            pattern: 'Sends multi-page documents labeled as "statements" where each page is actually an individual invoice. Not a typical account statement with aging.',
            handlingRule: 'Split each page into a separate PDF. Each page is one invoice. Extract invoice # from each page. Email each individual invoice PDF to bill.com.',
            invoiceBehavior: 'multi_page_split',
            forwardTo: 'buildasoilap@bill.com',
            exampleFilenames: ['ACT_STMD_ID_2409.PDF'],
            learnedFrom: 'manual',
            confidence: 0.95,
        },
```

With:

```typescript
        {
            vendorName: 'AAACooper',
            documentType: 'STATEMENT',
            pattern: 'Sends multi-page documents labeled as "statements" (e.g., ACT_STMD_ID_2416.PDF) containing 3-6 individual freight invoices mixed with BOLs, delivery receipts, and a cover letter. Each invoice has a unique PRO number. Not a typical account statement with aging.',
            handlingRule: 'Split the PDF into individual pages. Identify INVOICE pages by PRO number using per-page LLM classification. Name each invoice PDF by its PRO number (e.g., 64471573.pdf). Queue each for Bill.com forwarding. Discard BOL and cover letter pages.',
            invoiceBehavior: 'multi_page_split',
            forwardTo: 'buildasoilap@bill.com',
            exampleFilenames: ['ACT_STMD_ID_2409.PDF', 'ACT_STMD_ID_2416.PDF'],
            learnedFrom: 'manual',
            confidence: 0.95,
        },
```

**Step 2: Commit**

```bash
git add src/lib/intelligence/vendor-memory.ts
git commit -m "docs(memory): enrich AAA Cooper vendor pattern with PRO number and page structure details"
```

---

### Task 5: Update AP Pipeline SOP documentation

**Files:**
- Modify: `docs/ap-pipeline-sop.md`

**Step 1: Add section about multi-invoice statements**

After the existing "Known Limitations" section (line ~434), add a new section:

```markdown
---

## Multi-Invoice Statement Splitting (AAA Cooper)

**File:** `src/lib/intelligence/workers/ap-identifier.ts` → `handleMultiInvoiceStatement()`

Some vendors send bundled "statements" that actually contain multiple individual invoices mixed with BOLs and cover letters. The AP pipeline detects these vendors and automatically splits the PDF.

### How It Works

1. Email classified as `STATEMENT` by LLM
2. Sender/filename checked against `MULTI_INVOICE_STATEMENT_VENDORS` array
3. If match found:
   - Download PDF attachment from Gmail
   - Extract text per-page using pdf-lib + pdf-parse
   - LLM classifies each page as INVOICE / BOL / COVER / OTHER
   - Each INVOICE page → individual PDF named by PRO/invoice number
   - Each uploaded to Supabase Storage → queued as `PENDING_FORWARD`
   - AP Forwarder sends to Bill.com on next cycle
4. If no match → standard STATEMENT handling (label + archive)

### Supported Vendors

| Vendor | Sender Pattern | Filename Pattern | Invoice ID |
|--------|---------------|-----------------|------------|
| AAA Cooper | `/aaa\s*cooper/i` | `/ACT_STMD/i` | PRO number |

### Adding a New Multi-Invoice Vendor

1. Open `src/lib/intelligence/workers/ap-identifier.ts`
2. Add entry to `MULTI_INVOICE_STATEMENT_VENDORS`:
   ```typescript
   {
       senderMatch: /vendor-name/i,
       filenameMatch: /PATTERN/i,  // optional
       label: 'Vendor Display Name',
   },
   ```
3. Update vendor memory seed in `vendor-memory.ts`
4. `pm2 restart aria-bot`
```

**Step 2: Commit**

```bash
git add docs/ap-pipeline-sop.md
git commit -m "docs(ap): add multi-invoice statement splitting section to SOP"
```
