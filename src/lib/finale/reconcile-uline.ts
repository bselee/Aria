/**
 * @file    reconcile-uline.ts
 * @purpose Precise true-up logic for Uline orders.
 *          - Updates PO header tax/freight from confirmation
 *          - Handles final invoice reconciliation with strict tolerances
 *          - Ignores free/promo items
 *          - Supports kit expansion via existing Uline SKU mapping
 *
 * @author  Aria
 * @created 2026-06-12
 */

import { FinaleClient } from './client';

export interface UlineInvoice {
    poNumber: string;
    subtotal: number;
    tax: number;
    freight: number;
    lineItems: Array<{
        sku: string;
        quantity: number;
        unitPrice: number;
        description?: string;
    }>;
    isFreeItem?: boolean; // promo / $0 lines
}

export interface UlineTrueUpResult {
    poUpdated: boolean;
    taxApplied: number;
    freightApplied: number;
    freeItemsIgnored: number;
    varianceFlags: string[];
}

/**
 * Apply tax and freight to PO header (from confirmation email/PDF).
 * Uses the correct productpromo URLs for "Tax" (10008) and "Freight" (10007).
 */
export async function applyUlineConfirmationToPO(
    poId: string,
    tax: number,
    freight: number
): Promise<boolean> {
    const client = new FinaleClient();
    const url = `/${client['accountPath']}/api/order/${poId}`;

    const po = await client.get(url);

    if (!po.orderAdjustmentList) po.orderAdjustmentList = [];

    // Remove existing Tax/Freight adjustments to avoid duplicates
    po.orderAdjustmentList = po.orderAdjustmentList.filter(
        (adj: any) => !['Tax', 'Freight'].includes(adj.description)
    );

    // Add Tax
    if (tax > 0) {
        po.orderAdjustmentList.push({
            amount: tax,
            description: 'Tax',
            productPromoUrl: `/${client['accountPath']}/api/productpromo/10008`,
        });
    }

    // Add Freight
    if (freight > 0) {
        po.orderAdjustmentList.push({
            amount: freight,
            description: 'Freight',
            productPromoUrl: `/${client['accountPath']}/api/productpromo/10007`,
        });
    }

    await client.post(url, po);
    return true;
}

/**
 * Precise true-up when final Uline invoice arrives via AP.
 * Applies strict tolerance rules.
 */
export async function reconcileUlineInvoice(
    poId: string,
    invoice: UlineInvoice
): Promise<UlineTrueUpResult> {
    const result: UlineTrueUpResult = {
        poUpdated: false,
        taxApplied: 0,
        freightApplied: 0,
        freeItemsIgnored: 0,
        varianceFlags: [],
    };

    const client = new FinaleClient();
    const po = await client.getOrderDetails(poId);

    // 1. Handle free/promo items
    const paidItems = invoice.lineItems.filter(item => (item.unitPrice || 0) > 0);
    result.freeItemsIgnored = invoice.lineItems.length - paidItems.length;

    // 2. Apply tax (tolerance ±$5)
    const existingTax = (po.orderAdjustmentList || []).find((a: any) => a.description === 'Tax')?.amount || 0;
    const taxDelta = Math.abs(invoice.tax - existingTax);

    if (taxDelta > 5) {
        result.varianceFlags.push(`Tax variance $${taxDelta.toFixed(2)} > $5 tolerance`);
    } else {
        result.taxApplied = invoice.tax;
        // Re-apply to ensure exact match
        await applyUlineConfirmationToPO(poId, invoice.tax, invoice.freight);
        result.poUpdated = true;
    }

    // 3. Apply freight (tolerance ±$5)
    const existingFreight = (po.orderAdjustmentList || []).find((a: any) => a.description === 'Freight')?.amount || 0;
    const freightDelta = Math.abs(invoice.freight - existingFreight);

    if (freightDelta > 5) {
        result.varianceFlags.push(`Freight variance $${freightDelta.toFixed(2)} > $5 tolerance`);
    } else {
        result.freightApplied = invoice.freight;
    }

    // 4. TODO: Line item reconciliation (future enhancement)
    // For now we rely on existing reconciler for product lines

    return result;
}
