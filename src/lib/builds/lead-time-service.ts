/**
 * @file    lead-time-service.ts
 * @purpose Unified, cached lead time lookup for purchase order ETA calculations.
 *          Shared by: calendar sync, reorder engine, and build risk analysis.
 *
 * Priority chain (per vendor/SKU):
 *   1. Vendor median — last 90 days of completed POs (≥3 data points required)
 *   2. SKU product lead time — Finale product REST (if sku provided)
 *   3. 14-day global default
 *
 * Cache TTL: 4 hours (same as calendar sync cron interval).
 * One Finale GraphQL call fills the entire vendor map; subsequent lookups are instant.
 */

import { FinaleClient } from '../finale/client';

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export interface LeadTimeResult {
    days: number;
    provenance: 'vendor_median' | 'sku_product' | 'default';
    label: string; // e.g. "13d median · vendor history" | "7d (Finale)" | "14d default"
}

// ──────────────────────────────────────────────────
// SERVICE
// ──────────────────────────────────────────────────

export class LeadTimeService {
    private cache: Map<string, number> | null = null; // normalized vendorName → medianDays
    private cacheAt = 0;
    static readonly TTL = 4 * 60 * 60 * 1000; // 4 hours

    /**
     * Pre-warm the vendor history cache.
     * Call once before bulk operations (calendar sync, reorder engine run).
     * No-op if cache is fresh (within TTL).
     */
    async warmCache(): Promise<void> {
        const now = Date.now();
        if (this.cache && now - this.cacheAt < LeadTimeService.TTL) return;

        try {
            const finale = new FinaleClient();
            this.cache = await finale.getVendorLeadTimeHistory(90);
            this.cacheAt = now;
            console.log(`[LeadTimeService] Cache warmed — ${this.cache.size} vendor(s) with history`);
        } catch (err: any) {
            console.warn(`[LeadTimeService] Cache warm failed: ${err.message} — falling back to defaults`);
            this.cache = new Map(); // empty but non-null so we don't retry immediately
            this.cacheAt = now;
        }
    }

    /**
     * Get lead time for a given vendor (and optionally a specific SKU as fallback).
     * Always returns a result — never throws.
     *
     * @param vendorName  Vendor name string (matched case-insensitively)
     * @param sku         Finale SKU to query if vendor history is unavailable
     */
    async getForVendor(vendorName: string, sku?: string): Promise<LeadTimeResult> {
        // Ensure cache is warm (no-op if fresh)
        if (!this.cache) await this.warmCache();

        // 1. Vendor history median
        if (this.cache && vendorName) {
            const key = vendorName.trim().toLowerCase();
            // Try exact match first, then partial match
            for (const [cacheKey, days] of this.cache.entries()) {
                if (cacheKey === key || cacheKey.includes(key) || key.includes(cacheKey)) {
                    return {
                        days,
                        provenance: 'vendor_median',
                        label: `${days}d median · vendor history`,
                    };
                }
            }
        }

        // 2. SKU product-level lead time from Finale REST
        if (sku) {
            try {
                const finale = new FinaleClient();
                const skuDays = await finale.getLeadTime(sku);
                if (skuDays !== null) {
                    return {
                        days: skuDays,
                        provenance: 'sku_product',
                        label: `${skuDays}d (Finale)`,
                    };
                }
            } catch { /* fall through to default */ }
        }

        // 3. Global default
        return {
            days: 14,
            provenance: 'default',
            label: '14d default',
        };
    }

    /** Invalidate the cache (e.g. after receiving a PO — lead time history just changed). */
    invalidate(): void {
        this.cache = null;
        this.cacheAt = 0;
    }
}

// ──────────────────────────────────────────────────
// SINGLETON
// ──────────────────────────────────────────────────

/** Process-level singleton. Import this everywhere instead of constructing new instances. */
export const leadTimeService = new LeadTimeService();
