import { PurchasingGroup } from './client';

// ── Types ──────────────────────────────────────────────────────────────────

export interface FGVelocity {
    sku: string;
    name: string;
    dailySalesRate: number;
    bom: Array<{ componentSku: string; quantity: number }>;
}

export interface ComponentDemand {
    componentSku: string;
    totalBurnRate: number;
    feedsFinishedGoods: Array<{
        sku: string;
        name: string;
        dailySalesRate: number;
        qtyPerUnit: number;
    }>;
}

// ── Pure computation ───────────────────────────────────────────────────────

/**
 * Given FG sales velocities and their BOMs, compute per-component burn rates.
 * This is a pure function — no API calls.
 */
export function computeComponentBurnRates(fgVelocities: FGVelocity[]): Map<string, ComponentDemand> {
    const components = new Map<string, ComponentDemand>();

    for (const fg of fgVelocities) {
        for (const comp of fg.bom) {
            const existing = components.get(comp.componentSku);
            const burnContribution = fg.dailySalesRate * comp.quantity;

            if (existing) {
                existing.totalBurnRate += burnContribution;
                existing.feedsFinishedGoods.push({
                    sku: fg.sku,
                    name: fg.name,
                    dailySalesRate: fg.dailySalesRate,
                    qtyPerUnit: comp.quantity,
                });
            } else {
                components.set(comp.componentSku, {
                    componentSku: comp.componentSku,
                    totalBurnRate: burnContribution,
                    feedsFinishedGoods: [{
                        sku: fg.sku,
                        name: fg.name,
                        dailySalesRate: fg.dailySalesRate,
                        qtyPerUnit: comp.quantity,
                    }],
                });
            }
        }
    }

    return components;
}

/**
 * Classify urgency based on runway days vs lead time.
 * Same tiers as getPurchasingIntelligence.
 */
export function classifyUrgency(runwayDays: number, leadTimeDays: number): 'critical' | 'warning' | 'watch' | 'ok' {
    if (runwayDays < leadTimeDays) return 'critical';
    if (runwayDays < leadTimeDays + 30) return 'warning';
    if (runwayDays < leadTimeDays + 60) return 'watch';
    return 'ok';
}

/**
 * Pick a daily-burn signal for a BOM component. Receipt velocity is primary
 * (encodes seasonality, builds, contract production); FG-derived burn is the
 * fallback when the component has no purchase history yet.
 */
export function chooseBomVelocity(input: { receiptVelocity: number; bomDerivedVelocity: number }):
    { value: number; source: 'receipts' | 'demand' | 'none' } {
    if (input.receiptVelocity > 0) return { value: input.receiptVelocity, source: 'receipts' };
    if (input.bomDerivedVelocity > 0) return { value: input.bomDerivedVelocity, source: 'demand' };
    return { value: 0, source: 'none' };
}

/**
 * Confidence in a receipt-derived velocity. Many POs spread across the window
 * means the rate is stable; one bulk-buy is suspect.
 *
 *   high   ≥4 POs spread ≥180 days
 *   medium 2-3 POs spread ≥90 days
 *   low    everything else (single PO, or all POs clustered <90 days)
 */
export function computeReceiptConfidence(input: {
    purchaseCount: number;
    firstPurchaseDate: string | null;
    lastPurchaseDate: string | null;
}): 'high' | 'medium' | 'low' {
    const { purchaseCount, firstPurchaseDate, lastPurchaseDate } = input;
    if (purchaseCount <= 1 || !firstPurchaseDate || !lastPurchaseDate) return 'low';
    const spreadDays = Math.max(
        0,
        (new Date(lastPurchaseDate).getTime() - new Date(firstPurchaseDate).getTime()) / 86_400_000,
    );
    if (purchaseCount >= 4 && spreadDays >= 180) return 'high';
    if (purchaseCount >= 2 && spreadDays >= 90) return 'medium';
    return 'low';
}

/**
 * Median gap (in days) between consecutive PO dates. Captures the natural
 * order cadence — e.g. monthly truckloads → ~30. Returns null when there
 * are fewer than 2 PO dates.
 */
export function computeMedianPOGap(dates: string[]): number | null {
    if (!dates || dates.length < 2) return null;
    const sorted = [...dates]
        .map(d => new Date(d).getTime())
        .filter(t => !isNaN(t))
        .sort((a, b) => a - b);
    if (sorted.length < 2) return null;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
        gaps.push((sorted[i] - sorted[i - 1]) / 86_400_000);
    }
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/**
 * Cadence-aware BOM urgency classifier. Uses the SKU's own median PO gap as
 * the planning horizon when known — so a monthly-ordered item turns warning
 * when adjusted runway drops below leadTime + 30, regardless of static
 * thresholds. Falls back to BOM-tuned defaults (leadTime + 45 / + 90).
 */
export function classifyBomUrgency(input: {
    adjustedRunwayDays: number;
    leadTimeDays: number;
    medianPOGapDays: number | null;
}): 'critical' | 'warning' | 'watch' | 'ok' {
    const { adjustedRunwayDays, leadTimeDays, medianPOGapDays } = input;
    if (adjustedRunwayDays < leadTimeDays) return 'critical';

    const cadence = medianPOGapDays && medianPOGapDays > 0 ? medianPOGapDays : null;
    const warningCut = cadence != null ? leadTimeDays + cadence : leadTimeDays + 45;
    const watchCut = cadence != null ? leadTimeDays + cadence * 2 : leadTimeDays + 90;

    if (adjustedRunwayDays < warningCut) return 'warning';
    if (adjustedRunwayDays < watchCut) return 'watch';
    return 'ok';
}

/**
 * Cognitive rounding for BOM components: snap suggested quantity to your usual
 * order size based on past PO line qtys. Catches case/pallet/truckload sizes
 * we never declared explicitly. Returns the original suggestion unchanged
 * when history is too sparse or too variable.
 *
 *   - 0 past qtys                  → no rounding (low signal)
 *   - 1 past qty                   → snap up to that multiple (low confidence)
 *   - 2+ past qtys with mode       → snap up to mode (high confidence)
 *   - 2+ past qtys, no mode, low variance (CV<0.4) → snap up to median
 *   - 2+ past qtys, high variance  → no rounding (orders are too variable)
 */
export function applyCommonOrderRounding(input: {
    rawSuggestedQty: number;
    purchaseQtys: number[];
}): {
    suggestedQty: number;
    rawSuggestedQty: number;
    commonOrderQty: number | null;
    rationale: 'mode' | 'median' | 'single' | 'variable' | 'no-history';
} {
    const { rawSuggestedQty, purchaseQtys } = input;
    if (!purchaseQtys || purchaseQtys.length === 0) {
        return { suggestedQty: rawSuggestedQty, rawSuggestedQty, commonOrderQty: null, rationale: 'no-history' };
    }

    if (purchaseQtys.length === 1) {
        const qty = purchaseQtys[0];
        const snapped = Math.max(qty, Math.ceil(rawSuggestedQty / qty) * qty);
        return { suggestedQty: snapped, rawSuggestedQty, commonOrderQty: qty, rationale: 'single' };
    }

    // Try mode first — value appearing in ≥40% of POs is the "usual" size.
    const counts = new Map<number, number>();
    for (const q of purchaseQtys) counts.set(q, (counts.get(q) || 0) + 1);
    let modeQty: number | null = null;
    let modeCount = 0;
    for (const [q, c] of counts) {
        if (c > modeCount) { modeCount = c; modeQty = q; }
    }
    if (modeQty != null && modeCount / purchaseQtys.length >= 0.4) {
        const snapped = Math.max(modeQty, Math.ceil(rawSuggestedQty / modeQty) * modeQty);
        return { suggestedQty: snapped, rawSuggestedQty, commonOrderQty: modeQty, rationale: 'mode' };
    }

    // Coefficient of variation = stddev / mean. Low CV = consistent order size.
    const mean = purchaseQtys.reduce((s, q) => s + q, 0) / purchaseQtys.length;
    const variance = purchaseQtys.reduce((s, q) => s + (q - mean) ** 2, 0) / purchaseQtys.length;
    const stddev = Math.sqrt(variance);
    const cv = mean > 0 ? stddev / mean : 0;
    if (cv < 0.4) {
        const sorted = [...purchaseQtys].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        const snapped = Math.max(median, Math.ceil(rawSuggestedQty / median) * median);
        return { suggestedQty: snapped, rawSuggestedQty, commonOrderQty: median, rationale: 'median' };
    }

    return { suggestedQty: rawSuggestedQty, rawSuggestedQty, commonOrderQty: null, rationale: 'variable' };
}

/**
 * Estimate the date by which the next PO should be placed: today + (runway
 * until lead-time buffer). Negative or zero runway → today.
 */
export function projectNextOrderDate(input: {
    stockOnHand: number;
    stockOnOrder: number;
    dailyBurn: number;
    leadTimeDays: number;
    now?: Date;
}): string {
    const { stockOnHand, stockOnOrder, dailyBurn, leadTimeDays } = input;
    const now = input.now ?? new Date();
    if (dailyBurn <= 0) return new Date(now.getTime() + 365 * 86_400_000).toISOString().slice(0, 10);
    const total = stockOnHand + stockOnOrder;
    const daysUntilThreshold = total / dailyBurn - leadTimeDays;
    const offset = Math.max(0, daysUntilThreshold);
    return new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Merge BOM groups into resale groups by vendorPartyId.
 * Same vendor → one group with both item types; urgency = worst of merged.
 */
export function mergeIntoGroups(
    resaleGroups: PurchasingGroup[],
    bomGroups: PurchasingGroup[]
): PurchasingGroup[] {
    const urgencyRank = { critical: 0, warning: 1, watch: 2, ok: 3 } as const;
    const merged = new Map<string, PurchasingGroup>();

    for (const g of resaleGroups) {
        merged.set(g.vendorPartyId, { ...g, items: g.items.map(it => ({ ...it })) });
    }

    for (const g of bomGroups) {
        const existing = merged.get(g.vendorPartyId);
        if (existing) {
            existing.items.push(...g.items.map(it => ({ ...it })));
            if (urgencyRank[g.urgency] < urgencyRank[existing.urgency]) {
                existing.urgency = g.urgency;
            }
        } else {
            merged.set(g.vendorPartyId, { ...g, items: g.items.map(it => ({ ...it })) });
        }
    }

    // Sort: worst urgency first, then alphabetical
    return Array.from(merged.values()).sort((a, b) => {
        const ud = urgencyRank[a.urgency] - urgencyRank[b.urgency];
        return ud !== 0 ? ud : a.vendorName.localeCompare(b.vendorName);
    });
}
