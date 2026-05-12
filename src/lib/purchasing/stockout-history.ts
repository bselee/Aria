/**
 * @file    stockout-history.ts
 * @purpose Track and read SKU stockout events for accuracy padding.
 *
 * A stockout event is recorded each day a SKU's adjusted runway falls below
 * its lead time during the BOM scan. We read prior counts to pad effective
 * lead time on SKUs that have stocked out before — they've already proven
 * the static defaults aren't enough buffer.
 */
import { createClient } from '@/lib/supabase';

export interface StockoutCount {
    productId: string;
    eventCount: number;
    lastDetectedAt: string | null;
}

/**
 * Load the rolling 180-day event counts for every SKU. Used to pad lead time
 * for SKUs with prior stockouts.
 */
export async function loadStockoutCounts(): Promise<Map<string, StockoutCount>> {
    const map = new Map<string, StockoutCount>();
    const db = createClient();
    if (!db) return map;
    try {
        const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
        const { data, error } = await db
            .from('stockout_events')
            .select('product_id, detected_at')
            .gte('detected_at', since);
        if (error || !data) return map;
        for (const row of data as Array<{ product_id: string; detected_at: string }>) {
            const existing = map.get(row.product_id);
            if (existing) {
                existing.eventCount += 1;
                if (!existing.lastDetectedAt || row.detected_at > existing.lastDetectedAt) {
                    existing.lastDetectedAt = row.detected_at;
                }
            } else {
                map.set(row.product_id, {
                    productId: row.product_id,
                    eventCount: 1,
                    lastDetectedAt: row.detected_at,
                });
            }
        }
    } catch (err: any) {
        console.warn('[stockout-history] load failed:', err.message);
    }
    return map;
}

/**
 * Idempotent per-day insert. Repeated calls on the same product/date update
 * the row instead of duplicating. Best-effort — failures never propagate.
 */
export async function recordStockoutEvent(input: {
    productId: string;
    vendorPartyId: string | null;
    stockOnHand: number;
    stockOnOrder: number;
    dailyBurn: number;
    runwayDays: number;
    leadTimeDays: number;
}): Promise<void> {
    const db = createClient();
    if (!db) return;
    try {
        await db
            .from('stockout_events')
            .upsert(
                {
                    product_id: input.productId,
                    vendor_party_id: input.vendorPartyId,
                    stock_on_hand: input.stockOnHand,
                    stock_on_order: input.stockOnOrder,
                    daily_burn: input.dailyBurn,
                    runway_days: input.runwayDays,
                    lead_time_days: input.leadTimeDays,
                    detected_at: new Date().toISOString(),
                    detected_on: new Date().toISOString().slice(0, 10),
                },
                { onConflict: 'product_id,detected_on' },
            );
    } catch (err: any) {
        console.warn('[stockout-history] record failed:', err.message);
    }
}

/**
 * Effective lead-time pad: if a SKU has prior stockout events in the rolling
 * window, multiply lead time by 1 + 0.5 × min(count, 3). Bounded so a SKU
 * with 1 event gets 1.5×, 2 events 2.0×, 3+ events 2.5× — preventing runaway
 * pads for chronically-stocked-out SKUs.
 */
export function leadTimeMultiplierFromStockouts(eventCount: number): number {
    if (eventCount <= 0) return 1;
    const bumps = Math.min(eventCount, 3);
    return 1 + 0.5 * bumps;
}
