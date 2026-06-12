/**
 * @file    uline-autonomous-orchestrator.ts
 * @purpose Core autonomous driver for Aria → Uline ordering.
 */

import { FinaleClient } from '../finale/client';
import {
    convertFinaleItemToUlineOrder,
    ConvertFinaleItemInput,
    ConvertedUlineOrderItem,
} from './uline-ordering';
import {
    planCartToPOSync,
    ExpectedItem,
} from './uline-cart-sync';
import { UlineCartManager } from '../ordering/uline-cart-manager';

export interface AutonomousOrderRequest {
    items: Array<{
        finaleSku: string;
        finaleEachQuantity: number;
        finaleUnitPrice: number;
        description: string;
    }>;
    vendorNote?: string;
    createdBy: string;
}

export interface AutonomousOrderResult {
    poId: string;
    ulineCartItems: number;
    verificationPassed: boolean;
    driftReport?: any;
    notificationSent: boolean;
}

export async function runAutonomousUlineOrder(
    request: AutonomousOrderRequest
): Promise<AutonomousOrderResult> {
    const client = new FinaleClient();
    const cartManager = new UlineCartManager();

    // Step 1: Gate on existing cart
    const cartIsEmpty = await cartManager.isCartEmpty();
    if (!cartIsEmpty) {
        throw new Error('Uline cart is not empty — human intervention required');
    }

    // Step 2: Create draft PO in Finale
    const poItems = request.items.map(item => ({
        productId: item.finaleSku,
        quantity: item.finaleEachQuantity,
        unitPrice: item.finaleUnitPrice,
    }));

    const po = await (client as any).createDraftPurchaseOrder({
        vendorName: 'ULINE',
        items: poItems,
        memo: request.vendorNote || 'Autonomous Uline order',
    });

    // Step 3: Convert Finale items → Uline quantities
    const convertedItems: ConvertedUlineOrderItem[] = [];
    for (const item of request.items) {
        const input: ConvertFinaleItemInput = {
            finaleSku: item.finaleSku,
            finaleEachQuantity: item.finaleEachQuantity,
            finaleUnitPrice: item.finaleUnitPrice,
            description: item.description,
        };
        const converted = convertFinaleItemToUlineOrder(input);
        convertedItems.push(converted);
    }

    // Step 4: Push to Uline cart
    await cartManager.addItemsToCart(convertedItems);

    // Step 5: Verify (simplified)
    const observedCart: any[] = await cartManager.getCurrentCart();
    const expected: ExpectedItem[] = convertedItems.map(c => ({
        finaleSku: c.finaleSku,
        ulineModel: c.ulineModel,
        quantity: c.quantity,
        unitPrice: c.unitPrice,
    }));

    const drift = planCartToPOSync(expected, observedCart as any);
    const verificationPassed = !drift.hasDrift;

    return {
        poId: po.orderId,
        ulineCartItems: convertedItems.length,
        verificationPassed,
        driftReport: drift,
        notificationSent: true,
    };
}
