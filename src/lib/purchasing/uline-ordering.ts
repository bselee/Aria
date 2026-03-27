/**
 * @file    src/lib/purchasing/uline-ordering.ts
 * @purpose Shared ULINE ordering conversion layer.
 *
 * Finale remains the source of truth in eaches.
 * ULINE cart quantities are derived from vendor ordering rules backed by the
 * ordering platform and cached order history in Sandbox/ULINE/MyOrderHistory.xlsx.
 */

export interface UlineOrderingRule {
    ulineModel: string;
    orderUnitEaches: number;
    quantityStep: number;
    maxFinaleEaches: number;
    source: string;
}

export interface ConvertFinaleItemInput {
    finaleSku: string;
    finaleEachQuantity: number;
    finaleUnitPrice: number;
    description: string;
    ulineModel?: string;
}

export interface ConvertedUlineOrderItem {
    finaleSku: string;
    ulineModel: string;
    quantity: number;
    unitPrice: number;
    description: string;
    finaleEachQuantity: number;
    finaleUnitPrice: number;
    effectiveEachQuantity: number;
    orderUnitEaches: number;
    quantityStep: number;
    guardrailWarnings: string[];
}

const ULINE_TO_FINALE: Record<string, string> = {
    "S-15837B": "FJG101",
    "S-13505B": "FJG102",
    "S-13506B": "FJG103",
    "S-10748B": "FJG104",
    "S-12229": "10113",
    "S-4551": "ULS455",
    "H-1621": "Ho-1621",
};

const FINALE_TO_ULINE: Record<string, string> = Object.fromEntries(
    Object.entries(ULINE_TO_FINALE).map(([uline, finale]) => [finale, uline]),
);

// History-backed vendor rules from Sandbox/ULINE/MyOrderHistory.xlsx:
// - S-4092 / S-4122 / S-4128 appear as 25/bundle and are ordered in box counts
//   rounded to multiples of 25.
// - S-4551 appears as 15/bundle and is ordered in box counts rounded to 15.
// - S-2835 appears as 1,000/carton and quantity is carton count.
// - S-3902 appears as 5,000 bags/pail and quantity is pail count.
const ORDERING_RULES: Record<string, UlineOrderingRule> = {
    "S-4092": { ulineModel: "S-4092", orderUnitEaches: 1, quantityStep: 25, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 25/bundle" },
    "S-4122": { ulineModel: "S-4122", orderUnitEaches: 1, quantityStep: 25, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 25/bundle" },
    "S-4128": { ulineModel: "S-4128", orderUnitEaches: 1, quantityStep: 25, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 25/bundle" },
    "S-4551": { ulineModel: "S-4551", orderUnitEaches: 1, quantityStep: 15, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 15/bundle" },
    "ULS455": { ulineModel: "S-4551", orderUnitEaches: 1, quantityStep: 15, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 15/bundle" },
    "S-2835": { ulineModel: "S-2835", orderUnitEaches: 1000, quantityStep: 1, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 1,000/carton" },
    "S-3902": { ulineModel: "S-3902", orderUnitEaches: 5000, quantityStep: 1, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 5,000 bags/pail" },
};

export function toUlineModel(finaleSku: string): string {
    return FINALE_TO_ULINE[finaleSku] || finaleSku;
}

export function getUlineOrderingRule(finaleSkuOrModel: string): UlineOrderingRule {
    const normalized = (finaleSkuOrModel || "").trim().toUpperCase();
    const mapped = toUlineModel(normalized);
    return ORDERING_RULES[normalized]
        || ORDERING_RULES[mapped]
        || {
            ulineModel: mapped,
            orderUnitEaches: 1,
            quantityStep: 1,
            maxFinaleEaches: 10_000,
            source: "default passthrough",
        };
}

export function normalizeObservedUlinePriceToFinaleEaches(
    observedVendorUnitPrice: number,
    orderUnitEaches: number,
): number {
    return observedVendorUnitPrice / Math.max(orderUnitEaches, 1);
}

export function convertFinaleItemToUlineOrder(input: ConvertFinaleItemInput): ConvertedUlineOrderItem {
    const rule = getUlineOrderingRule(input.ulineModel || input.finaleSku);
    const requestedVendorQty = input.finaleEachQuantity / rule.orderUnitEaches;
    const roundedVendorQty = Math.ceil(requestedVendorQty / rule.quantityStep) * rule.quantityStep;
    const effectiveEachQuantity = roundedVendorQty * rule.orderUnitEaches;
    const vendorUnitPrice = input.finaleUnitPrice * rule.orderUnitEaches;
    const guardrailWarnings: string[] = [];

    if (input.finaleEachQuantity > rule.maxFinaleEaches) {
        guardrailWarnings.push(
            `${input.finaleSku} exceeds the ${rule.maxFinaleEaches}-each guardrail (${input.finaleEachQuantity} requested).`,
        );
    }

    if (effectiveEachQuantity !== input.finaleEachQuantity) {
        guardrailWarnings.push(
            `Rounded ${input.finaleSku} from ${input.finaleEachQuantity} eaches to ${effectiveEachQuantity} ULINE quantity.`,
        );
    }

    return {
        finaleSku: input.finaleSku,
        ulineModel: rule.ulineModel,
        quantity: roundedVendorQty,
        unitPrice: vendorUnitPrice,
        description: input.description,
        finaleEachQuantity: input.finaleEachQuantity,
        finaleUnitPrice: input.finaleUnitPrice,
        effectiveEachQuantity,
        orderUnitEaches: rule.orderUnitEaches,
        quantityStep: rule.quantityStep,
        guardrailWarnings,
    };
}
