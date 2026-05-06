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
    /** Compute builds-worth given current stock and a specific FG batch size */
    computeBuildsWorth: (stock: number, batchSize: number) => number;
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
                    computeBuildsWorth: (stock: number, batchSize: number) => {
                        if (batchSize <= 0 || comp.quantity <= 0) return 0;
                        return stock / (comp.quantity * batchSize);
                    },
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
        merged.set(g.vendorPartyId, { ...g, items: [...g.items] });
    }

    for (const g of bomGroups) {
        const existing = merged.get(g.vendorPartyId);
        if (existing) {
            existing.items.push(...g.items);
            if (urgencyRank[g.urgency] < urgencyRank[existing.urgency]) {
                existing.urgency = g.urgency;
            }
        } else {
            merged.set(g.vendorPartyId, { ...g, items: [...g.items] });
        }
    }

    // Sort: worst urgency first, then alphabetical
    return Array.from(merged.values()).sort((a, b) => {
        const ud = urgencyRank[a.urgency] - urgencyRank[b.urgency];
        return ud !== 0 ? ud : a.vendorName.localeCompare(b.vendorName);
    });
}
