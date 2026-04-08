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
    minFinaleEaches?: number;
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
    "S-4124": { ulineModel: "S-4124", orderUnitEaches: 1, quantityStep: 25, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 7 to 25" },
    "S-4125": { ulineModel: "S-4125", orderUnitEaches: 1, quantityStep: 25, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 304 to 325" },
    "S-4122": { ulineModel: "S-4122", orderUnitEaches: 1, quantityStep: 25, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 25/bundle" },
    "S-4128": { ulineModel: "S-4128", orderUnitEaches: 1, quantityStep: 25, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 25/bundle" },
    "S-4551": { ulineModel: "S-4551", orderUnitEaches: 1, quantityStep: 15, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 15/bundle" },
    "ULS455": { ulineModel: "S-4551", orderUnitEaches: 1, quantityStep: 15, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 15/bundle" },
    "S-445": { ulineModel: "S-445", orderUnitEaches: 1, quantityStep: 24, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 9 to 24" },
    "S-13505B": { ulineModel: "S-13505B", orderUnitEaches: 1, quantityStep: 120, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: ordered in 120-each steps" },
    "S-13506B": { ulineModel: "S-13506B", orderUnitEaches: 1, quantityStep: 120, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 65 to 120" },
    "S-10748B": { ulineModel: "S-10748B", orderUnitEaches: 1, quantityStep: 120, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 72 to 120" },
    "S-15837B": { ulineModel: "S-15837B", orderUnitEaches: 1, quantityStep: 240, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 32 to 240" },
    "FJG101": { ulineModel: "S-15837B", orderUnitEaches: 1, quantityStep: 240, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 32 to 240" },
    "FJG102": { ulineModel: "S-13505B", orderUnitEaches: 1, quantityStep: 120, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: ordered in 120-each steps" },
    "FJG103": { ulineModel: "S-13506B", orderUnitEaches: 1, quantityStep: 120, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 65 to 120" },
    "FJG104": { ulineModel: "S-10748B", orderUnitEaches: 1, quantityStep: 120, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 72 to 120" },
    "S-2835": { ulineModel: "S-2835", orderUnitEaches: 1000, quantityStep: 1, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 1,000/carton" },
    "S-3902": { ulineModel: "S-3902", orderUnitEaches: 5000, quantityStep: 1, maxFinaleEaches: 10_000, source: "Sandbox ULINE history: 5,000 bags/pail" },
    "S-1667": { ulineModel: "S-1667", orderUnitEaches: 500, quantityStep: 1, maxFinaleEaches: 20_000, source: "Sandbox ULINE history: 500/Box" },
    "S-4738": { ulineModel: "S-4738", orderUnitEaches: 1, quantityStep: 60, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 50 to 60" },
    "S-4796": { ulineModel: "S-4796", orderUnitEaches: 1, quantityStep: 10, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 1217 to 1220" },
    "S-15625": { ulineModel: "S-15625", orderUnitEaches: 1, quantityStep: 12, maxFinaleEaches: 10_000, source: "Live ULINE cart (2026-04-03): rounded 27 to 36" },
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

function parseBundleCount(description: string): number | null {
    const normalized = (description || "").toLowerCase();
    const match = normalized.match(/(\d[\d,]*)\s*\/\s*(box|case|bundle|pk|pack|carton|pail)\b/);
    const fallback = normalized.match(/\/\s*(\d[\d,]*)\b/);
    const raw = match?.[1] || fallback?.[1];
    if (!raw) return null;
    const count = Number(raw.replace(/,/g, ""));
    return Number.isFinite(count) && count > 0 ? count : null;
}

function inferRuleFromDescription(input: ConvertFinaleItemInput): UlineOrderingRule | null {
    const count = parseBundleCount(input.description);
    if (!count) return null;

    const normalizedDescription = (input.description || "").toLowerCase();
    const mappedModel = toUlineModel(input.ulineModel || input.finaleSku);

    if (normalizedDescription.includes("corrugated boxes")) {
        return {
            ulineModel: mappedModel,
            orderUnitEaches: 1,
            quantityStep: count,
            maxFinaleEaches: 10_000,
            minFinaleEaches: 500,
            source: `Description-derived bundle multiple (${count})`,
        };
    }

    return {
        ulineModel: mappedModel,
        orderUnitEaches: count,
        quantityStep: 1,
        maxFinaleEaches: 10_000,
        source: `Description-derived pack size (${count})`,
    };
}

export function normalizeObservedUlinePriceToFinaleEaches(
    observedVendorUnitPrice: number,
    orderUnitEaches: number,
): number {
    return observedVendorUnitPrice / Math.max(orderUnitEaches, 1);
}

export function convertFinaleItemToUlineOrder(input: ConvertFinaleItemInput): ConvertedUlineOrderItem {
    const explicitRule = getUlineOrderingRule(input.ulineModel || input.finaleSku);
    const rule = explicitRule.source === "default passthrough"
        ? (inferRuleFromDescription(input) || explicitRule)
        : explicitRule;
    const requestedVendorQty = input.finaleEachQuantity / rule.orderUnitEaches;
    const minimumVendorQty = rule.minFinaleEaches
        ? Math.ceil(rule.minFinaleEaches / rule.orderUnitEaches)
        : 0;
    const roundedVendorQty = Math.ceil(
        Math.max(requestedVendorQty, minimumVendorQty) / rule.quantityStep,
    ) * rule.quantityStep;
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

    const lineTotalEstimate = vendorUnitPrice * roundedVendorQty;
    const addedEaches = Math.max(effectiveEachQuantity - input.finaleEachQuantity, 0);
    const addedSpendEstimate = addedEaches * input.finaleUnitPrice;
    if (lineTotalEstimate > 5000) {
        guardrailWarnings.push(
            `💰 MASSIVE MONEY GUARDRAIL: ${input.finaleSku} order line is $${lineTotalEstimate.toFixed(2)} (Qty: ${roundedVendorQty} at $${vendorUnitPrice.toFixed(2)}/vendor unit). Verify before approving.`,
        );
    }

    if (addedSpendEstimate >= 1000) {
        guardrailWarnings.push(
            `BLOCKING GUARDRAIL: ${input.finaleSku} vendor-step rounding adds ${addedEaches} eaches / $${addedSpendEstimate.toFixed(2)} beyond the requested quantity.`,
        );
    }

    if (roundedVendorQty > 50) {
        guardrailWarnings.push(
            `📦 HIGH VENDOR QUANTITY GUARDRAIL: ${input.finaleSku} requested ${roundedVendorQty} vendor units. Are you sure you are ordering boxes and not individually?`,
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
