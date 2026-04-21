/**
 * @file    src/lib/purchasing/uline-demand.ts
 * @purpose Shared ULINE demand model — normalized demand from multiple sources.
 *
 * Used by both the dashboard orchestration path and CLI path to represent
 * raw ULINE demand before it is converted to ULINE cart quantities.
 *
 * Demand sources:
 *   - "finale"      — items from Finale POs (draft or auto-reorder)
 *   - "requests"     — items requested via Slack/Telegram (slack_requests table)
 *   - "basauto"      — items scraped from basauto.vercel.app
 */

export type UlineDemandSource = 'finale' | 'requests' | 'basauto';

export interface UlineDemandItem {
    sku: string;
    description: string;
    requiredQty: number;
    contributingSources: UlineDemandSource[];
}

export interface UlineDemandManifest {
    source: 'finale' | 'requests' | 'basauto' | 'merged';
    items: UlineDemandItem[];
    totalEstimatedLines: number;
}

function mergeBySku(demands: UlineDemandItem[]): UlineDemandItem[] {
    const merged = new Map<string, UlineDemandItem>();

    for (const item of demands) {
        const existing = merged.get(item.sku);
        if (existing) {
            existing.requiredQty += item.requiredQty;
            for (const src of item.contributingSources) {
                if (!existing.contributingSources.includes(src)) {
                    existing.contributingSources.push(src);
                }
            }
        } else {
            merged.set(item.sku, {
                sku: item.sku,
                description: item.description,
                requiredQty: item.requiredQty,
                contributingSources: [...item.contributingSources],
            });
        }
    }

    return Array.from(merged.values());
}

export function mergeUlineDemand(demands: UlineDemandItem[]): UlineDemandManifest {
    const items = mergeBySku(demands);
    const sourceSet = new Set<UlineDemandSource>();
    for (const d of demands) {
        for (const s of d.contributingSources) sourceSet.add(s);
    }
    const sources = Array.from(sourceSet);

    return {
        source: sources.length > 1 ? 'merged' : (sources[0] ?? 'finale'),
        items,
        totalEstimatedLines: items.length,
    };
}

export function ulineDemandToOrderingInput(
    manifest: UlineDemandManifest,
): Array<{ finaleSku: string; finaleEachQuantity: number; description: string }> {
    return manifest.items.map(item => ({
        finaleSku: item.sku,
        finaleEachQuantity: item.requiredQty,
        description: item.description,
    }));
}
