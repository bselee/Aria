/**
 * @file    src/lib/purchasing/sku-lead-time.ts
 * @purpose SKU-grain observed lead times from Finale PO send/create → receive.
 *          Time-weighted + robust + trend-aware planning lead for Aria ordering
 *          (no dashboard). Beats vendor-blended / static BAS supplierLeadDays by
 *          using real receipt history per SKU, overweighting recent cycles, and
 *          reacting when a vendor is slowing down.
 * @author  Hermia
 * @created 2026-07-29
 * @deps    none (pure + module cache)
 */

/** One completed PO cycle attributed to a SKU. */
export interface SkuLeadSample {
    /** Lead days (anchor → receive). */
    days: number;
    /** ISO receive date (Finale receiveDate) — used for time weight + trend. */
    receiveDate: string;
    /** Finale order id, so a thread hold can drop this cycle. */
    orderId?: string;
    /** True when the PO thread said sold out / backorder for this cycle. */
    holdExcluded?: boolean;
    /** Short reason shown on the card when this cycle is dropped. */
    holdNote?: string;
}

export const SKU_LEAD_MIN_SAMPLES_ANY = 1;
/** Half-life for exponential time weights (calendar days). */
export const SKU_LEAD_EWMA_HALF_LIFE_DAYS = 90;
/** Soft ceiling — matches Finale history sanity bound. */
export const SKU_LEAD_MAX_DAYS = 365;
/** A single cycle longer than this does not set the plan. 2× the 21d default. */
export const LONE_LONG_CYCLE_DAYS = 42;
/** One sample this far above the rest is a one-off, not the lead. */
export const LEAD_OUTLIER_RATIO = 2.5;

const _exclusionNotes = new Map<string, string>();

let _skuLeadSamples: Map<string, SkuLeadSample[]> = new Map();
let _skuLeadAt = 0;
const SKU_LEAD_TTL_MS = 4 * 60 * 60 * 1000;

export function clearSkuLeadTimeCache(): void {
    _skuLeadSamples = new Map();
    _skuLeadAt = 0;
    _exclusionNotes.clear();
}

/** Replace cache (called from FinalePurchasingClient.getVendorLeadTimeHistory). */
export function setSkuLeadTimeSamples(samples: Map<string, SkuLeadSample[]>): void {
    _skuLeadSamples = samples;
    _skuLeadAt = Date.now();
}

/** Back-compat: plain day arrays → undated samples (receiveDate = epoch rank). */
export function setSkuLeadTimeSamplesFromDays(samples: Map<string, number[]>): void {
    const mapped = new Map<string, SkuLeadSample[]>();
    for (const [sku, days] of samples) {
        mapped.set(
            sku,
            days.map((d, i) => ({
                days: d,
                // Synthetic ascending dates so EWMA still prefers later indices
                receiveDate: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
            })),
        );
    }
    setSkuLeadTimeSamples(mapped);
}

export function getSkuLeadTimeSamples(): Map<string, SkuLeadSample[]> {
    if (Date.now() - _skuLeadAt > SKU_LEAD_TTL_MS) return new Map();
    return _skuLeadSamples;
}

export function percentileNearest(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 0) return 0;
    if (sortedAsc.length === 1) return sortedAsc[0];
    const idx = Math.min(
        sortedAsc.length - 1,
        Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
    );
    return sortedAsc[idx];
}

function parseReceiveMs(iso: string): number {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : 0;
}

/** Drop gross outliers via Tukey IQR when n≥5; else keep all clean samples. */
export function robustLeadDays(samples: SkuLeadSample[]): number[] {
    const clean = samples
        .map((s) => s.days)
        .filter((d) => Number.isFinite(d) && d >= 0 && d <= SKU_LEAD_MAX_DAYS);
    if (clean.length < 5) return clean;
    const sorted = [...clean].sort((a, b) => a - b);
    const q1 = percentileNearest(sorted, 25);
    const q3 = percentileNearest(sorted, 75);
    const iqr = Math.max(1, q3 - q1);
    const lo = q1 - 1.5 * iqr;
    const hi = q3 + 1.5 * iqr;
    const filtered = clean.filter((d) => d >= lo && d <= hi);
    return filtered.length >= 3 ? filtered : clean;
}

export function summarizeLeadSamples(days: number[]): {
    n: number;
    p50: number;
    p75: number;
    p90: number;
    max: number;
    mean: number;
} | null {
    const clean = days.filter((d) => Number.isFinite(d) && d >= 0 && d <= SKU_LEAD_MAX_DAYS);
    if (clean.length === 0) return null;
    const sorted = [...clean].sort((a, b) => a - b);
    const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
    return {
        n: sorted.length,
        p50: percentileNearest(sorted, 50),
        p75: percentileNearest(sorted, 75),
        p90: percentileNearest(sorted, 90),
        max: sorted[sorted.length - 1],
        mean,
    };
}

/**
 * Exponential time-weighted mean. Half-life defaults to 90d — a receipt today
 * weighs 2× one from ~90d ago, 4× one from ~180d ago. Smooths noise but tracks drift.
 */
export function ewmaLeadDays(
    samples: SkuLeadSample[],
    halfLifeDays = SKU_LEAD_EWMA_HALF_LIFE_DAYS,
    asOfMs = Date.now(),
): number | null {
    const usable = samples.filter(
        (s) => Number.isFinite(s.days) && s.days >= 0 && s.days <= SKU_LEAD_MAX_DAYS,
    );
    if (usable.length === 0) return null;
    const ln2 = Math.LN2;
    let wSum = 0;
    let wx = 0;
    for (const s of usable) {
        const ageDays = Math.max(0, (asOfMs - parseReceiveMs(s.receiveDate)) / 86_400_000);
        const w = Math.exp((-ln2 * ageDays) / halfLifeDays);
        wSum += w;
        wx += w * s.days;
    }
    if (wSum <= 0) return null;
    return wx / wSum;
}

/** Split samples by receive time into older half / newer half (by count). */
export function splitRecentPrior(samples: SkuLeadSample[]): {
    prior: SkuLeadSample[];
    recent: SkuLeadSample[];
} {
    const sorted = [...samples].sort(
        (a, b) => parseReceiveMs(a.receiveDate) - parseReceiveMs(b.receiveDate),
    );
    if (sorted.length < 2) return { prior: [], recent: sorted };
    const mid = Math.floor(sorted.length / 2);
    return { prior: sorted.slice(0, mid), recent: sorted.slice(mid) };
}

function medianOf(samples: SkuLeadSample[]): number | null {
    const days = samples.map((s) => s.days).filter((d) => Number.isFinite(d));
    if (!days.length) return null;
    const sorted = [...days].sort((a, b) => a - b);
    return percentileNearest(sorted, 50);
}

export type LeadTrend = "stable" | "slowing" | "speeding" | "unknown";

export interface SkuLeadPlan {
    /** Days to use in reorder math. */
    days: number;
    n: number;
    p50: number;
    p90: number;
    ewma: number;
    /** recentHalfMedian - priorHalfMedian (positive = slowing). */
    trendDeltaDays: number;
    trend: LeadTrend;
    confidence: "high" | "medium" | "low";
    provenance: string;
}

/**
 * Drop stockout holds and a single cycle that is >2.5× the rest.
 * Repeating long cycles stay. A short cluster of one is enough to plan from.
 */
export function guardLeadSamples(samples: SkuLeadSample[]): {
    kept: SkuLeadSample[];
    notes: string[];
} {
    const notes: string[] = [];
    const kept = samples.filter((s) => {
        if (!s.holdExcluded) return true;
        notes.push(s.holdNote || `PO ${s.orderId ?? "?"} stockout hold excluded`);
        return false;
    });
    if (kept.length < 2) return { kept, notes };
    const max = kept.reduce((a, b) => (a.days >= b.days ? a : b));
    const others = kept.filter((s) => s !== max).map((s) => s.days).sort((a, b) => a - b);
    const med = percentileNearest(others, 50);
    if (med > 0 && max.days > med * LEAD_OUTLIER_RATIO && max.days - med >= 14) {
        notes.push(`excluded ${Math.round(max.days)}d one-off`);
        return { kept: kept.filter((s) => s !== max), notes };
    }
    return { kept, notes };
}

/**
 * Drop one cycle that is >2.5× the rest. Repeating long cycles stay.
 * Used for vendor median and P90 so one stockout does not set the lead for every SKU.
 */
export function dropLoneLeadOutlier(days: number[]): number[] {
    if (days.length < 2) return days;
    const maxIdx = days.reduce((best, d, i) => (d >= days[best] ? i : best), 0);
    const max = days[maxIdx];
    if (days.filter((d) => d === max).length > 1) return days;
    const others = days.filter((_, i) => i !== maxIdx).sort((a, b) => a - b);
    const med = percentileNearest(others, 50);
    if (med > 0 && max > med * LEAD_OUTLIER_RATIO && max - med >= 14) {
        return days.filter((_, i) => i !== maxIdx);
    }
    return days;
}

/**
 * Wizard planning lead from dated SKU samples.
 *
 * - Hold-stamped cycles and a single >2.5× outlier are dropped first
 * - A lone cycle longer than 42d does not set the plan
 * - IQR-robust when enough points
 * - EWMA (90d half-life) tracks vendor drift / season without thrash
 * - If recent half is clearly slower, ride recent (don't average away bad news)
 * - Floor at p50; use p75/p90 pressure when n supports it
 * - A single short observation still sets the plan
 */
export function planSkuLead(samples: SkuLeadSample[], asOfMs = Date.now()): SkuLeadPlan | null {
    const guarded = guardLeadSamples(samples);
    const dated = guarded.kept.filter(
        (s) => Number.isFinite(s.days) && s.days >= 0 && s.days <= SKU_LEAD_MAX_DAYS,
    );
    if (dated.length === 0) return null;
    if (dated.length === 1 && dated[0].days > LONE_LONG_CYCLE_DAYS) return null;

    const robustDays = robustLeadDays(dated);
    const summary = summarizeLeadSamples(robustDays)!;
    const ewma = ewmaLeadDays(dated, SKU_LEAD_EWMA_HALF_LIFE_DAYS, asOfMs) ?? summary.mean;

    const { prior, recent } = splitRecentPrior(dated);
    const priorMed = medianOf(prior);
    const recentMed = medianOf(recent);
    let trendDelta = 0;
    let trend: LeadTrend = "unknown";
    if (priorMed != null && recentMed != null && prior.length >= 1 && recent.length >= 1) {
        trendDelta = recentMed - priorMed;
        if (recentMed >= priorMed * 1.15 && trendDelta >= 5) trend = "slowing";
        else if (recentMed <= priorMed * 0.85 && trendDelta <= -5) trend = "speeding";
        else trend = "stable";
    }

    let days: number;
    if (summary.n === 1) {
        days = summary.max;
    } else if (summary.n === 2) {
        // Slightly conservative average of the two, pull toward worse case
        days = 0.35 * summary.p50 + 0.65 * summary.max;
    } else {
        // Blend center (EWMA) with upper tail pressure
        const tail = summary.n >= 5 ? summary.p90 : summary.p75;
        days = Math.max(ewma, summary.p50, 0.5 * ewma + 0.5 * tail);
        if (trend === "slowing" && recentMed != null) {
            days = Math.max(days, recentMed * 1.05, ewma);
        }
        // Speeding: don't crash to optimistic floor — keep p50 floor, ease toward EWMA
        if (trend === "speeding") {
            days = Math.max(summary.p50, 0.7 * ewma + 0.3 * summary.p50);
        }
    }

    days = Math.min(SKU_LEAD_MAX_DAYS, Math.max(1, Math.round(days)));

    let confidence: SkuLeadPlan["confidence"] = "low";
    if (summary.n >= 6 && trend !== "unknown") confidence = "high";
    else if (summary.n >= 3) confidence = "medium";

    const trendBit =
        trend === "slowing"
            ? ` · slowing +${Math.round(trendDelta)}d`
            : trend === "speeding"
              ? ` · speeding ${Math.round(trendDelta)}d`
              : "";
    const noteBit = guarded.notes.length ? ` · ${guarded.notes.join("; ")}` : "";
    const provenance = `${days}d SKU plan · n=${summary.n} ewma=${Math.round(ewma)} p50=${summary.p50} p90=${summary.p90}${trendBit}${noteBit}`;

    return {
        days,
        n: summary.n,
        p50: summary.p50,
        p90: summary.p90,
        ewma: Math.round(ewma * 10) / 10,
        trendDeltaDays: Math.round(trendDelta),
        trend,
        confidence,
        provenance,
    };
}

/** @deprecated Use planSkuLead — kept for tests/callers expecting day-only arrays. */
export function planningLeadDaysFromSamples(days: number[]): number | null {
    const samples: SkuLeadSample[] = days.map((d, i) => ({
        days: d,
        receiveDate: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    }));
    return planSkuLead(samples)?.days ?? null;
}

/**
 * Card label for the lead the recommender actually used.
 * A SKU-observed plan must not be captioned as the 21d default.
 * A dropped stockout cycle must say why the default was used.
 */
export function cardLeadLabel(params: {
    resolvedProvenance: string;
    skuObserved: boolean;
    baseProvenance: string;
    exclusionNote: string | null;
    powderOverride: boolean;
    vendorPolicyDays?: number | null;
}): string {
    if (params.powderOverride) return params.resolvedProvenance;
    if (params.skuObserved) return params.resolvedProvenance;
    if (params.vendorPolicyDays != null && params.vendorPolicyDays > 0) {
        return `${params.vendorPolicyDays}d vendor policy override`;
    }
    if (params.exclusionNote) return `${params.baseProvenance} · ${params.exclusionNote}`;
    return params.baseProvenance;
}

/**
 * Note left when a SKU's observed cycles were dropped (stockout hold or lone long cycle).
 * Empty when the plan used the samples as-is.
 */
export function getSkuLeadExclusionNote(productId: string | null | undefined): string | null {
    if (!productId) return null;
    return _exclusionNotes.get(String(productId).trim().toUpperCase()) ?? null;
}

/**
 * Look up cached SKU observed planning lead (populated by lead-history fetch).
 */
export function getObservedSkuLeadDays(productId: string | null | undefined): {
    days: number;
    n: number;
    provenance: string;
    confidence?: SkuLeadPlan["confidence"];
    trend?: LeadTrend;
} | null {
    if (!productId) return null;
    if (Date.now() - _skuLeadAt > SKU_LEAD_TTL_MS) return null;
    const key = String(productId).trim().toUpperCase();
    const samples = _skuLeadSamples.get(key);
    if (!samples || samples.length < SKU_LEAD_MIN_SAMPLES_ANY) return null;
    const guarded = guardLeadSamples(samples);
    const loneLong = guarded.kept.length === 1 && guarded.kept[0].days > LONE_LONG_CYCLE_DAYS;
    const note = [
        ...guarded.notes,
        loneLong ? `lone ${Math.round(guarded.kept[0].days)}d cycle not used as lead` : "",
    ].filter(Boolean).join("; ");
    if (note) _exclusionNotes.set(key, note);
    else _exclusionNotes.delete(key);
    const plan = planSkuLead(samples);
    if (!plan) return null;
    return {
        days: plan.days,
        n: plan.n,
        provenance: plan.provenance,
        confidence: plan.confidence,
        trend: plan.trend,
    };
}
