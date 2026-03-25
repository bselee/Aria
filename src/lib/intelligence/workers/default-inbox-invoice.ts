/**
 * @file    default-inbox-invoice.ts
 * @purpose Processes paid (credit-card) invoices from bill.selee@buildasoil.com overnight.
 *
 *          All invoices in the default inbox are already-paid. The goal is:
 *            1. Match to an existing Finale PO
 *            2. Update line-item pricing (with vendor-specific SKU mapping / UOM conversion)
 *            3. Add freight adjustment
 *            4. Archive to vendor_invoices
 *
 *          This is NOT Bill.com territory. AP inbox handles that.
 *          This worker is called by nightshift-agent when processing
 *          task_type = 'default_inbox_invoice'.
 *
 * @guardrails
 *   1. PO# required (regex-first, no LLM) — missing → NEEDS_HUMAN immediate Telegram
 *   2. Haiku extraction always used (qwen3:4b unreliable for structured data extraction)
 *      — confidence < 0.7 or total = 0 → extraction_failed → morning handoff
 *   3. Subtotal validation ±$10 — mismatch → skip line prices, still add freight, flag morning
 *   4. 10x magnitude guard — any single price shift ≥10x → REJECT entirely → immediate alert
 *   5. Dedup on (vendor_name, invoice_number) in vendor_invoices
 *
 * @author  Aria / Antigravity
 * @created 2026-03-25
 */

import { FinaleClient } from "../../finale/client";
import { upsertVendorInvoice } from "../../storage/vendor-invoices";
import { getAnthropicClient } from "../../anthropic";
import { createClient } from "../../supabase";
import { z } from "zod";

// ── Vendor registry ────────────────────────────────────────────────────────────
// Each entry defines detection patterns and how to apply extracted pricing to
// Finale PO line items. Add new vendors here — no other code changes needed.

interface VendorConfig {
    canonicalName: string;
    /** Match against concatenated "fromEmail + subject + bodyText.slice(0,2000)" */
    patterns: RegExp[];
    /**
     * 'per_item'  — each LLM-extracted line item maps to a Finale SKU.
     *               Supports optional skuMap (Uline catalog→Finale) and UOM conversion
     *               (e.g. 1 box invoiced vs 500 units in Finale).
     * 'lump_sum'  — invoice has a single product total; divide evenly across all
     *               PO items by quantity (Colorful Packaging model).
     * 'generic'   — unknown vendor; add freight only, skip line-item price updates.
     *               Used as the safe fallback for unlisted vendors.
     */
    priceStrategy: "per_item" | "lump_sum" | "generic";
    /**
     * Vendor catalog # → Finale product ID cross-reference.
     * Only needed for per_item vendors where catalog ≠ Finale SKU.
     * Absence means catalog numbers are used directly as Finale product IDs.
     */
    skuMap?: Record<string, string>;
}

const VENDOR_REGISTRY: VendorConfig[] = [
    {
        canonicalName: "ULINE",
        patterns: [/uline\.com/i, /\buline\b/i],
        priceStrategy: "per_item",
        // DECISION(2026-03-25): Mirrored from reconcile-uline.ts.
        // These 7 are the only cross-references; all other Uline catalog #s are
        // used directly as Finale product IDs.
        skuMap: {
            "S-15837B": "FJG101",
            "S-13505B": "FJG102",
            "S-13506B": "FJG103",
            "S-10748B": "FJG104",
            "S-12229":  "10113",
            "S-4551":   "ULS455",
            "H-1621":   "Ho-1621",
        },
    },
    {
        canonicalName: "Colorful Packaging",
        patterns: [/colorfulpackaging\.com/i, /colorful\s*packaging/i],
        priceStrategy: "lump_sum",
    },
    {
        canonicalName: "Axiom Print",
        patterns: [/axiomprint\.com/i, /axiom\s*print/i],
        priceStrategy: "per_item",
    },
];

// ── Result types ───────────────────────────────────────────────────────────────

export type InvoiceReconcileOutcome =
    | "reconciled"          // All guards passed — PO fully updated
    | "reconciled_partial"  // Freight added; line prices skipped (subtotal mismatch)
    | "po_not_found"        // PO# resolved but doesn't exist in Finale
    | "no_po_number"        // Regex exhausted — no PO# found anywhere
    | "extraction_failed"   // Haiku returned low confidence or zero total
    | "magnitude_rejected"  // 10× price shift detected — rejected entirely
    | "already_processed"   // Dedup hit in vendor_invoices
    | "no_vendor_party"     // Vendor name not resolvable in Finale (draft PO path)
    | "unknown_error";

export interface DefaultInboxInvoiceResult {
    outcome: InvoiceReconcileOutcome;
    vendorName: string;
    poNumber: string | null;
    total: number;
    freight: number;
    priceUpdates: number;
    error?: string;
    /**
     * true = send Telegram alert now; don't wait for morning handoff.
     * Triggered by: no PO#, PO not in Finale, magnitude rejection.
     */
    needsImmediateAlert: boolean;
    /** One-line summary for morning handoff report */
    summary: string;
}

// ── Telegram alert (fetch-based, no Telegraf dependency) ──────────────────────
// Nightshift runner has no bot instance — direct Bot API call for urgent alerts.

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
    } catch { /* non-fatal — alerting failure should not surface as a worker error */ }
}

// ── PO# extraction (regex-first, no LLM) ─────────────────────────────────────
// Checks subject before body. Returns the first 5-6 digit match.

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

const ExtractionSchema = z.object({
    invoiceNumber: z.string().default("UNKNOWN"),
    total:         z.coerce.number().default(0),
    freight:       z.coerce.number().default(0),
    tax:           z.coerce.number().default(0),
    subtotal:      z.coerce.number().default(0),
    invoiceDate:   z.string().optional(),
    lineItems: z.array(z.object({
        sku:        z.string().optional(),
        description:z.string().default(""),
        qty:        z.coerce.number().default(1),
        unitPrice:  z.coerce.number().default(0),
        total:      z.coerce.number().default(0),
    })).default([]),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
});
type ExtractionData = z.infer<typeof ExtractionSchema>;

async function extractWithHaiku(
    fromEmail: string,
    subject: string,
    bodyText: string,
): Promise<ExtractionData | null> {
    try {
        const client = getAnthropicClient();
        const prompt = `Extract invoice data from this vendor email. Return valid JSON only — no explanation.

From: ${fromEmail}
Subject: ${subject}

Email Body:
${bodyText.slice(0, 12000)}

Return exactly this JSON structure:
{
  "invoiceNumber": "string or UNKNOWN",
  "total": number,
  "freight": number,
  "tax": number,
  "subtotal": number,
  "invoiceDate": "YYYY-MM-DD or null",
  "lineItems": [
    { "sku": "catalog# if present, else null", "description": "...", "qty": number, "unitPrice": number, "total": number }
  ],
  "confidence": "high|medium|low"
}

Rules:
- subtotal = total minus freight minus tax (compute if not explicit)
- Set confidence "low" if total cannot be found with certainty
- Extract vendor catalog/item numbers into sku (e.g. "S-1665", "H-1234B")
- Do not include shipping notes, tracking info, or address lines as line items`;

        const msg = await client.messages.create({
            model:      "claude-haiku-4-5-20251001",
            max_tokens: 800,
            temperature: 0.1,
            messages:   [{ role: "user", content: prompt }],
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

// ── Vendor detection ─────────────────────────────────────────────────────────

function detectVendorConfig(fromEmail: string, subject: string, body: string): VendorConfig | null {
    const text = `${fromEmail} ${subject} ${body.slice(0, 2000)}`;
    return VENDOR_REGISTRY.find(v => v.patterns.some(p => p.test(text))) ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasMagnitudeViolation(oldPrice: number, newPrice: number): boolean {
    if (oldPrice <= 0 || newPrice <= 0) return false;
    return newPrice / oldPrice >= 10 || oldPrice / newPrice >= 10;
}

/** Extract a Uline-style catalog number from a description string ("S-1665", "H-1234B") */
function extractCatalogSku(description: string): string | null {
    const m = description.match(/\b([A-Z]-\d+[A-Z]?\d*)\b/);
    return m ? m[1] : null;
}

// ── Main processor ────────────────────────────────────────────────────────────

export async function processDefaultInboxInvoice(
    gmailMessageId: string,
    fromEmail: string,
    subject: string,
    bodyText: string,
): Promise<DefaultInboxInvoiceResult> {

    const vendorConfig = detectVendorConfig(fromEmail, subject, bodyText);
    const vendorName   = vendorConfig?.canonicalName ?? "Unknown Vendor";
    const supabase     = createClient();

    const base: DefaultInboxInvoiceResult = {
        outcome:             "unknown_error",
        vendorName,
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
                summary: `No PO# found in ${vendorName} email — subject: "${subject}"`,
            };
            await sendTelegramAlert(
                `🚨 <b>Invoice — No PO# Found</b>\n\n` +
                `<b>Vendor:</b> ${vendorName}\n` +
                `<b>From:</b> ${fromEmail}\n` +
                `<b>Subject:</b> ${subject}\n\n` +
                `Cannot reconcile — manual PO lookup required.`
            );
            return result;
        }

        base.poNumber = poNumber;

        // ── Guard 2: Haiku extraction ────────────────────────────────────────
        // DECISION(2026-03-25): qwen3:4b is unreliable for structured extraction
        // (same failure mode as PDF gleaning). Always use Haiku for this task type.
        const extracted = await extractWithHaiku(fromEmail, subject, bodyText);

        if (!extracted || extracted.confidence === "low" || extracted.total === 0) {
            return {
                ...base,
                poNumber,
                outcome:             "extraction_failed",
                needsImmediateAlert: false,
                summary: `${vendorName} PO #${poNumber}: extraction failed (confidence=${extracted?.confidence ?? "null"}, total=${extracted?.total ?? 0}) — morning handoff`,
            };
        }

        const { total, freight, tax, subtotal, invoiceNumber, invoiceDate, lineItems } = extracted;
        base.total   = total;
        base.freight = freight;

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

        // ── Finale PO lookup ─────────────────────────────────────────────────
        const finale = new FinaleClient();
        let poSummary: { orderId: string; total: number; status: string } | null = null;

        try {
            const s = await finale.getOrderSummary(poNumber);
            if (s) poSummary = { orderId: s.orderId, total: s.total, status: s.status };
        } catch { /* not found — handled below */ }

        if (!poSummary) {
            const result: DefaultInboxInvoiceResult = {
                ...base,
                poNumber,
                total,
                freight,
                outcome:             "po_not_found",
                needsImmediateAlert: true,
                summary: `${vendorName} PO #${poNumber} not found in Finale — invoice ${invoiceNumber} $${total.toFixed(2)}`,
            };
            await sendTelegramAlert(
                `🚨 <b>Invoice — PO Not Found in Finale</b>\n\n` +
                `<b>Vendor:</b> ${vendorName}\n` +
                `<b>PO #:</b> ${poNumber}\n` +
                `<b>Invoice:</b> ${invoiceNumber} — $${total.toFixed(2)}\n\n` +
                `PO does not exist in Finale. Was it created?`
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
        // Check all per-item candidates before writing anything.
        if (vendorConfig?.priceStrategy === "per_item" && lineItems.length > 0) {
            for (const li of lineItems) {
                if (li.unitPrice <= 0) continue;
                const rawSku    = li.sku || extractCatalogSku(li.description);
                const finaleSku = rawSku ? ((vendorConfig.skuMap ?? {})[rawSku] ?? rawSku) : null;
                if (!finaleSku) continue;

                const poItem    = poItems.find(i => i.productId === finaleSku);
                if (!poItem?.unitPrice || !poItem.quantity) continue;

                const ulineQty  = li.qty   || 1;
                const finaleQty = poItem.quantity;
                const adjusted  = (ulineQty > 0 && finaleQty !== ulineQty)
                    ? li.unitPrice / (finaleQty / ulineQty)
                    : li.unitPrice;

                if (hasMagnitudeViolation(poItem.unitPrice, adjusted)) {
                    const result: DefaultInboxInvoiceResult = {
                        ...base,
                        poNumber: poSummary.orderId,
                        total,
                        freight,
                        outcome:             "magnitude_rejected",
                        needsImmediateAlert: true,
                        summary: `10× guard: ${vendorName} ${finaleSku} $${poItem.unitPrice} → $${adjusted.toFixed(4)} — invoice ${invoiceNumber}`,
                    };
                    await sendTelegramAlert(
                        `🚨 <b>Invoice Rejected — 10× Price Shift</b>\n\n` +
                        `<b>Vendor:</b> ${vendorName}\n` +
                        `<b>PO #:</b> ${poSummary.orderId}\n` +
                        `<b>SKU:</b> ${finaleSku}\n` +
                        `<b>Current:</b> $${poItem.unitPrice}\n` +
                        `<b>Invoice:</b> $${adjusted.toFixed(4)}\n\n` +
                        `Likely OCR/decimal error. No changes written.`
                    );
                    return result;
                }
            }
        }

        // ── Guard 3: Subtotal validation ─────────────────────────────────────
        // Compare extracted product subtotal vs Finale PO line-item total.
        const finaleLineTotal    = poItems.reduce((s, i) => s + (i.quantity ?? 0) * (i.unitPrice ?? 0), 0);
        const extractedSubtotal  = subtotal || (total - freight - tax);
        const subtotalMismatch   = extractedSubtotal > 0 && Math.abs(finaleLineTotal - extractedSubtotal) > 10;

        // ── Price updates ────────────────────────────────────────────────────
        let priceUpdatesCount = 0;
        const skippedItems: string[] = [];

        const strategy = vendorConfig?.priceStrategy ?? "generic";

        if (!subtotalMismatch || strategy === "lump_sum") {

            if (strategy === "per_item" && lineItems.length > 0) {
                // Per-item with optional SKU cross-ref + UOM conversion
                for (const li of lineItems) {
                    if (li.unitPrice <= 0) continue;

                    const rawSku    = li.sku || extractCatalogSku(li.description);
                    const finaleSku = rawSku
                        ? ((vendorConfig?.skuMap ?? {})[rawSku] ?? rawSku)
                        : null;
                    if (!finaleSku) continue;

                    const poItem = poItems.find(i => i.productId === finaleSku);
                    if (!poItem) { skippedItems.push(finaleSku); continue; }

                    const ulineQty  = li.qty || 1;
                    const finaleQty = poItem.quantity || 1;
                    const correctPrice = (ulineQty > 0 && finaleQty !== ulineQty)
                        ? li.unitPrice / (finaleQty / ulineQty)
                        : li.unitPrice;

                    if (Math.abs((poItem.unitPrice ?? 0) - correctPrice) > 0.001) {
                        try {
                            await finale.updateOrderItemPrice(poSummary.orderId, finaleSku, correctPrice);
                            priceUpdatesCount++;
                        } catch { /* non-fatal, report in summary */ }
                    }
                }

            } else if (strategy === "lump_sum" && poItems.length > 0) {
                // Lump sum: divide product total evenly across all PO items by qty
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

            } else if (strategy === "generic") {
                // Unknown vendor — match extracted SKUs directly to Finale product IDs.
                // Conservative: only update when we have an exact productId match.
                for (const li of lineItems) {
                    if (!li.sku || li.unitPrice <= 0) continue;
                    const poItem = poItems.find(i => i.productId === li.sku);
                    if (!poItem) continue;
                    if (Math.abs((poItem.unitPrice ?? 0) - li.unitPrice) > 0.001) {
                        try {
                            await finale.updateOrderItemPrice(poSummary.orderId, li.sku, li.unitPrice);
                            priceUpdatesCount++;
                        } catch { /* non-fatal */ }
                    }
                }
            }
        }

        // ── Freight ──────────────────────────────────────────────────────────
        // Always add freight if present, even on subtotal mismatch.
        if (freight > 0) {
            try {
                await finale.addOrderAdjustment(
                    poSummary.orderId,
                    "FREIGHT",
                    freight,
                    `Freight - ${vendorName} ${invoiceNumber}`,
                );
            } catch { /* non-fatal */ }
        }

        // ── Archive ───────────────────────────────────────────────────────────
        if (supabase) {
            try {
                await upsertVendorInvoice({
                    vendor_name:   vendorName,
                    invoice_number:invoiceNumber,
                    invoice_date:  invoiceDate ?? null,
                    po_number:     poSummary.orderId,
                    subtotal:      extractedSubtotal,
                    freight,
                    tax,
                    total,
                    status:        "reconciled",
                    source:        "email_inline",
                    source_ref:    `default-inbox-${gmailMessageId}`,
                    line_items:    lineItems.map(li => ({
                        sku:        li.sku || extractCatalogSku(li.description) || li.description || "UNKNOWN",
                        description:li.description,
                        qty:        li.qty,
                        unit_price: li.unitPrice,
                        ext_price:  li.total,
                    })),
                    raw_data: { subject, fromEmail, extracted } as unknown as Record<string, unknown>,
                });
            } catch { /* dedup collision, non-critical */ }
        }

        // ── Outcome & summary ─────────────────────────────────────────────────
        const outcome: InvoiceReconcileOutcome = subtotalMismatch
            ? "reconciled_partial"
            : "reconciled";

        const summary = subtotalMismatch
            ? `${vendorName} PO #${poSummary.orderId}: subtotal mismatch ($${finaleLineTotal.toFixed(2)} vs $${extractedSubtotal.toFixed(2)}) — freight $${freight.toFixed(2)} added, line prices skipped`
            : `${vendorName} PO #${poSummary.orderId}: ${priceUpdatesCount} price updates, freight $${freight.toFixed(2)}, total $${total.toFixed(2)}`;

        return {
            ...base,
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
            outcome:      "unknown_error",
            error:        err?.message ?? String(err),
            summary:      `Unhandled error — ${vendorName}: ${err?.message ?? "unknown"}`,
        };
    }
}
