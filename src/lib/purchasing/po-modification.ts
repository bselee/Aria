/**
 * @file    po-modification.ts
 * @purpose Orchestrates modifications to a sent/committed PO to reflect invoice data.
 *          Computes diffs between invoices and POs, applies adjustments (prices,
 *          quantities, freight), logs lifecycle transitions, records freight evidence,
 *          and marks invoices as reconciled.
 *
 *          Flow:
 *            1. User/computeInvoicePODiff → structured diff for UI display
 *            2. User/submit → ModificationRequest → applyInvoiceModification()
 *            3. Unlock PO → apply each line-item/freight change → restore status
 *            4. Log lifecycle transition → record freight evidence → mark invoice reconciled
 *
 * @author  Aria
 * @created 2026-07-15
 */

import { FinaleClient } from '@/lib/finale/client';
import { createClient } from '@/lib/db';
import { transitionLifecycleState, type POLifecycleState } from '@/lib/purchasing/po-lifecycle';
import { recordFreightEvidence } from '@/lib/purchasing/vendor-freight-learning';
import type { InvoiceData } from '@/lib/pdf/invoice-parser';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A single line-item diff between an invoice and its matched PO.
 */
export interface LineItemDiff {
    /** Product/SKU identifier */
    productId: string;
    /** Human-readable product name (from PO or invoice) */
    productName: string;
    /** Quantity on the PO */
    poQuantity: number;
    /** Quantity on the invoice */
    invoiceQuantity: number;
    /** Unit price on the PO */
    poUnitPrice: number;
    /** Unit price on the invoice */
    invoiceUnitPrice: number;
    /** Quantity delta (invoice - PO) */
    quantityDiff: number;
    /** Unit-price delta (invoice - PO) */
    unitPriceDiff: number;
    /** Line total delta ((invQty × invPrice) - (poQty × poPrice)) */
    lineTotalDiff: number;
    /** Whether the item exists on the PO at all */
    existsOnPO: boolean;
}

/**
 * Freight delta between an invoice and its matched PO.
 */
export interface FreightDiff {
    /** Freight amount on the PO (null if none) */
    poFreight: number | null;
    /** Freight amount on the invoice (null if none) */
    invoiceFreight: number | null;
    /** Dollar difference (invoice - PO, null if either side is null) */
    diff: number | null;
}

/**
 * Total delta between an invoice and its matched PO.
 */
export interface TotalDiff {
    /** PO total */
    poTotal: number;
    /** Invoice total */
    invoiceTotal: number;
    /** Dollar difference (invoice - PO) */
    diff: number;
}

/**
 * Structured diff between an invoice and a PO, suitable for UI display.
 */
export interface POInvoiceDiff {
    /** Per-line-item diffs */
    lineItems: LineItemDiff[];
    /** Freight/adjustment diff */
    freightDiff: FreightDiff;
    /** Total diff */
    totalDiff: TotalDiff;
    /** Number of line items that differ (qty or price) */
    changedLineCount: number;
    /** Whether any change at all exists */
    hasChanges: boolean;
}

/**
 * A single line-item adjustment to apply to a PO.
 */
export interface LineItemAdjustment {
    /** Product/SKU to adjust */
    productId: string;
    /** Previous quantity on PO (for auditing) */
    oldQuantity?: number;
    /** New quantity to set (omit to keep current) */
    newQuantity?: number;
    /** Previous unit price on PO (for auditing) */
    oldUnitPrice?: number;
    /** New unit price to set (omit to keep current) */
    newUnitPrice?: number;
}

/**
 * Request to modify a PO to reflect invoice data.
 */
export interface ModificationRequest {
    /** Finale order ID */
    orderId: string;
    /** Matched invoice ID (vendor_invoices.id) for reconciliation tracking */
    invoiceId?: string;
    /** Line-item adjustments to apply */
    adjustments: LineItemAdjustment[];
    /** New freight amount. null = no change, 0 = remove freight */
    freightAdjustment?: number | null;
    /** Description for the freight adjustment */
    freightDescription?: string;
    /** Free-form notes attached to the modification */
    notes?: string;
    /** Who/what triggered this modification (e.g. "ap-agent", "reconciler") */
    triggeredBy?: string;
}

/**
 * Result of applying a PO modification.
 */
export interface ModificationResult {
    /** Whether the overall modification succeeded */
    success: boolean;
    /** The Finale order ID */
    orderId: string;
    /** Number of line-item adjustments successfully applied */
    adjustmentsApplied: number;
    /** Whether a freight adjustment was applied */
    freightApplied: boolean;
    /** Freight amount before adjustment (null if not changed) */
    freightBefore?: number;
    /** Freight amount after adjustment (null if not changed) */
    freightAfter?: number;
    /** Whether the original PO status was successfully restored */
    statusRestored: boolean;
    /** Whether the lifecycle transition was logged */
    transitionLogged: boolean;
    /** Whether the freight evidence was recorded */
    freightEvidenceRecorded: boolean;
    /** Non-fatal errors encountered during processing */
    errors: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Default triggeredBy when none is provided */
const DEFAULT_TRIGGER = 'po-modification';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Safely parse a numeric value, returning 0 for NaN/null/undefined.
 */
function safeNumber(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Extract the freight adjustment amount from a Finale PO's orderAdjustmentList.
 * Looks for the FREIGHT product promo. Returns the matching amount or 0.
 */
function extractFreightFromPO(po: any, accountPath: string): number | null {
    const feeTypeId = FinaleClient.FINALE_FEE_TYPES?.FREIGHT?.id;
    if (!feeTypeId) return null;

    const promoUrl = `/${accountPath}/api/productpromo/${feeTypeId}`;
    const adjustments: any[] = po.orderAdjustmentList || [];
    const freightAdj = adjustments.find((a: any) => a.productPromoUrl === promoUrl);
    return freightAdj ? safeNumber(freightAdj.amount) : null;
}

/**
 * Find the account path from a PO document (used for constructing promo URLs).
 */
function getAccountPath(po: any): string {
    if (po.orderUrl) {
        const parts = po.orderUrl.split('/');
        // orderUrl looks like /{accountPath}/api/order/{id}
        const idx = parts.indexOf('api');
        if (idx >= 2) return parts[idx - 1];
    }
    return 'buildasoilorganics'; // fallback
}

/**
 * Compute the total from a PO's orderItemList.
 */
function computePOTotal(po: any): number {
    const items: any[] = po.orderItemList || [];
    return items.reduce((sum: number, item: any) => {
        return sum + safeNumber(item.quantity) * safeNumber(item.unitPrice);
    }, 0);
}

// ── Diff Function ──────────────────────────────────────────────────────────

/**
 * Compute a structured diff between an invoice and its matched PO.
 * Compares each line item (productId, quantity, unitPrice), freight/adjustment
 * amounts, and totals. Returns a POInvoiceDiff suitable for UI display.
 *
 * @param invoice - Parsed invoice data (from vendor_invoices row or InvoiceData)
 * @param po      - Full PO document from Finale (getOrderDetails response)
 * @returns       Structured diff with per-line-item, freight, and total comparisons
 */
export function computeInvoicePODiff(
    invoice: InvoiceData,
    po: any,
): POInvoiceDiff {
    const poItems: any[] = po.orderItemList || [];
    const invoiceLines = (invoice.lineItems || []).filter((l: any) => l.sku || l.description);

    // Build a map of PO items by productId for O(1) lookup
    const poItemMap = new Map<string, any>();
    for (const item of poItems) {
        const pid = String(item.productId || '').trim();
        if (pid) poItemMap.set(pid.toLowerCase(), item);
    }

    const lineDiffs: LineItemDiff[] = [];
    const matchedInvoiceSkus = new Set<string>();

    // Diff each invoice line against the PO
    for (const invLine of invoiceLines) {
        const sku = String(invLine.sku || '').trim().toLowerCase();
        if (!sku) continue;

        matchedInvoiceSkus.add(sku);
        const poItem = poItemMap.get(sku);

        const poQty = poItem ? safeNumber(poItem.quantity) : 0;
        const poPrice = poItem ? safeNumber(poItem.unitPrice) : 0;
        const invQty = safeNumber(invLine.qty);
        const invPrice = safeNumber(invLine.unitPrice);

        const qtyDiff = invQty - poQty;
        const priceDiff = invPrice - poPrice;
        const poLineTotal = poQty * poPrice;
        const invLineTotal = invQty * invPrice;
        const lineTotalDiff = invLineTotal - poLineTotal;

        lineDiffs.push({
            productId: sku,
            productName: invLine.description || poItem?.productId || sku,
            poQuantity: poQty,
            invoiceQuantity: invQty,
            poUnitPrice: poPrice,
            invoiceUnitPrice: invPrice,
            quantityDiff: qtyDiff,
            unitPriceDiff: priceDiff,
            lineTotalDiff,
            existsOnPO: !!poItem,
        });
    }

    // Add PO-only items (in invoice but not on PO are already captured above)
    // Here we add items that are on the PO but not on the invoice
    for (const poItem of poItems) {
        const pid = String(poItem.productId || '').trim().toLowerCase();
        if (!pid || matchedInvoiceSkus.has(pid)) continue;

        const poQty = safeNumber(poItem.quantity);
        const poPrice = safeNumber(poItem.unitPrice);

        lineDiffs.push({
            productId: pid,
            productName: poItem.productId || pid,
            poQuantity: poQty,
            invoiceQuantity: 0,
            poUnitPrice: poPrice,
            invoiceUnitPrice: 0,
            quantityDiff: -poQty,
            unitPriceDiff: -poPrice,
            lineTotalDiff: -(poQty * poPrice),
            existsOnPO: true,
        });
    }

    // Freight diff
    const accountPath = getAccountPath(po);
    const poFreight = extractFreightFromPO(po, accountPath);
    const invFreight = safeNumber(invoice.freight);

    const freightDiff: FreightDiff = {
        poFreight,
        invoiceFreight: invoice.freight ?? null,
        diff: (poFreight !== null && invoice.freight != null)
            ? invFreight - poFreight
            : null,
    };

    // Total diff
    const poTotal = safeNumber(po.total) || computePOTotal(po);
    const invTotal = safeNumber(invoice.total);

    const totalDiff: TotalDiff = {
        poTotal,
        invoiceTotal: invTotal,
        diff: invTotal - poTotal,
    };

    const changedLineCount = lineDiffs.filter(
        ld => Math.abs(ld.quantityDiff) > 0.001 || Math.abs(ld.unitPriceDiff) > 0.001,
    ).length;

    const hasChanges = changedLineCount > 0 ||
        (freightDiff.diff !== null && Math.abs(freightDiff.diff) > 0.001) ||
        Math.abs(totalDiff.diff) > 0.01;

    return {
        lineItems: lineDiffs,
        freightDiff,
        totalDiff,
        changedLineCount,
        hasChanges,
    };
}

// ── Apply Modification ─────────────────────────────────────────────────────

/**
 * Apply an invoice-driven modification to a Finale PO.
 *
 * Orchestrates the full modify-and-restore cycle:
 *   1. Fetch current PO from Finale
 *   2. Unlock for editing (handles locked/completed POs)
 *   3. Apply each line-item adjustment (price and/or quantity)
 *   4. Apply freight adjustment if provided
 *   5. Restore original PO status (re-lock/re-complete)
 *   6. Log lifecycle transition to 'RECONCILED'
 *   7. Record freight evidence for vendor learning
 *   8. Mark invoice as reconciled in local DB
 *
 * Best-effort pattern: never throws critical errors. All failures are
 * collected in ModificationResult.errors for the caller to inspect.
 *
 * @param finale  - Initialized FinaleClient instance
 * @param request - The modification request detailing what to change
 * @returns       ModificationResult with per-step status and collected errors
 */
export async function applyInvoiceModification(
    finale: FinaleClient,
    request: ModificationRequest,
): Promise<ModificationResult> {
    const result: ModificationResult = {
        success: false,
        orderId: request.orderId,
        adjustmentsApplied: 0,
        freightApplied: false,
        statusRestored: false,
        transitionLogged: false,
        freightEvidenceRecorded: false,
        errors: [],
    };

    const triggeredBy = request.triggeredBy || DEFAULT_TRIGGER;

    // ── Phase 1: Fetch current PO ──────────────────────────────────────
    let currentPO: any;
    let originalStatus: string = 'ORDER_LOCKED';
    let accountPath: string = 'buildasoilorganics';

    try {
        currentPO = await finale.getOrderDetails(request.orderId);
        if (!currentPO) {
            result.errors.push(`PO ${request.orderId} not found in Finale`);
            return result;
        }
        accountPath = getAccountPath(currentPO);
    } catch (err: any) {
        result.errors.push(`Failed to fetch PO ${request.orderId}: ${err.message}`);
        return result;
    }

    // ── Phase 2: Capture state before changes ──────────────────────────
    const freightBefore = extractFreightFromPO(currentPO, accountPath);

    // ── Phase 3: Unlock for editing ────────────────────────────────────
    try {
        originalStatus = await finale.unlockForEditing(currentPO, request.orderId);
    } catch (err: any) {
        result.errors.push(`Failed to unlock PO ${request.orderId}: ${err.message}`);
        // Continue — some POs may not need unlocking
    }

    // ── Phase 4: Apply line-item adjustments ────────────────────────────
    for (const adj of request.adjustments) {
        const hasQtyChange = adj.newQuantity !== undefined && adj.newQuantity !== adj.oldQuantity;
        const hasPriceChange = adj.newUnitPrice !== undefined && adj.newUnitPrice !== adj.oldUnitPrice;

        if (!hasQtyChange && !hasPriceChange) {
            continue; // no-op adjustment, skip
        }

        try {
            if (hasQtyChange && hasPriceChange) {
                // Both qty and price changed — use combined mutation
                await finale.updateOrderItemQuantityAndPrice(
                    request.orderId,
                    adj.productId,
                    adj.newQuantity!,
                    adj.newUnitPrice!,
                );
            } else if (hasQtyChange) {
                // Only quantity changed — need qty+price with current price
                // Re-fetch current price from PO
                const poItem = (currentPO.orderItemList || []).find(
                    (i: any) => String(i.productId || '').toLowerCase() === adj.productId.toLowerCase(),
                );
                const currentPrice = poItem ? safeNumber(poItem.unitPrice) : 0;
                await finale.updateOrderItemQuantityAndPrice(
                    request.orderId,
                    adj.productId,
                    adj.newQuantity!,
                    currentPrice,
                );
            } else {
                // Only price changed
                await finale.updateOrderItemPrice(
                    request.orderId,
                    adj.productId,
                    adj.newUnitPrice!,
                );
            }
            result.adjustmentsApplied++;
        } catch (err: any) {
            result.errors.push(`Failed to adjust ${adj.productId}: ${err.message}`);
        }
    }

    // ── Phase 5: Apply freight adjustment ──────────────────────────────
    const hasFreightChange = request.freightAdjustment !== undefined && request.freightAdjustment !== null;
    let freightAfter: number | undefined;

    if (hasFreightChange) {
        try {
            await finale.updateOrderAdjustmentAmount(
                request.orderId,
                'FREIGHT',
                request.freightAdjustment!,
                request.freightDescription,
            );
            result.freightApplied = true;
            freightAfter = request.freightAdjustment!;
        } catch (err: any) {
            result.errors.push(`Failed to apply freight adjustment: ${err.message}`);
        }
    }

    // ── Phase 6: Restore original PO status ────────────────────────────
    try {
        await finale.restoreOrderStatus(request.orderId, originalStatus);
        result.statusRestored = true;
    } catch (err: any) {
        result.errors.push(`Failed to restore PO status: ${err.message}`);
    }

    // ── Phase 7: Log lifecycle transition → RECONCILED ─────────────────
    try {
        await transitionLifecycleState(
            request.orderId,
            'RECONCILED' as POLifecycleState,
            triggeredBy,
            {
                invoiceId: request.invoiceId || null,
                adjustmentsApplied: result.adjustmentsApplied,
                freightApplied: result.freightApplied,
                freightBefore: freightBefore ?? undefined,
                freightAfter,
                notes: request.notes || null,
                errors: result.errors.length > 0 ? result.errors : undefined,
            },
        );
        result.transitionLogged = true;
    } catch (err: any) {
        result.errors.push(`Failed to log lifecycle transition: ${err.message}`);
    }

    // ── Phase 8: Record freight evidence ───────────────────────────────
    try {
        // Re-fetch the PO to get the final freight value after adjustments
        const finalPO = await finale.getOrderDetails(request.orderId);
        const finalAccountPath = getAccountPath(finalPO);
        const finalFreight = extractFreightFromPO(finalPO, finalAccountPath);

        await recordFreightEvidence({
            orderId: request.orderId,
            vendorName: currentPO?.supplier?.name || 'Unknown',
            hadFreightOnPO: (freightBefore !== null && freightBefore > 0) || (finalFreight !== null && finalFreight > 0),
            invoiceFreight: freightAfter ?? (request.freightAdjustment ?? 0),
            freightMatched: finalFreight !== null && freightAfter !== undefined
                ? Math.abs(finalFreight - freightAfter) < 0.01
                : true,
            completedBy: 'manual',
        });
        result.freightEvidenceRecorded = true;
    } catch (err: any) {
        result.errors.push(`Failed to record freight evidence: ${err.message}`);
    }

    // ── Phase 9: Mark invoice as reconciled in local DB ────────────────
    if (request.invoiceId) {
        try {
            const db = createClient();
            if (db) {
                await db
                    .from('vendor_invoices')
                    .update({ status: 'reconciled', reconciled_at: new Date().toISOString() })
                    .eq('id', request.invoiceId);
            } else {
                result.errors.push('No DB client available to mark invoice as reconciled');
            }
        } catch (err: any) {
            result.errors.push(`Failed to mark invoice ${request.invoiceId} as reconciled: ${err.message}`);
        }
    }

    // ── Determine overall success ──────────────────────────────────────
    result.success = result.adjustmentsApplied > 0 || result.freightApplied || request.adjustments.length === 0;
    if (result.freightApplied && freightBefore !== undefined) {
        result.freightBefore = freightBefore;
        result.freightAfter = freightAfter;
    }

    return result;
}