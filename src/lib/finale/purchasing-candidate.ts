export type PurchasingCandidateSignals = {
    finaleReorderQty: number | null | undefined;
    finaleConsumptionQty: number | null | undefined;
    finaleDemandQty: number | null | undefined;
    finaleDemandPerDay: number | null | undefined;
    finaleStockoutDays?: number | null | undefined;
};

function positive(value: number | null | undefined): boolean {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function shouldIncludePurchasingCandidate(candidate: PurchasingCandidateSignals): boolean {
    return positive(candidate.finaleReorderQty);
}
