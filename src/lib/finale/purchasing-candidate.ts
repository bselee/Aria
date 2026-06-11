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

/**
 * v2.7 (2026-06-11) — Basauto showed us the gap: Finale's native reorder
 * engine silently drops SKUs (RMC103, Uline supplies) when its own demand
 * velocity calculation stutters on low-volume items. Aria's engine is
 * smarter — it uses historical PO data, BOM traceback, lead-time P90,
 * calibration, and cognitive rounding. But none of that fires if the SKU
 * never makes it past the admission gate.
 *
 * Original behavior: only `finaleReorderQty > 0` admitted a SKU.
 * New behavior: any SKU with measurable demand OR a Finale reorder flag.
 *
 * Safety nets downstream:
 *   - Party resolution drops manufactured/dropship vendors (line ~2665)
 *   - isDoNotReorder() skips DNR-flagged SKUs (line ~2668)
 *   - `dailyRate === 0` skips zero-velocity SKUs (line ~2737)
 *   - `hasDeliverablePO()` skips SKUs with active deliverable orders (line ~2711)
 *   - BOM pipeline handles component-only SKUs separately
 *
 * Cost: the work loop processes more candidates, but each one that has
 * no real demand will bail at the dailyRate===0 check after one product
 * activity fetch. For BuildASoil's inventory size (<500 active SKUs)
 * this is trivial — the concurrent worker pool handles it.
 */
export function shouldIncludePurchasingCandidate(candidate: PurchasingCandidateSignals): boolean {
    // Path 1: Finale explicitly recommends reorder (original behavior)
    if (positive(candidate.finaleReorderQty)) return true;
    // Path 2: Any measurable demand — Aria's engine evaluates it
    if (positive(candidate.finaleDemandQty)) return true;
    if (positive(candidate.finaleDemandPerDay)) return true;
    return false;
}
