/**
 * @file    default-inbox-invoice.ts
 * @purpose Processes paid (credit-card) invoices from bill.selee@buildasoil.com overnight.
 *
 *          All invoices in the default inbox are already-paid. The goal is:
 *            1. Match to an existing Finale PO
 *            2. Update line-item pricing (vendor intelligence comes from Pinecone)
 *            3. Add freight adjustment
 *            4. Archive to vendor_invoices
 *            5. Write back what was learned to Pinecone for next time
 *
 *          NO hardcoded vendor list. Vendor-specific knowledge (SKU mappings,
 *          UOM conversion rules, price strategies) lives in Pinecone vendor-memory.
 *          Haiku reads that context and applies it. New vendors are handled
 *          generically on first encounter, then Pinecone learns from the result.
 *
 *          This is NOT Bill.com territory. AP inbox handles that.
 *          Called by nightshift-agent when processing task_type = 'default_inbox_invoice'.
 *
 * @guardrails
 *   1. PO# required (regex-first, no LLM) — missing → immediate Telegram alert
 *   2. Haiku extraction always (qwen3 unreliable for structured data)
 *      — confidence < 0.7 or total = 0 → extraction_failed → morning handoff
 *   3. Subtotal validation ±$10 — mismatch skips line prices, freight still added
 *   4. 10× magnitude guard — immediate Telegram, writes nothing
 *   5. Dedup on (vendor_name, invoice_number) in vendor_invoices
 *
 * @author  Aria / Antigravity
 * @created 2026-03-25
 */

import { FinaleClient } from "../../finale/client";
import { upsertVendorInvoice } from "../../storage/vendor-invoices";
import { getAnthropicClient } from "../../anthropic";
import { createClient } from "../../supabase";
import { findRelevantPatterns, storeVendorPattern } from "../vendor-memory";
import { z } from "zod";

// ── Result types ───────────────────────────────────────────────────────────────

export type InvoiceReconcileOutcome =
    | "reconciled"          // All guards passed — PO fully updated
    | "reconciled_partial"  // Freight added; line prices skipped (subtotal mismatch / freight_only strategy)
    | "po_not_found"        // PO# resolved but doesn't exist in Finale
    | "no_po_number"        // Regex exhausted — no PO# found
    | "extraction_failed"   // Haiku returned low confidence or zero total
    | "magnitude_rejected"  // 10× price shift detected — rejected entirely
    | "already_processed"   // Dedup hit in vendor_invoices
    | "unknown_error";

export interface DefaultInboxInvoiceResult {
    outcome: InvoiceReconcileOutcome;
    vendorName: string;
    poNumber: string | null;
    total: number;
    freight: number;
    priceUpdates: number;
    error?: string;
    /** true = Telegram alert sent immediately; don't wait for morning handoff */
    needsImmediateAlert: boolean;
    /** One-line summary for morning handoff report */
    summary: string;
}

// ── Telegram alert (fetch-based, no Telegraf dependency) ──────────────────────

async function sendTelegramAlert(html: string): Promise<void> {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }),
            signal:  AbortSignal.timeout(5000),
        });
    } catch { /* non-fatal */ }
}

// ── PO# extraction (regex-first, no LLM) ─────────────────────────────────────

function extractPONumber(subject: string, body: string): string | null {
    const PATTERNS = [
        /\bPO\s*#\s*(\d{5,6})\b/i,
        /\bPO-(\d{5,6})\b/i,
        /\bpurchase\s*order\s*(?:no\.?|#|number)\s*(\d{5,6})\b/i,
        /\border\s*(?:no\.?|#|number)\s*(\d{5,6})\b/i,
    ];
    for (const text of [subject, body.slice(0, 3000)]) {
        for (const p of PATTERNS) {
            const m = text.match(p);
            if (m) return m[1];
        }
    }
    return null;
}

// ── Haiku extraction schema ───────────────────────────────────────────────────
// Haiku is responsible for applying vendor intelligence from Pinecone context:
// SKU mapping, UOM conversion, price strategy determination.

const LineItemSchema = z.object({
    description:       z.string().default(""),
    invoicedQty:       z.coerce.number().default(1),
    invoicedUnitPrice: z.coerce.number().default(0),
    /**
     * The Finale product ID to update. Haiku applies any known SKU cross-reference
     * from vendor context (e.g. ULINE S-4551 → ULS455). Null if unknown.
     */
    finaleSku:         z.string().optional(),
    /**
     * The correct per-unit price for Finale. Haiku computes UOM conversion when
     * the vendor invoices by case/box but Finale tracks individual units:
     *   finalePricePerUnit = invoicedUnitPrice / (finaleQty / invoicedQty)
     * When no UOM difference, equals invoicedUnitPrice.
     */
    finalePricePerUnit:z.coerce.number().optional(),
    total:             z.coerce.number().default(0),
});

const ExtractionSchema = z.object({
    vendorName:     z.string().default("Unknown Vendor"),
    invoiceNumber:  z.string().default("UNKNOWN"),
    invoiceDate:    z.string().optional(),
    total:          z.coerce.number().default(0),
    freight:        z.coerce.number().default(0),
    tax:            z.coerce.number().default(0),
    subtotal:       z.coerce.number().default(0),
    /**
     * per_item   — each line item maps to a Finale SKU with individual pricing
     * lump_sum   — one product total divided evenly across all PO items by qty
     * freight_only — can extract freight but not individual line prices
     */
    priceStrategy:  z.enum(["per_item", "lump_sum", "freight_only"]).default("per_item"),
    lineItems:      z.array(LineItemSchema).default([]),
    confidence:     z.enum(["high", "medium", "low"]).default("medium"),
    /** What Haiku observed about this vendor's invoice format — stored in Pinecone after success */
    vendorLearning: z.string().optional(),
});
type ExtractionData = z.infer<typeof ExtractionSchema>;

// ── Haiku extraction ──────────────────────────────────────────────────────────

async function extractWithHaiku(
    fromEmail: string,
    subject: string,
    bodyText: string,
    vendorContext: string,
): Promise<ExtractionData | null> {
    try {
        const client = getAnthropicClient();

        const prompt = `You are processing a paid vendor invoice from bill.selee@buildasoil.com.
This is a CREDIT CARD already-paid vendor. PO# has been pre-extracted separately.

From: ${fromEmail}
Subject: ${subject}

${vendorContext
    ? `VENDOR MEMORY (apply this knowledge when extracting):\n${vendorContext}`
    : "No prior vendor knowledge — extract best-effort and describe what you observe."}

Email Body:
${bodyText.slice(0, 12000)}

Return valid JSON only — no explanation:
{
  "vendorName": "canonical vendor name",
  "invoiceNumber": "invoice or order number (UNKNOWN if not found)",
  "invoiceDate": "YYYY-MM-DD or null",
  "total": number,
  "freight": number,
  "tax": number,
  "subtotal": number,
  "priceStrategy": "per_item | lump_sum | freight_only",
  "lineItems": [
    {
      "description": "...",
      "invoicedQty": number,
      "invoicedUnitPrice": number,
      "finaleSku": "Finale product ID (apply SKU mapping from vendor memory if known; use catalog # if unknown; null if unresolvable)",
      "finalePricePerUnit": number,
      "total": number
    }
  ],
  "confidence": "high | medium | low",
  "vendorLearning": "one sentence about this vendor's invoice format for future reference"
}

Rules:
- subtotal = total - freight - tax (compute if not explicit)
- priceStrategy "lump_sum": vendor sends one product total, no per-SKU breakdown → empty lineItems array
- priceStrategy "freight_only": can read freight but line-item prices are not extractable → empty lineItems
- finalePricePerUnit: if vendor invoices N units but Finale PO has M units (UOM mismatch), compute invoicedUnitPrice / (M / N). When qty matches, finalePricePerUnit = invoicedUnitPrice
- Set confidence "low" when total dollar amount cannot be found with certainty
- vendorLearning: note price strategy, any SKU patterns, UOM behavior observed`;

        const msg = await client.messages.create({
            model:       "claude-haiku-4-5-20251001",
            max_tokens:  1000,
            temperature: 0.1,
            messages:    [{ role: "user", content: prompt }],
        });

        const text = msg.content
            .filter(b => b.type === "text")
            .map(b => (b as any).text)
            .join("");
        const raw = text.trim()
            .replace(/^```json\s*/i, "")
            .replace(/```$/, "")
            .trim();

        return ExtractionSchema.parse(JSON.parse(raw));
    } catch {
        return null;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasMagnitudeViolation(oldPrice: number, newPrice: number): boolean {
    if (oldPrice <= 0 || newPrice <= 0) return false;
    return newPrice / oldPrice >= 10 || oldPrice / newPrice >= 10;
}

// ── Main processor ────────────────────────────────────────────────────────────

export async function processDefaultInboxInvoice(
    gmailMessageId: string,
    fromEmail: string,
    subject: string,
    bodyText: string,
): Promise<DefaultInboxInvoiceResult> {

    const supabase = createClient();

    const base: DefaultInboxInvoiceResult = {
        outcome:             "unknown_error",
        vendorName:          "Unknown Vendor",
        poNumber:            null,
        total:               0,
        freight:             0,
        priceUpdates:        0,
        needsImmediateAlert: false,
        summary:             "",
    };

    try {
        // ── Guard 1: PO# required ────────────────────────────────────────────
        const poNumber = extractPONumber(subject, bodyText);

        if (!poNumber) {
            const result: DefaultInboxInvoiceResult = {
                ...base,
                outcome:             "no_po_number",
                needsImmediateAlert: true,
                summary: `No PO# found — subject: "${subject}" from ${fromEmail}`,
            };
            await sendTelegramAlert(
                `🚨 <b>Paid Invoice — No PO# Found</b>\n\n` +
                `<b>From:</b> ${fromEmail}\n` +
                `<b>Subject:</b> ${subject}\n\n` +
                `Cannot reconcile — manual PO lookup required.`
            );
            return result;
        }

        base.poNumber = poNumber;

        // ── Vendor context from Pinecone ─────────────────────────────────────
        // Semantic search across vendor-memory namespace using the email content.
        // Result is injected into the Haiku prompt so it can apply vendor-specific
        // intelligence: SKU mappings, UOM conversion, price strategy.
        let vendorContext = "";
        try {
            const searchText = `${fromEmail} ${subject} ${bodyText.slice(0, 500)}`;
            const patterns = await findRelevantPatterns(searchText, 2);
            if (patterns.length > 0) {
                vendorContext = patterns
                    .map(p => `[${p.vendorName}]\nPattern: ${p.pattern}\nHandling: ${p.handlingRule}`)
                    .join("\n\n");
            }
        } catch { /* Pinecone unavailable — continue without context */ }

        // ── Guard 2: Haiku extraction ────────────────────────────────────────
        // qwen3 skipped — unreliable for structured extraction.
        const extracted = await extractWithHaiku(fromEmail, subject, bodyText, vendorContext);

        if (!extracted || extracted.confidence === "low" || extracted.total === 0) {
            return {
                ...base,
                poNumber,
                outcome:             "extraction_failed",
                needsImmediateAlert: false,
                summary: `${fromEmail} PO #${poNumber}: extraction failed (conf=${extracted?.confidence ?? "null"}, total=${extracted?.total ?? 0})`,
            };
        }

        const { vendorName, total, freight, tax, subtotal, invoiceNumber, invoiceDate,
                lineItems, priceStrategy, vendorLearning } = extracted;
        base.vendorName = vendorName;
        base.total      = total;
        base.freight    = freight;

        // ── Dedup guard ───────────────────────────────────────────────────────
        if (supabase && invoiceNumber !== "UNKNOWN") {
            try {
                const { data: existing } = await supabase
                    .from("vendor_invoices")
                    .select("id, po_number")
                    .eq("vendor_name", vendorName)
                    .eq("invoice_number", invoiceNumber)
                    .limit(1);

                if (existing && existing.length > 0) {
                    return {
                        ...base,
                        poNumber,
                        total,
                        freight,
                        outcome: "already_processed",
                        summary: `Dedup: ${vendorName} ${invoiceNumber} already archived → PO #${existing[0].po_number}`,
                    };
                }
            } catch { /* non-fatal */ }
        }

        // ── Finale PO lookup ──────────────────────────────────────────────────
        const finale = new FinaleClient();
        let poSummary: { orderId: string; total: number; status: string } | null = null;

        try {
            const s = await finale.getOrderSummary(poNumber);
            if (s) poSummary = { orderId: s.orderId, total: s.total, status: s.status };
        } catch { /* not found */ }

        if (!poSummary) {
            const result: DefaultInboxInvoiceResult = {
                ...base,
                poNumber,
                total,
                freight,
                vendorName,
                outcome:             "po_not_found",
                needsImmediateAlert: true,
                summary: `${vendorName} PO #${poNumber} not found in Finale — invoice ${invoiceNumber} $${total.toFixed(2)}`,
            };
            await sendTelegramAlert(
                `🚨 <b>Paid Invoice — PO Not Found</b>\n\n` +
                `<b>Vendor:</b> ${vendorName}\n` +
                `<b>PO #:</b> ${poNumber}\n` +
                `<b>Invoice:</b> ${invoiceNumber} — $${total.toFixed(2)}\n\n` +
                `PO does not exist in Finale.`
            );
            return result;
        }

        const poDetails = await finale.getOrderDetails(poNumber);
        const poItems = ((poDetails.orderItemList || []) as Array<{
            productId?: string;
            quantity?:  number;
            unitPrice?: number;
        }>).filter(i => !!i.productId);

        // ── Guard 4: 10× magnitude check ─────────────────────────────────────
        for (const li of lineItems) {
            const price = li.finalePricePerUnit ?? li.invoicedUnitPrice;
            if (!li.finaleSku || price <= 0) continue;
            const poItem = poItems.find(i => i.productId === li.finaleSku);
            if (!poItem?.unitPrice) continue;
            if (hasMagnitudeViolation(poItem.unitPrice, price)) {
                const result: DefaultInboxInvoiceResult = {
                    ...base,
                    poNumber: poSummary.orderId,
                    total,
                    freight,
                    vendorName,
                    outcome:             "magnitude_rejected",
                    needsImmediateAlert: true,
                    summary: `10× guard: ${vendorName} ${li.finaleSku} $${poItem.unitPrice} → $${price.toFixed(4)} — invoice ${invoiceNumber}`,
                };
                await sendTelegramAlert(
                    `🚨 <b>Invoice Rejected — 10× Price Shift</b>\n\n` +
                    `<b>Vendor:</b> ${vendorName}\n` +
                    `<b>PO #:</b> ${poSummary.orderId}\n` +
                    `<b>SKU:</b> ${li.finaleSku}\n` +
                    `<b>Current:</b> $${poItem.unitPrice} → <b>Invoice:</b> $${price.toFixed(4)}\n\n` +
                    `Likely OCR or decimal error. No changes written.`
                );
                return result;
            }
        }

        // ── Guard 3: Subtotal validation ─────────────────────────────────────
        const finaleLineTotal   = poItems.reduce((s, i) => s + (i.quantity ?? 0) * (i.unitPrice ?? 0), 0);
        const extractedSubtotal = subtotal || (total - freight - tax);
        const subtotalMismatch  = priceStrategy === "per_item" &&
                                  extractedSubtotal > 0 &&
                                  Math.abs(finaleLineTotal - extractedSubtotal) > 10;

        // ── Price updates ────────────────────────────────────────────────────
        let priceUpdatesCount = 0;

        if (!subtotalMismatch) {
            if (priceStrategy === "per_item" && lineItems.length > 0) {
                // Haiku has already applied SKU mapping and UOM conversion.
                // We just loop and apply.
                for (const li of lineItems) {
                    const finaleSku = li.finaleSku;
                    const price     = li.finalePricePerUnit ?? li.invoicedUnitPrice;
                    if (!finaleSku || price <= 0) continue;

                    const poItem = poItems.find(i => i.productId === finaleSku);
                    if (!poItem) continue;

                    if (Math.abs((poItem.unitPrice ?? 0) - price) > 0.001) {
                        try {
                            await finale.updateOrderItemPrice(poSummary.orderId, finaleSku, price);
                            priceUpdatesCount++;
                        } catch { /* non-fatal */ }
                    }
                }

            } else if (priceStrategy === "lump_sum" && poItems.length > 0) {
                // Divide product total evenly by PO qty
                const productTotal = total - freight - tax;
                const totalPOQty   = poItems.reduce((s, i) => s + (i.quantity ?? 0), 0);
                if (totalPOQty > 0 && productTotal > 0) {
                    const perUnit = Math.round((productTotal / totalPOQty) * 10000) / 10000;
                    for (const item of poItems) {
                        if (Math.abs((item.unitPrice ?? 0) - perUnit) > 0.001) {
                            try {
                                await finale.updateOrderItemPrice(poSummary.orderId, item.productId!, perUnit);
                                priceUpdatesCount++;
                            } catch { /* non-fatal */ }
                        }
                    }
                }
            }
            // freight_only: no line updates, just fall through to freight section
        }

        // ── Freight ───────────────────────────────────────────────────────────
        if (freight > 0) {
            try {
                await finale.addOrderAdjustment(
                    poSummary.orderId, "FREIGHT", freight,
                    `Freight - ${vendorName} ${invoiceNumber}`,
                );
            } catch { /* non-fatal */ }
        }

        // ── Archive ───────────────────────────────────────────────────────────
        if (supabase) {
            try {
                await upsertVendorInvoice({
                    vendor_name:    vendorName,
                    invoice_number: invoiceNumber,
                    invoice_date:   invoiceDate ?? null,
                    po_number:      poSummary.orderId,
                    subtotal:       extractedSubtotal,
                    freight,
                    tax,
                    total,
                    status:         "reconciled",
                    source:         "email_inline",
                    source_ref:     `default-inbox-${gmailMessageId}`,
                    line_items:     lineItems.map(li => ({
                        sku:         li.finaleSku || li.description || "UNKNOWN",
                        description: li.description,
                        qty:         li.invoicedQty,
                        unit_price:  li.finalePricePerUnit ?? li.invoicedUnitPrice,
                        ext_price:   li.total,
                    })),
                    raw_data: { subject, fromEmail, extracted } as unknown as Record<string, unknown>,
                });
            } catch { /* dedup collision */ }
        }

        // ── Write-back to Pinecone ────────────────────────────────────────────
        // Store what was learned about this vendor so future invoices get richer context.
        // Only write when Haiku produced a confident result with useful observations.
        if (vendorLearning && vendorName !== "Unknown Vendor" && extracted.confidence !== "low") {
            try {
                await storeVendorPattern({
                    vendorName,
                    documentType: "INVOICE",
                    pattern: vendorLearning,
                    handlingRule: `priceStrategy=${priceStrategy}. Credit card paid — never Bill.com. ` +
                                  `${priceStrategy === "per_item" && lineItems.some(l => l.finaleSku)
                                       ? `Known Finale SKUs observed: ${lineItems.filter(l => l.finaleSku).map(l => l.finaleSku).join(", ")}.`
                                       : ""}`,
                    invoiceBehavior: "single_page",
                    forwardTo: "",
                    learnedFrom: "email",
                    confidence: extracted.confidence === "high" ? 0.9 : 0.7,
                });
            } catch { /* non-fatal */ }
        }

        // ── Outcome ───────────────────────────────────────────────────────────
        const partial  = subtotalMismatch || priceStrategy === "freight_only";
        const outcome: InvoiceReconcileOutcome = partial ? "reconciled_partial" : "reconciled";
        const summary  = partial
            ? `${vendorName} PO #${poSummary.orderId}: ${subtotalMismatch ? `subtotal mismatch ($${finaleLineTotal.toFixed(2)} vs $${extractedSubtotal.toFixed(2)})` : "freight_only"} — freight $${freight.toFixed(2)} added`
            : `${vendorName} PO #${poSummary.orderId}: ${priceUpdatesCount} price updates, freight $${freight.toFixed(2)}, total $${total.toFixed(2)}`;

        return {
            ...base,
            vendorName,
            poNumber:     poSummary.orderId,
            total,
            freight,
            priceUpdates: priceUpdatesCount,
            outcome,
            summary,
        };

    } catch (err: any) {
        return {
            ...base,
            outcome: "unknown_error",
            error:   err?.message ?? String(err),
            summary: `Unhandled error — ${fromEmail}: ${err?.message ?? "unknown"}`,
        };
    }
}
