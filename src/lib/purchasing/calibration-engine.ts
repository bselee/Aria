/**
 * @file    calibration-engine.ts
 * @purpose Closes the loop on the canonical recommender. Two passes:
 *
 *   1. attachReceivedPOsToRecommendations() — for every recently-received PO,
 *      find the recommendation snapshot that drove it (matched on
 *      product_id + vendor_party_id + recommended_at within the cover window)
 *      and write `actual_consumed_eaches`, `consumption_window_days`, `error_pct`.
 *
 *   2. recomputeVendorCalibrationStats() — roll the calibrated rows into the
 *      vendor_calibration_stats table: sample_count, median_error_pct, bias_pct,
 *      and a derived safety_multiplier the recommender consumes on the next run.
 *
 *      safety_multiplier policy:
 *      - sample_count <  5  → 1.0 (no signal yet)
 *      - |median| < 25%     → 1.0 (within tolerance)
 *      - bias < -25%        → 1.25 (we're under-ordering — widen by 25%)
 *      - bias < -50%        → 1.5  (substantial under-order)
 *      - bias > +25%        → 0.85 (we're over-ordering — tighten 15%)
 *      - bias > +50%        → 0.75 (substantial over-order)
 */

import { createClient } from "../db";
import { finaleClient } from "../finale/client";
import { withToolAudit, type ToolAuditContext } from "../agents/tool-registry";

interface RecRow {
    id: number;
    product_id: string;
    vendor_party_id: string | null;
    recommended_qty: number;
    recommended_at: string;
    inputs_jsonb: any;
}

interface ReceivedPO {
    orderId: string;
    vendorName: string;
    receiveDate: string;
    items: Array<{ productId: string; quantity: number }>;
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function mean(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Walk recently-received POs, look up the recommendation that drove each line,
 * and stamp `actual_consumed_eaches` + `error_pct`. Idempotent — already-
 * calibrated rows are skipped.
 *
 * Matching strategy (per line):
 *   1. **Precision** — find an uncalibrated rec whose `resulting_po_number`
 *      already matches this PO. This is the deterministic link stamped by
 *      `stampRecommendationsWithDraftPO` at draft time. No time window —
 *      explicit stamps are authoritative.
 *   2. **Fuzzy fallback** — most-recent uncalibrated rec for this SKU within
 *      60d before receive, **excluding rows already stamped to a different
 *      PO**. Catches POs created before the explicit stamp infra existed,
 *      manually-added lines that bypassed the stamp, and POs received before
 *      the rec snapshot landed.
 */
export async function attachReceivedPOsToRecommendations(daysBack = 30): Promise<{
    receivedPOs: number;
    matched: number;
    calibrated: number;
    matchMethods: { precision: number; fuzzy: number };
}> {
    const out = { receivedPOs: 0, matched: 0, calibrated: 0, matchMethods: { precision: 0, fuzzy: 0 } };
    const db = createClient();
    if (!db) return out;

    const recentPOs = await withToolAudit(
        "getRecentPurchaseOrders",
        { agent: "calibration-engine" },
        { daysBack },
        () => finaleClient.getRecentPurchaseOrders(daysBack),
    );
    const received: ReceivedPO[] = recentPOs
        .filter(po => po.receiveDate && po.status?.toLowerCase() === "completed")
        .map(po => ({
            orderId: po.orderId,
            vendorName: po.vendorName,
            receiveDate: po.receiveDate as string,
            items: po.items?.map(i => ({ productId: i.productId, quantity: i.quantity })) ?? [],
        }));
    out.receivedPOs = received.length;

    for (const po of received) {
        for (const line of po.items) {
            try {
                let rec: RecRow | undefined;
                let matchMethod: "precision" | "fuzzy" | null = null;

                // 1. Precision: explicit draft-time stamp for this PO + SKU.
                const { data: precise } = await db
                    .from("qty_recommendations")
                    .select("id, product_id, vendor_party_id, recommended_qty, recommended_at, inputs_jsonb")
                    .eq("product_id", line.productId)
                    .eq("resulting_po_number", po.orderId)
                    .is("calibrated_at", null)
                    .order("recommended_at", { ascending: false })
                    .limit(1) as { data: RecRow[] | null };
                if (precise && precise.length > 0) {
                    rec = precise[0];
                    matchMethod = "precision";
                }

                // 2. Fuzzy: most-recent uncalibrated rec in 60d window, but
                // skip rows already linked to a *different* PO (prevents
                // double-attribution when the explicit stamp lives elsewhere).
                if (!rec) {
                    const lookbackStart = new Date(po.receiveDate);
                    lookbackStart.setDate(lookbackStart.getDate() - 60);

                    const { data: fuzzy } = await db
                        .from("qty_recommendations")
                        .select("id, product_id, vendor_party_id, recommended_qty, recommended_at, inputs_jsonb")
                        .eq("product_id", line.productId)
                        .is("calibrated_at", null)
                        .is("resulting_po_number", null)
                        .gte("recommended_at", lookbackStart.toISOString())
                        .lte("recommended_at", po.receiveDate)
                        .order("recommended_at", { ascending: false })
                        .limit(1) as { data: RecRow[] | null };
                    if (fuzzy && fuzzy.length > 0) {
                        rec = fuzzy[0];
                        matchMethod = "fuzzy";
                    }
                }

                if (!rec || !matchMethod) continue;
                out.matched += 1;
                out.matchMethods[matchMethod] += 1;

                const recAt = new Date(rec.recommended_at);
                const recvAt = new Date(po.receiveDate);
                const windowDays = Math.max(
                    1,
                    Math.round((recvAt.getTime() - recAt.getTime()) / 86_400_000),
                );

                const actualConsumed = line.quantity;
                const recommendedQty = Number(rec.recommended_qty) || 0;
                const errorPct = recommendedQty > 0
                    ? Math.round(((recommendedQty - actualConsumed) / actualConsumed) * 100)
                    : 0;

                const { error } = await db
                    .from("qty_recommendations")
                    .update({
                        po_number: po.orderId,
                        actual_consumed_eaches: actualConsumed,
                        consumption_window_days: windowDays,
                        error_pct: errorPct,
                        calibrated_at: new Date().toISOString(),
                    })
                    .eq("id", rec.id);

                if (!error) out.calibrated += 1;
            } catch (err: any) {
                console.warn(`[calibration-engine] line calibration failed for ${line.productId}: ${err.message}`);
            }
        }
    }

    if (out.calibrated > 0) {
        console.log(`[calibration-engine] calibrated ${out.calibrated}/${out.matched} lines · precision=${out.matchMethods.precision} fuzzy=${out.matchMethods.fuzzy}`);
    }
    return out;
}

/**
 * Roll up calibrated recommendations per vendor into rolling stats.
 * Ignores vendors with fewer than 5 samples — recommender skips multiplier in that case.
 */
export async function recomputeVendorCalibrationStats(): Promise<{ vendors: number }> {
    const db = createClient();
    if (!db) return { vendors: 0 };

    const { data: rows } = await db
        .from("qty_recommendations")
        .select("vendor_party_id, vendor_name, error_pct")
        .not("vendor_party_id", "is", null)
        .not("error_pct", "is", null);

    if (!rows || rows.length === 0) return { vendors: 0 };

    const byVendor = new Map<string, { vendorName: string | null; errors: number[] }>();
    for (const row of rows) {
        const id = row.vendor_party_id as string;
        if (!byVendor.has(id)) byVendor.set(id, { vendorName: row.vendor_name ?? null, errors: [] });
        byVendor.get(id)!.errors.push(Number(row.error_pct));
    }

    let touched = 0;
    for (const [vendorPartyId, { vendorName, errors }] of byVendor) {
        const sampleCount = errors.length;
        if (sampleCount === 0) continue;

        const med = median(errors);
        const avg = mean(errors);
        const bias = avg;

        let safetyMultiplier = 1.0;
        if (sampleCount >= 5 && bias != null && Math.abs(bias) >= 25) {
            if (bias <= -50) safetyMultiplier = 1.5;
            else if (bias <= -25) safetyMultiplier = 1.25;
            else if (bias >= 50) safetyMultiplier = 0.75;
            else if (bias >= 25) safetyMultiplier = 0.85;
        }

        const { error } = await db
            .from("vendor_calibration_stats")
            .upsert({
                vendor_party_id: vendorPartyId,
                vendor_name: vendorName,
                sample_count: sampleCount,
                median_error_pct: med,
                mean_error_pct: avg,
                bias_pct: bias,
                safety_multiplier: safetyMultiplier,
                last_computed_at: new Date().toISOString(),
            }, { onConflict: "vendor_party_id" });

        if (!error) touched += 1;
    }
    return { vendors: touched };
}

/**
 * "Aria deviated from Finale" weekly retro — summarise calibrated rows where
 * recommended qty diverged materially from finale_reorder_qty. Used by the
 * Friday weekly digest.
 */
export interface AriaVsFinaleSummary {
    totalSamples: number;
    coveredSamples: number;
    ariaUnderFinaleCount: number;
    ariaOverFinaleCount: number;
    medianAriaErrorPct: number | null;
    medianFinaleErrorPct: number | null;
    worstAriaMisses: Array<{ productId: string; vendorName: string | null; recommendedQty: number; actualConsumed: number; errorPct: number }>;
    bestAriaWins: Array<{ productId: string; vendorName: string | null; recommendedQty: number; actualConsumed: number; finaleQty: number | null; ariaErrorPct: number; finaleErrorPct: number }>;
}

export async function summarizeAriaVsFinale(daysBack = 7): Promise<AriaVsFinaleSummary> {
    const db = createClient();
    const empty: AriaVsFinaleSummary = {
        totalSamples: 0, coveredSamples: 0,
        ariaUnderFinaleCount: 0, ariaOverFinaleCount: 0,
        medianAriaErrorPct: null, medianFinaleErrorPct: null,
        worstAriaMisses: [], bestAriaWins: [],
    };
    if (!db) return empty;

    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    const { data: rows } = await db
        .from("qty_recommendations")
        .select("product_id, vendor_name, recommended_qty, finale_reorder_qty, actual_consumed_eaches, error_pct, calibrated_at")
        .not("calibrated_at", "is", null)
        .gte("calibrated_at", since.toISOString());

    if (!rows || rows.length === 0) return empty;

    const ariaErrors: number[] = [];
    const finaleErrors: number[] = [];
    let underCount = 0;
    let overCount = 0;
    let coveredSamples = 0;
    const wins: AriaVsFinaleSummary["bestAriaWins"] = [];
    const misses: AriaVsFinaleSummary["worstAriaMisses"] = [];

    for (const row of rows) {
        const recQty = Number(row.recommended_qty) || 0;
        const actual = Number(row.actual_consumed_eaches) || 0;
        const finaleQty = row.finale_reorder_qty != null ? Number(row.finale_reorder_qty) : null;
        const ariaErr = Number(row.error_pct);
        if (!Number.isFinite(ariaErr)) continue;

        ariaErrors.push(ariaErr);
        if (Math.abs(ariaErr) >= 25) misses.push({
            productId: row.product_id,
            vendorName: row.vendor_name,
            recommendedQty: recQty,
            actualConsumed: actual,
            errorPct: ariaErr,
        });

        if (finaleQty != null && finaleQty > 0 && actual > 0) {
            coveredSamples += 1;
            const finaleErr = Math.round(((finaleQty - actual) / actual) * 100);
            finaleErrors.push(finaleErr);

            if (Math.abs(ariaErr) < Math.abs(finaleErr) - 10) {
                wins.push({
                    productId: row.product_id,
                    vendorName: row.vendor_name,
                    recommendedQty: recQty,
                    actualConsumed: actual,
                    finaleQty,
                    ariaErrorPct: ariaErr,
                    finaleErrorPct: finaleErr,
                });
            }
            if (recQty < (finaleQty ?? 0)) underCount += 1;
            else if (recQty > (finaleQty ?? 0)) overCount += 1;
        }
    }

    misses.sort((a, b) => Math.abs(b.errorPct) - Math.abs(a.errorPct));
    wins.sort((a, b) =>
        (Math.abs(b.finaleErrorPct) - Math.abs(b.ariaErrorPct))
        - (Math.abs(a.finaleErrorPct) - Math.abs(a.ariaErrorPct))
    );

    return {
        totalSamples: rows.length,
        coveredSamples,
        ariaUnderFinaleCount: underCount,
        ariaOverFinaleCount: overCount,
        medianAriaErrorPct: median(ariaErrors),
        medianFinaleErrorPct: finaleErrors.length > 0 ? median(finaleErrors) : null,
        worstAriaMisses: misses.slice(0, 5),
        bestAriaWins: wins.slice(0, 5),
    };
}
