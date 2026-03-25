/**
 * @file    inline-invoice-handler.ts
 * @purpose Handles inline invoice emails (no PDF) from the default inbox
 *          (bill.selee@buildasoil.com). Extracts invoice data via LLM,
 *          matches to an existing Finale PO or creates a draft PO with
 *          all details (line items, freight, dates). Notifies via Telegram.
 *
 *          IMPORTANT: This handler is ONLY called from the AcknowledgementAgent
 *          which runs on the default inbox (bill.selee@buildasoil.com).
 *          Invoices from this inbox should NEVER flow to Bill.com — they go
 *          to PO creation/matching only. Bill.com forwarding is exclusively
 *          handled by the AP Identifier on the ap@buildasoil.com inbox.
 *
 * @author  Will
 * @created 2026-03-12
 * @updated 2026-03-23
 * @deps    inline-invoice-parser, finale/client, storage/vendor-invoices, telegraf
 *
 * DECISION(2026-03-23): Removed all Bill.com forwarding and auto-reply logic.
 * The default inbox should NEVER send invoices to Bill.com — that is the AP
 * inbox's job. All inline invoices detected here route to PO creation/matching.
 */

import { parseInlineInvoice, detectInlineInvoice } from './inline-invoice-parser';
import { FinaleClient } from '../finale/client';
import { createClient } from '../supabase';
import { upsertVendorInvoice } from '../storage/vendor-invoices';
import type { Telegraf, Context } from 'telegraf';

const supabase = createClient();

export class InlineInvoiceHandler {
    constructor(private readonly bot: Telegraf<Context>) { }

    /**
     * Processes an email body for inline invoice data. If detected, extracts
     * all details via LLM, matches or creates a draft PO in Finale, and
     * notifies via Telegram. Never forwards to Bill.com.
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

            // Gate 2: LLM Extraction — get structured line items, freight, dates
            logs.push("Detected inline invoice data. Extracting...");

    

            // ── COLORFUL PACKAGING SHORTCUT ──────────────────────────────
            // Credit-card paid vendor — never Bill.com. PO# is typically in
            // the subject line (e.g., "Packaging Bags #124481" or "PO-124481").
            // Extract PO#, match to Finale, update pricing + add freight.
            const isColorful = /colorful\s*packaging/i.test(subject) ||
                               /colorful\s*packaging/i.test(fromEmail) ||
                               /colorfulpackaging\.com/i.test(bodyText) ||
                               /colorfulpackaging\.com/i.test(fromEmail);

            if (isColorful) {
                logs.push("📦 Colorful Packaging detected — extracting PO# and pricing");
                try {
                    // Extract PO# from subject or body
                    // Patterns: "#124481", "PO-124481", "PO 124481", "Packaging Bags #124481"
                    const poMatch = (subject + ' ' + bodyText).match(/(?:PO[-\s#]?|#)(\d{5,6})/i);
                    const poNumber = poMatch ? poMatch[1] : null;

                    if (poNumber) {
                        logs.push(`  Found PO reference: #${poNumber}`);
                    }

                    // LLM extract pricing and shipping from email body
                    const invoiceData = await parseInlineInvoice(bodyText, subject, fromEmail);
                    const total = invoiceData.total || invoiceData.amountDue || 0;
                    const freight = invoiceData.freight || 0;
                    const invoiceNumber = invoiceData.invoiceNumber || 'UNKNOWN';
                    const productTotal = total - freight; // EXW price (product cost excluding shipping)

                    logs.push(`  Invoice: ${invoiceNumber} — Total $${total.toFixed(2)} (product $${productTotal.toFixed(2)} + freight $${freight.toFixed(2)})`);

                    // Dedup check
                    let alreadyProcessed = false;
                    try {
                        const { data: existing } = await supabase
                            .from('vendor_invoices')
                            .select('id, po_number')
                            .eq('vendor_name', 'Colorful Packaging')
                            .eq('invoice_number', invoiceNumber)
                            .limit(1);

                        if (existing && existing.length > 0 && existing[0].po_number) {
                            logs.push(`⚠️ DEDUP: Already processed ${invoiceNumber} → PO #${existing[0].po_number}`);
                            alreadyProcessed = true;
                        }
                    } catch { /* table may not exist */ }

                    if (!alreadyProcessed) {
                        const finale = new FinaleClient();

                        if (poNumber) {
                            // Match to existing PO and update pricing + freight
                            try {
                                const summary = await finale.getOrderSummary(poNumber);
                                if (summary) {
                                    logs.push(`✅ Matched PO #${summary.orderId} (status: ${summary.status}, current total: $${summary.total.toFixed(2)})`);

                                    // ── PRICING UPDATE ──────────────────────────────
                                    // Colorful Packaging invoices show a lump product cost
                                    // (e.g., $1,050 for 3000pcs). We split evenly across
                                    // PO line items: $1050 / 3000 = $0.35/ea.
                                    const poDetails = await finale.getOrderDetails(poNumber);
                                    // DECISION(2026-03-23): Filter to real product lines only.
                                    // Finale POs include phantom header/shipment rows in orderItemList
                                    // that have no productId. Only update items with a real SKU.
                                    const poItems = ((poDetails.orderItemList || []) as Array<{
                                        productId?: string;
                                        unitPrice?: number;
                                        quantity?: number;
                                    }>).filter(item => !!item.productId);

                                    // Total PO qty across real line items only
                                    const totalPOQty = poItems.reduce((sum, item) => sum + (item.quantity || 0), 0);

                                    if (totalPOQty > 0 && productTotal > 0) {
                                        const perUnit = Math.round((productTotal / totalPOQty) * 10000) / 10000; // 4-decimal precision
                                        logs.push(`  📊 Per-unit price: $${productTotal.toFixed(2)} ÷ ${totalPOQty} qty = $${perUnit.toFixed(4)}/ea`);

                                        let priceUpdates: string[] = [];
                                        for (const item of poItems) {
                                            const oldPrice = item.unitPrice ?? 0;
                                            if (Math.abs(oldPrice - perUnit) > 0.001) {
                                                try {
                                                    await finale.updateOrderItemPrice(
                                                        summary.orderId,
                                                        item.productId!,
                                                        perUnit
                                                    );
                                                    priceUpdates.push(`${item.productId}: $${oldPrice.toFixed(4)} → $${perUnit.toFixed(4)}`);
                                                } catch (priceErr: any) {
                                                    logs.push(`  ⚠️ Price update failed for ${item.productId}: ${priceErr.message}`);
                                                }
                                            } else {
                                                logs.push(`  ✓ ${item.productId} already at $${perUnit.toFixed(4)}`);
                                            }
                                        }

                                        if (priceUpdates.length > 0) {
                                            logs.push(`  ✅ Updated pricing: ${priceUpdates.join(', ')}`);
                                        }
                                    } else {
                                        logs.push(`  ⚠️ Cannot compute per-unit: totalPOQty=${totalPOQty}, productTotal=$${productTotal.toFixed(2)}`);
                                    }

                                    // Add freight if present
                                    if (freight > 0) {
                                        try {
                                            await finale.addOrderAdjustment(
                                                summary.orderId,
                                                'FREIGHT',
                                                freight,
                                                `Freight - Colorful Packaging ${invoiceNumber}`
                                            );
                                            logs.push(`  + Added freight: $${freight.toFixed(2)}`);
                                        } catch (freightErr: any) {
                                            logs.push(`  ⚠️ Freight add failed: ${freightErr.message}`);
                                        }
                                    }

                                    // Archive to vendor_invoices
                                    try {
                                        await upsertVendorInvoice({
                                            vendor_name: 'Colorful Packaging',
                                            invoice_number: invoiceNumber,
                                            invoice_date: invoiceData.invoiceDate ?? null,
                                            po_number: summary.orderId,
                                            subtotal: productTotal,
                                            freight,
                                            tax: 0,
                                            total,
                                            status: 'reconciled',
                                            source: 'email_attachment',
                                            source_ref: `colorful-auto-${messageId}`,
                                            line_items: invoiceData.lineItems?.map(li => ({
                                                sku: li.sku || li.description || 'PACKAGING',
                                                description: li.description || '',
                                                qty: li.qty || 0,
                                                unit_price: li.unitPrice || 0,
                                                ext_price: li.total || 0,
                                            })) || [],
                                            raw_data: { subject, fromEmail, invoiceData } as unknown as Record<string, unknown>,
                                        });
                                    } catch { /* dedup collision */ }

                                    // Telegram notification
                                    const chatId = process.env.TELEGRAM_CHAT_ID;
                                    if (chatId && this.bot) {
                                        const perUnitDisplay = totalPOQty > 0 && productTotal > 0
                                            ? `$${productTotal.toFixed(2)} ÷ ${totalPOQty} = <b>$${(productTotal / totalPOQty).toFixed(4)}/ea</b>`
                                            : 'N/A';
                                        const skuLines = poItems
                                            .map(item => `  • ${item.productId}: ${item.quantity} × $${(productTotal / totalPOQty).toFixed(4)}`)
                                            .join('\n');
                                        const msg = [
                                            `📦 <b>Colorful Packaging — PO Updated</b>`,
                                            ``,
                                            `<b>PO #</b>${summary.orderId}`,
                                            `<b>Invoice:</b> ${invoiceNumber}`,
                                            `<b>Product:</b> $${productTotal.toFixed(2)}`,
                                            `<b>Per Unit:</b> ${perUnitDisplay}`,
                                            `<b>Freight:</b> $${freight.toFixed(2)}`,
                                            `<b>Total DDP:</b> $${total.toFixed(2)}`,
                                            skuLines ? `\n<b>PO Line Items:</b>\n${skuLines}` : null,
                                            `\n✅ Pricing + freight updated.`,
                                        ].filter(Boolean).join('\n');

                                        await this.bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });
                                    }

                                    return { processed: true, logs };
                                }
                            } catch (matchErr: any) {
                                logs.push(`⚠️ PO lookup for #${poNumber} failed: ${matchErr.message}`);
                            }
                        }

                        // No PO match — fall through to generic draft PO creation below
                        logs.push("No PO match — falling through to draft PO creation");
                    } else {
                        return { processed: true, logs };
                    }
                } catch (cpErr: any) {
                    logs.push(`⚠️ Colorful Packaging handler error: ${cpErr.message}. Falling back to generic.`);
                }
            }

            const invoiceData = await parseInlineInvoice(bodyText, subject, fromEmail);

            if (invoiceData.confidence === 'low' && invoiceData.total === 0) {
                logs.push("Skipped: LLM could not extract valid invoice data (confidence low, total 0).");
                return { processed: false, logs };
            }

            const total = invoiceData.total || invoiceData.amountDue || 0;
            const freight = invoiceData.freight || 0;
            const invoiceNumber = invoiceData.invoiceNumber || 'UNKNOWN';

            logs.push(`Extracted: ${invoiceData.vendorName} — Invoice ${invoiceNumber} — $${total.toFixed(2)} (${invoiceData.lineItems?.length || 0} line items)`);

            // ── PO MATCHING ──────────────────────────────────────────────
            const finale = new FinaleClient();
            let matchedPO: { orderId: string; total: number; status: string } | null = null;

            // 1a. Direct PO# lookup if the invoice references one
            if (invoiceData.poNumber) {
                try {
                    const summary = await finale.getOrderSummary(invoiceData.poNumber);
                    if (summary) {
                        matchedPO = { orderId: summary.orderId, total: summary.total, status: summary.status };
                        logs.push(`✅ Matched by PO# ${summary.orderId} (status: ${summary.status})`);
                    }
                } catch {
                    logs.push(`⚠️ Direct PO# lookup for ${invoiceData.poNumber} failed, trying fuzzy match...`);
                }
            }

            // 1b. Fuzzy match by vendor name + date + amount
            if (!matchedPO) {
                try {
                    const candidates = await finale.findPOByVendorAndDate(
                        invoiceData.vendorName,
                        invoiceData.invoiceDate || new Date().toISOString().split('T')[0],
                        60 // 60-day window
                    );
                    if (candidates.length > 0) {
                        const amountMatch = candidates.find(c =>
                            Math.abs(c.total - total) < 1.00
                        );
                        const best = amountMatch || candidates[0];
                        matchedPO = { orderId: best.orderId, total: best.total, status: best.status };
                        logs.push(`✅ Fuzzy-matched to PO #${best.orderId} ($${best.total.toFixed(2)}, ${best.status})`);
                    }
                } catch (e: any) {
                    logs.push(`⚠️ Fuzzy PO match failed: ${e.message}`);
                }
            }

            // ── DRAFT PO CREATION (if no existing match) ─────────────────
            let draftInfo: { orderId: string; finaleUrl: string } | null = null;
            let skipDraftCreation = false;

            // DEDUP GUARD: prevent creating multiple POs for the same vendor/invoice
            if (!matchedPO) {
                try {
                    // Check vendor_invoices table
                    const { data: existingVI } = await supabase
                        .from('vendor_invoices')
                        .select('id, po_number')
                        .eq('vendor_name', invoiceData.vendorName)
                        .eq('invoice_number', invoiceNumber)
                        .limit(1);

                    if (existingVI && existingVI.length > 0 && existingVI[0].po_number) {
                        logs.push(`⚠️ DEDUP: PO #${existingVI[0].po_number} already exists for this invoice. Skipping draft creation.`);
                        matchedPO = { orderId: existingVI[0].po_number, total, status: 'Draft' };
                        skipDraftCreation = true;
                    }
                } catch { /* table may not exist */ }

                // Also check paid_invoices table
                if (!skipDraftCreation) {
                    try {
                        const { data: existingPaid } = await supabase
                            .from('paid_invoices')
                            .select('id, po_number')
                            .eq('vendor_name', invoiceData.vendorName)
                            .eq('invoice_number', invoiceNumber)
                            .not('po_number', 'is', null)
                            .limit(1);

                        if (existingPaid && existingPaid.length > 0 && existingPaid[0].po_number) {
                            logs.push(`⚠️ DEDUP: PO #${existingPaid[0].po_number} already exists in paid_invoices. Skipping.`);
                            matchedPO = { orderId: existingPaid[0].po_number, total, status: 'Draft' };
                            skipDraftCreation = true;
                        }
                    } catch { /* table may not exist */ }
                }
            }

            if (!matchedPO && !skipDraftCreation) {
                try {
                    let vendorPartyId = await finale.findVendorPartyByName(invoiceData.vendorName);

                    // Axiom-specific fallback: try alternate names
                    if (!vendorPartyId && invoiceData.vendorName.toLowerCase().includes('axiom')) {
                        vendorPartyId = await finale.findVendorPartyByName('Axiom Print');
                        if (!vendorPartyId) vendorPartyId = await finale.findVendorPartyByName('Axiom');
                    }

                    if (vendorPartyId) {
                        // Build line items from extracted invoice data
                        const items: Array<{ productId: string; quantity: number; unitPrice: number }> = [];

                        if (invoiceData.lineItems && invoiceData.lineItems.length > 0) {
                            for (const li of invoiceData.lineItems) {
                                // Use SKU if extracted, otherwise use description as product ID
                                const productId = li.sku || li.description || 'UNKNOWN-ITEM';
                                items.push({
                                    productId,
                                    quantity: li.qty || 1,
                                    unitPrice: li.unitPrice || li.total || 0,
                                });
                            }
                        } else {
                            // Fallback: single line item at total minus freight
                            items.push({
                                productId: 'PLACEHOLDER-INLINE-INVOICE',
                                quantity: 1,
                                unitPrice: total - freight,
                            });
                        }

                        const memo = [
                            `[Aria] Auto-created from inline invoice email`,
                            `Invoice: ${invoiceNumber}`,
                            `Total: $${total.toFixed(2)}`,
                            freight > 0 ? `Freight: $${freight.toFixed(2)}` : null,
                            `Date: ${invoiceData.invoiceDate || 'unknown'}`,
                            invoiceData.shipDate ? `Ship Date: ${invoiceData.shipDate}` : null,
                            invoiceData.dueDate ? `Due Date: ${invoiceData.dueDate}` : null,
                            invoiceData.paymentTerms ? `Terms: ${invoiceData.paymentTerms}` : null,
                            invoiceData.trackingNumbers?.length
                                ? `Tracking: ${invoiceData.trackingNumbers.join(', ')}`
                                : null,
                            `Source: ${fromEmail}`,
                            `⚠️ DRAFT — verify SKUs and details before committing.`,
                        ].filter(Boolean).join('\n');

                        const result = await finale.createDraftPurchaseOrder(vendorPartyId, items, memo);
                        draftInfo = { orderId: result.orderId, finaleUrl: result.finaleUrl };
                        logs.push(`📝 Created draft PO #${result.orderId}`);

                        // Add freight adjustment if shipping > 0
                        if (freight > 0) {
                            try {
                                await finale.addOrderAdjustment(
                                    result.orderId,
                                    'FREIGHT',
                                    freight,
                                    `Freight - ${invoiceData.vendorName} ${invoiceNumber}`
                                );
                                logs.push(`+ Freight: $${freight.toFixed(2)}`);
                            } catch (freightErr: any) {
                                logs.push(`⚠️ Freight add failed: ${freightErr.message}`);
                            }
                        }

                        // Archive to vendor_invoices table
                        try {
                            await upsertVendorInvoice({
                                vendor_name: invoiceData.vendorName,
                                invoice_number: invoiceNumber,
                                invoice_date: invoiceData.invoiceDate || null,
                                po_number: result.orderId,
                                subtotal: invoiceData.subtotal || (total - freight),
                                freight: freight,
                                tax: invoiceData.tax || 0,
                                total: total,
                                status: 'received',
                                source: 'email_inline',
                                source_ref: `inline-invoice-${new Date().toISOString().split('T')[0]}`,
                                line_items: (invoiceData.lineItems || []).map((li: any) => ({
                                    sku: li.sku || li.description,
                                    description: li.description,
                                    qty: li.qty,
                                    unit_price: li.unitPrice,
                                    ext_price: li.total,
                                })),
                                raw_data: invoiceData as unknown as Record<string, unknown>,
                            });
                        } catch { /* dedup collision or non-critical */ }

                        if (result.duplicateWarnings?.length > 0) {
                            for (const w of result.duplicateWarnings) logs.push(w);
                        }
                    } else {
                        logs.push(`⚠️ Could not find vendor party for "${invoiceData.vendorName}" — no draft PO created`);
                    }
                } catch (err: any) {
                    logs.push(`❌ Draft PO creation failed: ${err.message}`);
                }
            }

            // ── TELEGRAM NOTIFICATION ────────────────────────────────────
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId && this.bot) {
                const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

                const lineItemSummary = invoiceData.lineItems?.length > 0
                    ? invoiceData.lineItems.map((li: any) =>
                        `  • ${li.description || li.sku || '?'} — qty ${li.qty} × $${(li.unitPrice || 0).toFixed(2)}`
                    ).join('\n')
                    : null;

                let message: string;
                if (matchedPO) {
                    message = [
                        `✅ <b>Invoice → PO Matched</b>`,
                        ``,
                        `<b>Vendor:</b> ${escHtml(invoiceData.vendorName)}`,
                        `<b>Invoice:</b> ${escHtml(invoiceNumber)} — $${total.toFixed(2)}`,
                        `<b>Matched:</b> PO #${matchedPO.orderId} ($${matchedPO.total.toFixed(2)}, ${matchedPO.status})`,
                        freight > 0 ? `<b>Freight:</b> $${freight.toFixed(2)}` : '',
                    ].filter(Boolean).join('\n');
                } else if (draftInfo) {
                    message = [
                        `📝 <b>Invoice → Draft PO Created</b>`,
                        ``,
                        `<b>Vendor:</b> ${escHtml(invoiceData.vendorName)}`,
                        `<b>Invoice:</b> ${escHtml(invoiceNumber)} — $${total.toFixed(2)}`,
                        freight > 0 ? `<b>Freight:</b> $${freight.toFixed(2)}` : '',
                        lineItemSummary ? `\n<b>Items:</b>\n${escHtml(lineItemSummary)}` : '',
                        ``,
                        `📝 Draft PO #${draftInfo.orderId} — verify and commit`,
                        `<a href="${draftInfo.finaleUrl}">Open in Finale →</a>`,
                    ].filter(Boolean).join('\n');
                } else {
                    message = [
                        `🔍 <b>Inline Invoice — Manual Review Needed</b>`,
                        ``,
                        `<b>Vendor:</b> ${escHtml(invoiceData.vendorName)}`,
                        `<b>Invoice:</b> ${escHtml(invoiceNumber)} — $${total.toFixed(2)}`,
                        ``,
                        `❌ Could not find vendor in Finale — no draft PO created.`,
                    ].filter(Boolean).join('\n');
                }

                try {
                    await this.bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
                } catch (tgErr: any) {
                    console.warn('⚠️ Telegram alert failed:', tgErr.message);
                }
            }

            // ── ACTIVITY LOG ─────────────────────────────────────────────
            await supabase.from('ap_activity_log').insert([{
                vendor_name: invoiceData.vendorName,
                activity_type: 'inline_invoice_po',
                description: matchedPO
                    ? `Invoice ${invoiceNumber} matched to PO #${matchedPO.orderId}`
                    : draftInfo
                        ? `Draft PO #${draftInfo.orderId} created from invoice ${invoiceNumber}`
                        : `Invoice ${invoiceNumber} — vendor not found, manual review needed`,
                details: {
                    type: 'inline_invoice_po',
                    success: !!matchedPO || !!draftInfo,
                    invoiceNumber,
                    total,
                    freight,
                    lineItemCount: invoiceData.lineItems?.length || 0,
                }
            }]).then(() => { }).catch(() => { });

            return { processed: true, logs };

        } catch (e: any) {
            logs.push(`❌ Error processing inline invoice: ${e.message}`);
            console.error('[InlineInvoiceHandler] ERROR: ', e);

            if (process.env.TELEGRAM_CHAT_ID) {
                await this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID,
                    `❌ **Aria Inline Invoice Error**\n\nFailed to process inline invoice from ${fromEmail}: ${e.message}`,
                    { parse_mode: 'Markdown' }
                ).catch(console.error);
            }
            return { processed: false, logs };
        }
    }
}
