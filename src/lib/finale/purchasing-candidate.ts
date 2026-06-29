export type AriaPurchaseHistory = {
    hasHistory: boolean;
    totalQty: number;
    orderCount: number;
    firstOrderDate: string | null;
    lastOrderDate: string | null;
    avgDailyRate: number | null;
};

export type PurchasingCandidateSignals = {
    productId?: string;                     // HERMIA(2026-06-25): used by Path 5 override
    finaleReorderQty: number | null | undefined;
    finaleConsumptionQty: number | null | undefined;
    finaleDemandQty: number | null | undefined;
    finaleDemandPerDay: number | null | undefined;
    finaleStockoutDays?: number | null | undefined;
    ariaPOHistory?: AriaPurchaseHistory;
};

function positive(value: number | null | undefined): boolean {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * v2.8 (2026-06-11) — Multi-signal OR gate (Option C).
 *
 * Finale's native reorder engine silently drops SKUs (RMC103, Uline supplies)
 * when its own demand velocity calculation stutters on low-volume items. Aria's
 * engine is smarter — but none of that fires if the SKU never makes it past the
 * admission gate.
 *
 * Admission signals (any ONE is sufficient):
 *   Path 1: Finale explicitly recommends reorder (finaleReorderQty > 0)
 *   Path 2: Any measurable demand — Finale's demand signal
 *   Path 3: Our own purchase order history from Supabase
 *
 * Safety nets downstream:
 *   - Party resolution drops manufactured/dropship vendors
 *   - isDoNotReorder() skips DNR-flagged SKUs
 *   - `dailyRate === 0` skips zero-velocity SKUs (unless ariaPOHistory provides fallback)
 *   - `hasDeliverablePO()` skips SKUs with active deliverable orders
 *   - BOM pipeline handles component-only SKUs separately
 */
export function shouldIncludePurchasingCandidate(candidate: PurchasingCandidateSignals): boolean {
    // Path 1: Finale explicitly recommends reorder (original behavior)
    if (positive(candidate.finaleReorderQty)) return true;
    // Path 2: Any measurable demand — Finale's demand signals
    if (positive(candidate.finaleDemandQty)) return true;
    if (positive(candidate.finaleDemandPerDay)) return true;
    // Path 3: Our own purchase order history (aria-tracked POs)
    if (candidate.ariaPOHistory?.hasHistory) return true;
    // Path 4: Consumption history — Finale tracks how much was consumed even
    // when it can't compute demand signals (e.g., job supplies like DASH101).
    // SKUs with consumption > 0 are actively used and should be admitted;
    // Aria's downstream pipeline will determine if ordering is needed.
    if (positive(candidate.finaleConsumptionQty)) return true;
    // Path 5: Explicit override — some SKUs (DASH101) have a REST-based
    // reorder guideline (##demandVelocity qty=4) but the GraphQL productView
    // reports zero for all signals. Manually admit them so the downstream
    // recommender can evaluate based on our own velocity computation.
    if (isOverride(candidate)) return true;
    return false;
}

/** SKUs with confirmed reorder guidelines in Finale REST that the
 *  GraphQL productView doesn't surface. Populated as discovered. */
const KNOWN_OVERRIDES: string[] = [
    'DASH101',  // REST: ##demandVelocity qty=4. GraphQL: all signals 0.
];

function isOverride(candidate: PurchasingCandidateSignals): boolean {
    return typeof candidate.productId === 'string' && KNOWN_OVERRIDES.includes(candidate.productId);
}
