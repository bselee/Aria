/**
 * @file    client.ts
 * @purpose Lean, backward-compatible backward-compatibility layer for the decomposed Finale Inventory API client.
 *          Delegates all queries and mutations via OOP inheritance to partitioned modules.
 * @author  Aria / Antigravity
 * @created 2026-02-24
 * @updated 2026-05-26
 * @deps    src/lib/finale/receivings.ts, src/lib/finale/core-client.ts
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 */

import { FinaleReceivingsClient } from "./receivings";
import { type FinaleReorderMethod } from "./core-client";

// Re-export all base helpers and types so they remain imported from "@/lib/finale/client" everywhere
export {
    parseFinaleNumber,
    parseISODateOnly,
    toISOStringOrNull,
    getShipmentsInReceiptWindow,
    getReceiptQueryStartDate,
    getReceiptStatusFromPoStatus,
    isWarehouseReceivingOrder,
    getShipmentReceiptDateTime,
    getShipmentReceiverName,
    getShipmentLineContainers,
    getShipmentLineProductId,
    getShipmentLineQuantity,
    getShipmentReceiptItems,
    deriveReceivedPurchaseOrders,
    enrichReceivedPurchaseOrdersWithShipmentDetails,
    normalizeFinaleReorderMethod,
    chooseVelocitySignal,
} from "./core-client";

export {
    EXCLUDED_VENDOR_PATTERN,
    __bomComponent404CacheForTests,
    __skuHasNoBomCacheForTests,
} from "./products";

// ──────────────────────────────────────────────────
// TYPES & INTERFACES (Re-exports)
// ──────────────────────────────────────────────────

export type {
    ExternalReorderItem,
    ExternalReorderGroup,
    PurchasingItem,
    PurchasingGroup,
    FullPO,
    DraftPOReview,
    SendPurchaseOrderEmailInput,
    SendPurchaseOrderEmailResult,
    ConsumptionReport,
    ConsumptionPeriodBucket,
    ProductConsumptionAnalysis,
} from "./core-client";

// ──────────────────────────────────────────────────
// CLIENT FACADE
// ──────────────────────────────────────────────────

export class FinaleClient extends FinaleReceivingsClient {
    constructor() {
        super();
    }

    /**
     * Infer whether a product is a "bulk delivery" item that should route to the Soil facility.
     */
    static isBulkDelivery(productData: {
        productId?: string;
        internalName?: string;
        normalizedPackingString?: string;
        userCategory?: string;
    }): boolean {
        const name = (productData.internalName || productData.productId || '').toLowerCase();
        const packing = (productData.normalizedPackingString || '').toLowerCase();
        const category = (productData.userCategory || '').toLowerCase();

        const bulkNamePatterns = /\b(tote|bulk|raw|pallet|super\s*sack|truckload|truck\s*load|yard|cubic\s*yard|\bcy\b|tanker)\b/;
        if (bulkNamePatterns.test(name)) return true;

        const weightMatch = packing.match(/(\d[\d,.]*)\s*(lb|lbs|pound|pounds)/i);
        if (weightMatch) {
            const weight = parseFloat(weightMatch[1].replace(/,/g, ''));
            if (weight >= 2000) return true;
        }

        if (/\b(ton|tons|yard|yards|\bcy\b|cubic\s*yard)\b/.test(packing)) return true;
        if (/\b(raw|bulk)\b/.test(category)) return true;

        return false;
    }

    /**
     * Round a quantity UP to the nearest multiple of the order increment.
     */
    static snapToIncrement(quantity: number, incrementQty: number | null): number {
        if (!incrementQty || incrementQty <= 1) return quantity;
        return Math.max(incrementQty, Math.ceil(quantity / incrementQty) * incrementQty);
    }

    /**
     * Check whether a Finale product is flagged "Do not reorder".
     */
    static isDoNotReorder(productData: any): boolean {
        if (!productData) return false;

        const status = String(productData.statusId || productData.status || '').toLowerCase();
        if (status.includes('inactive') || status.includes('discontinued')) {
            return true;
        }

        const category = String(productData.userCategory || productData.category || '').toLowerCase();
        if (category.includes('deprecat')) {
            return true;
        }

        const policy = String(productData.reorderPointPolicy || '').toLowerCase();
        if (policy.includes('do_not_reorder') || policy.includes('donotreorder') || policy.includes('do not reorder')) {
            return true;
        }

        if (productData.doNotReorder === true) return true;

        const guidelines: any[] = productData.reorderGuidelineList || [];
        for (const g of guidelines) {
            const methodId = String(g.reorderCalculationMethodId || '').toLowerCase();
            if (methodId.includes('donotreorder')) return true;
        }

        const name = String(productData.internalName || productData.productId || '').toLowerCase();
        const desc = String(productData.description || productData.longDescription || '').toLowerCase();
        if (name.includes('do not reorder') || desc.includes('do not reorder')) return true;

        const userFields: any[] = productData.userFieldDataList || [];
        for (const field of userFields) {
            const val = String(field.value || field.userFieldValue || field.attrValue || '').toLowerCase();
            if (val.includes('do not reorder')) return true;
        }

        return false;
    }
}

// ──────────────────────────────────────────────────
// SINGLETON (LAZY)
// ──────────────────────────────────────────────────

let _finaleClientInstance: FinaleClient | null = null;

export const finaleClient: FinaleClient = new Proxy({} as FinaleClient, {
    get(_target, prop, _receiver) {
        if (!_finaleClientInstance) {
            _finaleClientInstance = new FinaleClient();
        }
        const val = (_finaleClientInstance as any)[prop];
        return typeof val === 'function' ? val.bind(_finaleClientInstance) : val;
    },
});
