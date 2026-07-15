/**
 * @file    lead-time-service.ts
 * @purpose Unified, cached lead time lookup for purchase order ETA calculations.
 *          Shared by: calendar sync, reorder engine, and build risk analysis.
 *
 *          Priority chain (per vendor/SKU):
 *            0. Policy override — vendor_reorder_policies.lead_time_override_days
 *               (highest priority; authoritative manual value for pre-PO production
 *               vendors such as Colorful Packaging where Finale only measures
 *               post-PO receipt time)
 *            1. Vendor median — last 90 days of completed POs (≥3 data points required)
 *            2. SKU product lead time — Finale product REST (if sku provided)
 *            3. 21-day global default
 *
 *          Cache TTL: 4 hours (same as calendar sync cron interval).
 *          One Finale GraphQL call + one Supabase query fills everything.
 * @author  Hermia
 * @created 2026-06-10
 * @updated 2026-06-15 — Added policy override as priority 0 to fix Colorful-style
 *          mismatches where observed median (post-PO) was overriding manual 60d value.
 * @deps    finale/client, supabase
 * @env     none
 */

import { FinaleClient, finaleClient } from '../finale/client';
import { createClient } from '../db';
import { withToolAudit } from '../agents/tool-registry';
import { DEFAULT_LEAD_TIME_DAYS } from '../constants';

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export interface LeadTimeResult {
    days: number;
    provenance: 'policy_override' | 'vendor_median' | 'sku_product' | 'default';
    label: string; // e.g. "60d policy override" | "13d median · vendor history" | "7d (Finale)" | "21d default"
}

export interface LeadTimeDistribution {
    p50: number;
    p90: number;
    sampleCount: number;
}

// ──────────────────────────────────────────────────
// SERVICE
// ──────────────────────────────────────────────────

export class LeadTimeService {
    private cache: Map<string, number> | null = null; // normalized vendorName → medianDays
    private cacheAt = 0;
    private policyCache: Map<string, number> | null = null; // normalized vendorName → overrideDays
    private policyCacheAt = 0;
    static readonly TTL = 4 * 60 * 60 * 1000; // 4 hours

    /** 
     * Pre-warm the vendor history + policy caches.
     * Call once before bulk operations (calendar sync, reorder engine run).
     * No-op if cache is fresh (within TTL).
     */
    async warmCache(): Promise<void> {
        const now = Date.now();
        if (this.cache && this.policyCache && now - this.cacheAt < LeadTimeService.TTL) return;

        try {
            const finale = finaleClient;
            this.cache = await withToolAudit(
                "getVendorLeadTimeHistory",
                { agent: "lead-time-service" },
                { daysBack: 90 },
                () => finale.getVendorLeadTimeHistory(90),
            );
            this.cacheAt = now;
            console.log(`[LeadTimeService] Cache warmed — ${this.cache.size} vendor(s) with history`);

            await this.loadPolicyOverrides();
        } catch (err: any) {
            console.warn(`[LeadTimeService] Cache warm failed: ${err.message} — falling back to defaults`);
            this.cache = new Map();
            this.cacheAt = now;
            this.policyCache = new Map();
            this.policyCacheAt = now;
        }
    }

    /** 
     * Load (or refresh) policy overrides from Supabase.
     * Only vendors with explicit lead_time_override_days set are cached.
     * Separate TTL check so policies can be warm independently if needed.
     */
    private async loadPolicyOverrides(): Promise<void> {
        const now = Date.now();
        if (this.policyCache && now - this.policyCacheAt < LeadTimeService.TTL) return;

        try {
            const db = createClient();
            if (!db) {
                this.policyCache = new Map();
                this.policyCacheAt = now;
                return;
            }

            const { data, error } = await db
                .from('vendor_reorder_policies')
                .select('vendor_name, lead_time_override_days')
                .not('lead_time_override_days', 'is', null);

            if (error || !data) {
                this.policyCache = new Map();
                this.policyCacheAt = now;
                return;
            }

            this.policyCache = new Map<string, number>();
            for (const row of data as Array<{ vendor_name: string | null; lead_time_override_days: number | null }>) {
                if (row.vendor_name && row.lead_time_override_days && row.lead_time_override_days > 0) {
                    const key = row.vendor_name.trim().toLowerCase();
                    this.policyCache.set(key, row.lead_time_override_days);
                }
            }
            this.policyCacheAt = now;
            console.log(`[LeadTimeService] Policy overrides loaded — ${this.policyCache.size} vendor(s)`);
        } catch (err: any) {
            console.warn(`[LeadTimeService] Policy load failed: ${err.message} — falling back`);
            this.policyCache = new Map();
            this.policyCacheAt = now;
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
        // Ensure caches are warm
        if (!this.cache) await this.warmCache();
        if (!this.policyCache) await this.loadPolicyOverrides();

        // 0. Policy override (highest — manual authoritative value)
        if (this.policyCache && vendorName) {
            const key = vendorName.trim().toLowerCase();
            for (const [cacheKey, days] of this.policyCache.entries()) {
                if (cacheKey === key || cacheKey.includes(key) || key.includes(cacheKey)) {
                    return {
                        days,
                        provenance: 'policy_override',
                        label: `${days}d policy override`,
                    };
                }
            }
        }

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
                const finale = finaleClient;
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
            days: DEFAULT_LEAD_TIME_DAYS,
            provenance: 'default',
            label: `${DEFAULT_LEAD_TIME_DAYS}d default`,
        };
    }

    /**
     * P50/P90/sampleCount distribution for a vendor when we have enough history
     * (>=5 receipts). Returns null when the cache is empty or no match found —
     * caller should fall back to the median + buffer model.
     */
    async getDistribution(vendorName: string): Promise<LeadTimeDistribution | null> {
        if (!this.cache) await this.warmCache();
        if (!vendorName) return null;
        const distMap = finaleClient.getVendorLeadTimeDistribution();
        if (distMap.size === 0) return null;
        const key = vendorName.trim().toLowerCase();
        for (const [cacheKey, dist] of distMap.entries()) {
            if (cacheKey.toLowerCase() === key
                || cacheKey.toLowerCase().includes(key)
                || key.includes(cacheKey.toLowerCase())) {
                return dist.sampleCount >= 5 ? dist : null;
            }
        }
        return null;
    }

    /** Invalidate both caches (e.g. after receiving a PO — lead time history just changed). */
    invalidate(): void {
        this.cache = null;
        this.cacheAt = 0;
        this.policyCache = null;
        this.policyCacheAt = 0;
    }
}

// ──────────────────────────────────────────────────
// SINGLETON
// ──────────────────────────────────────────────────

/** Process-level singleton. Import this everywhere instead of constructing new instances. */
export const leadTimeService = new LeadTimeService();
