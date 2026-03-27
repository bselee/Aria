import { normalizeObservedUlinePriceToFinaleEaches } from "../lib/purchasing/uline-ordering";

export interface ExpectedUlineCartItem {
    finaleSku: string;
    ulineModel: string;
    quantity: number;
    unitPrice: number;
    finaleUnitPrice?: number;
    orderUnitEaches?: number;
}

export interface ObservedUlineCartRow {
    ulineModel: string;
    quantity: number;
    unitPrice?: number | null;
    lineTotal?: number | null;
}

export interface CartQuantityMismatch {
    ulineModel: string;
    expectedQuantity: number;
    observedQuantity: number;
}

export interface CartVerificationResult {
    status: 'verified' | 'partial' | 'unverified';
    matchedModels: string[];
    missingModels: string[];
    quantityMismatches: CartQuantityMismatch[];
    unexpectedModels: string[];
}

export interface DraftPOPriceUpdate {
    finaleSku: string;
    ulineModel: string;
    oldUnitPrice: number;
    newUnitPrice: number;
}

function normalizeModel(model: string): string {
    return (model || '').trim().toUpperCase();
}

export function verifyUlineCart(
    expectedItems: ExpectedUlineCartItem[],
    observedRows: ObservedUlineCartRow[],
): CartVerificationResult {
    if (observedRows.length === 0) {
        return {
            status: 'unverified',
            matchedModels: [],
            missingModels: expectedItems.map(item => item.ulineModel),
            quantityMismatches: [],
            unexpectedModels: [],
        };
    }

    const observedByModel = new Map(
        observedRows.map(row => [normalizeModel(row.ulineModel), row]),
    );

    const matchedModels: string[] = [];
    const missingModels: string[] = [];
    const quantityMismatches: CartQuantityMismatch[] = [];

    for (const item of expectedItems) {
        const observed = observedByModel.get(normalizeModel(item.ulineModel));
        if (!observed) {
            missingModels.push(item.ulineModel);
            continue;
        }

        if (observed.quantity !== item.quantity) {
            quantityMismatches.push({
                ulineModel: item.ulineModel,
                expectedQuantity: item.quantity,
                observedQuantity: observed.quantity,
            });
            continue;
        }

        matchedModels.push(item.ulineModel);
    }

    const expectedModels = new Set(expectedItems.map(item => normalizeModel(item.ulineModel)));
    const unexpectedModels = observedRows
        .map(row => row.ulineModel)
        .filter(model => !expectedModels.has(normalizeModel(model)));

    const hasIssues = missingModels.length > 0 || quantityMismatches.length > 0;
    return {
        status: hasIssues ? 'partial' : 'verified',
        matchedModels,
        missingModels,
        quantityMismatches,
        unexpectedModels,
    };
}

export function planDraftPOPriceUpdates(
    expectedItems: ExpectedUlineCartItem[],
    observedRows: ObservedUlineCartRow[],
    verification: CartVerificationResult,
): DraftPOPriceUpdate[] {
    if (verification.status === 'unverified') return [];

    const verifiedModels = new Set(verification.matchedModels.map(normalizeModel));
    const observedByModel = new Map(
        observedRows.map(row => [normalizeModel(row.ulineModel), row]),
    );

    return expectedItems.flatMap(item => {
        if (!verifiedModels.has(normalizeModel(item.ulineModel))) return [];
        const observed = observedByModel.get(normalizeModel(item.ulineModel));
        const observedPrice = observed?.unitPrice;
        if (observedPrice === null || observedPrice === undefined) return [];
        const normalizedObservedPrice = normalizeObservedUlinePriceToFinaleEaches(
            observedPrice,
            item.orderUnitEaches ?? 1,
        );
        const expectedFinalePrice = item.finaleUnitPrice ?? item.unitPrice;
        if (Math.abs(normalizedObservedPrice - expectedFinalePrice) < 0.0001) return [];

        return [{
            finaleSku: item.finaleSku,
            ulineModel: item.ulineModel,
            oldUnitPrice: expectedFinalePrice,
            newUnitPrice: normalizedObservedPrice,
        }];
    });
}

export function formatCartVerificationMessage(result: CartVerificationResult): string {
    if (result.status === 'verified') {
        return `Cart verified: ${result.matchedModels.length} item(s) confirmed in ULINE cart.`;
    }

    if (result.status === 'partial') {
        const missing = result.missingModels.length > 0
            ? ` Missing: ${result.missingModels.join(', ')}.`
            : '';
        const mismatches = result.quantityMismatches.length > 0
            ? ` Qty mismatches: ${result.quantityMismatches.map(
                item => `${item.ulineModel} expected ${item.expectedQuantity}, saw ${item.observedQuantity}`,
            ).join('; ')}.`
            : '';
        return `Cart needs review.${missing}${mismatches}`.trim();
    }

    return 'Cart fill attempted; manual verification needed.';
}
