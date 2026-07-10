/**
 * @file    qty-recommender.ts
 * @purpose Canonical, auditable reorder-quantity calculator.
 *          Pure function — no I/O, no env reads, no Finale calls. All inputs
 *          come from `getPurchasingIntelligence()` after it has resolved
 *          velocity, stock, on-order, lead time, and pack size.
 *
 *          Every recommendation returns a `ProvenanceTrace[]` describing the
 *          arithmetic step-by-step so the dashboard can render a "Why X?"
 *          drawer instead of an opaque number.
 *
 * @design  Phase 1 of the canonical-formula rollout. Behavior here is byte-for-byte
 *          equivalent to the inline math currently in `client.ts:4760-4842`. The
 *          win is the trace, not the math. Phase 2 will swap inputs (BOM
 *          pull-through, P90 lead time, draft reservation, calibration) without
 *          touching the recommender's downstream consumers.
 */

import { roundToCleanQty } from "./cognitive-round";

// Bumped on every behavioral change so the calibration loop can bucket
// error rates per formula. See .agents/plans/2026-05-05-canonical-recommender.md.
//   v2.0-calibrated-2026-05-05 — phase 2 calibration baseline
//   v2.1-vendor-policy-2026-05-06 — vendor reorder policy overrides
//     (lead time override, target cover, MOQ tri-state, overbuy review flags)
//   v2.2-cognitive-round-2026-05-06 — cognitive/historical PO qty rounding
//   v2.3-vendor-fallback-increments-2026-05-07 — vendor-specific fallback increments
//   v2.7-capped-30d-floor-2026-06-11 — 2× cap on 30d supply floor
//   v2.8-residual-reorder-cap-2026-07-10 — open-PO residual uses order-point window, not full target cover
export const QTY_FORMULA_VERSION = "v2.8-residual-topup-cap-2026-07-10";

/** Round a quantity up to the nearest multiple of `incrementQty`, with a floor of `incrementQty`. */
export function snapToIncrement(quantity: number, incrementQty: number | null | undefined): number {
    if (!incrementQty || incrementQty <= 1) return quantity;
    return Math.max(incrementQty, Math.ceil(quantity / incrementQty) * incrementQty);
}

export type Urgency = "critical" | "warning" | "watch" | "ok";

export interface RecommenderInput {
    sku: string;
    vendorName?: string;
    dailyRate: number;
    dailyRateSource: "demand" | "sales" | "receipts" | "none";
    dailyRateLabel: string;             // e.g. "90d demand", "365d sales", "365d receipts"
    velocityInflated?: boolean;
    velocityRawRate?: number;
    velocityRealityCap?: number;
    stockOnHand: number;
    stockOnOrder: number;
    openPOCount: number;
    leadTimeDays: number;
    leadTimeProvenance: string;
    leadTimeP90?: number | null;        // when provided (n>=5 vendor history), used instead of point estimate
    coverBufferDays?: number;           // default 60 — extra cover above lead time
    orderIncrementQty?: number | null;  // pack rounding (Finale "Std reorder in qty of")

    /** Phase 2 — vendor calibration multiplier (>1 widens cover; <1 tightens). */
    safetyMultiplier?: number;
    calibrationSampleCount?: number;
    calibrationMedianErrorPct?: number | null;

    /** Phase 3a — qty already reserved against open draft POs for this SKU. */
    reservedQty?: number;
    reservedDraftPOs?: string[];

    /** MOQ — vendor-level minimums applied after pack rounding. */
    minimumOrderEaches?: number | null;
    minimumOrderDollars?: number | null;
    unitPrice?: number;

    /**
     * v2.1 — vendor reorder policy overrides (`vendor_reorder_policies` table).
     * Default-unchanged: omitting these keeps the v2.0 behavior verbatim.
     */
    leadTimeOverrideDays?: number | null;
    /** Total cover desired (lead + safety in one number). When set, overrides leadTimeUsed + buffer × multiplier and bypasses safetyMultiplier. */
    targetCoverDays?: number | null;
    /** enforce (default — bumps qty), warn (sets moqWarning, no bump), ignore (no bump, no warn). */
    moqMode?: "enforce" | "warn" | "ignore";
    /** Overbuy review threshold — default 50% (i.e. flag when suggestedQty > rawNeededEaches × 1.5). */
    overbuyReviewPct?: number | null;
    /** Overbuy review threshold in dollars — default $1000. */
    overbuyReviewDollars?: number | null;

    /**
     * v2.2 — last N completed PO line qtys for this vendor (across SKUs is fine
     * — vendors tend to use consistent batch sizes for related products).
     * Used by cognitive rounding to detect favorite-batch clusters.
     */
    historicalLineQtys?: number[];
    /** v2.4 — actual quantity ordered last time for this exact SKU. */
    lastPurchaseQty?: number | null;
    /**
     * v2.2 — explicit per-vendor favorite batches from
     * vendor_reorder_policies.favorite_batches. When set (non-empty), overrides
     * historical learning.
     */
    favoriteBatches?: number[] | null;
    /**
     * v2.5 (2026-06-09) — Bill McMahon's KMS101 fix: when a component is
     * BOM-only (BOW&SALE flag absent, or has zero direct sales), the
     * smoothed `dailyRate × coverDays` formula under-shoots the actual
     * 30d BOM-driven need. Callers should pass `bomDrivenNeed` =
     * totalRequiredQty from the FG-traceback snapshot for BOM-only SKUs.
     * The recommender uses this as the PRIMARY `rawNeededEaches` signal,
     * overriding the dailyRate formula. BOW&SALE components (mixed
     * retail + BOM) leave this null and keep the smoothed formula.
     */
    bomDrivenNeed?: number | null;
    /**
     * v2.5 (2026-06-09) — Bill: "look at past orders and gain amounts
     * from last 3-4 orders". Soft cap on `suggestedQty` based on
     * historical PO batch sizes. Prevents runaway recommendations for
     * low-volume SKUs where 1× coverDays gives a wildly larger qty than
     * we've ever actually ordered. Default cap: 2× the median of
     * `historicalLineQtys`. Set to null to disable the cap.
     */
    historicalCapMultiple?: number | null;

    /**
     * v2.6 (2026-06-11) — Bill: "look at past orders — if we always order
     * 20 from Faust, the system should know that." Full per-SKU purchase
     * history (most-recent first). When 3+ entries are consistent (same
     * value or within 20%), the mode becomes a HARD ordering floor so a
     * PO for 5 units never goes to a vendor that always ships 20.
     * Distinct from `historicalLineQtys` (vendor-wide, for cognitive rounding).
     */
    skuPurchaseHistory?: number[];

    /**
     * v2.6 — explicit per-vendor standard order quantity from
     * `vendor_reorder_policies.standard_order_qty`. "For Faust, always
     * order 20." Manual override that takes priority over the historical
     * auto-detect. Null = use historical signal.
     */
    standardOrderQty?: number | null;
}

export interface ProvenanceStep {
    step: string;
    detail: string;
    value?: number | string;
}

export interface RecommenderResult {
    sku: string;
    dailyRate: number;
    runwayDays: number;
    adjustedRunwayDays: number;
    coverDays: number;
    rawNeededEaches: number;
    suggestedQty: number;
    urgency: Urgency;
    explanation: string;
    provenance: ProvenanceStep[];
    formulaVersion: string;
    leadTimeUsed: number;
    leadTimeBasis: "p90" | "median" | "point";
    safetyMultiplier: number;
    reservedQty: number;
    moqApplied: boolean;
    /** v2.1 — true when MOQ would have triggered but moqMode='warn' suppressed the bump. */
    moqWarning: boolean;
    /** v2.1 — true when ordering constraints (pack/MOQ) caused a large overbuy worth Will reviewing. */
    reviewRequired: boolean;
    /** v2.1 — human-readable reasons for reviewRequired (empty when reviewRequired is false). */
    reviewReasons: string[];
    /** v2.2 — which rounding layer fired (cognitive/historical/vendor_explicit), or null if no rounding was needed (qty was 0). */
    roundingMethod?: "cognitive" | "historical" | "vendor_explicit" | null;
    /** v2.2 — two alternative snap targets for the UI override dropdown. */
    roundingAlternatives?: number[];
    /** v2.6 — true when historical pattern or standard_order_qty forced a qty bump. */
    historicalFloorApplied: boolean;
}

function urgencyFor(adjustedRunwayDays: number, leadTimeDays: number): Urgency {
    if (adjustedRunwayDays < leadTimeDays) return "critical";
    if (adjustedRunwayDays < leadTimeDays + 30) return "warning";
    if (adjustedRunwayDays < leadTimeDays + 60) return "watch";
    return "ok";
}

function urgencyNote(urgency: Urgency): string {
    if (urgency === "critical") return "order now, already short";
    if (urgency === "warning") return "order soon";
    if (urgency === "watch") return "monitor";
    return "covered";
}

function fallbackIncrementForVendor(vendorName?: string): number | null {
    if (!vendorName) return null;
    if (/miles\s+filippelli/i.test(vendorName)) return 10;
    return null;
}

/**
 * Median of an array of numbers. Returns 0 for empty input.
 * Used by the historical cap (v2.5) to derive a soft ceiling from past
 * PO batch sizes.
 */
function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function effectiveOrderIncrement(input: RecommenderInput): { increment: number | null; source: "finale" | "vendor_fallback" | "none" } {
    if (input.orderIncrementQty && input.orderIncrementQty > 1) {
        return { increment: input.orderIncrementQty, source: "finale" };
    }
    const fallback = fallbackIncrementForVendor(input.vendorName);
    if (fallback && fallback > 1) {
        return { increment: fallback, source: "vendor_fallback" };
    }
    return { increment: null, source: "none" };
}

export function recommendQty(input: RecommenderInput): RecommenderResult {
    const trace: ProvenanceStep[] = [];

    // ── Step 1: daily rate ────────────────────────────────────────────────
    const dailyRate = Math.max(0, input.dailyRate);
    if (input.velocityInflated) {
        trace.push({
            step: "daily_rate",
            detail: `Capped to reality: Finale reported ${input.velocityRawRate?.toFixed(1)}/d but real ` +
                `sales/receipts are ${input.velocityRealityCap?.toFixed(1)}/d → using ${dailyRate.toFixed(1)}/d`,
            value: dailyRate,
        });
    } else {
        trace.push({
            step: "daily_rate",
            detail: `Pulled from ${input.dailyRateLabel} (source: ${input.dailyRateSource})`,
            value: dailyRate,
        });
    }

    // ── Step 2: stock + on-order + reservations ───────────────────────────
    const stockOnHand = Math.max(0, input.stockOnHand);
    const stockOnOrder = Math.max(0, input.stockOnOrder);
    const reservedQty = Math.max(0, input.reservedQty ?? 0);
    const effectiveStock = stockOnHand;
    trace.push({
        step: "on_hand",
        detail: `${Math.round(effectiveStock)} units on hand`,
        value: effectiveStock,
    });
    if (stockOnOrder > 0) {
        trace.push({
            step: "on_order",
            detail: `${Math.round(stockOnOrder)} units across ${input.openPOCount} open PO(s) — full credit applied`,
            value: stockOnOrder,
        });
    } else {
        trace.push({ step: "on_order", detail: "No open POs", value: 0 });
    }
    if (reservedQty > 0) {
        const draftLabel = (input.reservedDraftPOs ?? []).slice(0, 3).join(", ") || "active drafts";
        trace.push({
            step: "reserved",
            detail: `${Math.round(reservedQty)} units already reserved across drafts (${draftLabel}) — subtracted from incoming credit`,
            value: reservedQty,
        });
    }

    // ── Step 3: runway ────────────────────────────────────────────────────
    const supplyForRunway = effectiveStock + stockOnOrder - reservedQty;
    const runwayDays = dailyRate > 0 ? effectiveStock / dailyRate : Number.POSITIVE_INFINITY;
    const adjustedRunwayDays = dailyRate > 0
        ? Math.max(0, supplyForRunway) / dailyRate
        : Number.POSITIVE_INFINITY;
    trace.push({
        step: "runway",
        detail: `${Math.round(effectiveStock)} ÷ ${dailyRate.toFixed(2)}/d = ${Math.round(runwayDays)}d raw, ` +
            `${Math.round(adjustedRunwayDays)}d after on-order/reserved`,
        value: Math.round(runwayDays),
    });

    // ── Step 4: lead time basis ───────────────────────────────────────────
    // Precedence: vendor policy override > P90 > point/median.
    const leadTimeOverride = input.leadTimeOverrideDays ?? null;
    const leadTimeP90 = input.leadTimeP90 ?? null;
    const hasOverride = leadTimeOverride != null && leadTimeOverride > 0;
    const hasP90 = leadTimeP90 != null && leadTimeP90 > 0;
    const leadTimeUsed = hasOverride
        ? leadTimeOverride!
        : hasP90
            ? leadTimeP90!
            : input.leadTimeDays;
    const leadTimeBasis: "p90" | "median" | "point" = hasOverride
        ? "point"  // override is treated as a point estimate (Will set it deliberately)
        : hasP90
            ? "p90"
            : input.leadTimeProvenance === "vendor_median" ? "median" : "point";
    if (hasOverride) {
        trace.push({
            step: "lead_time",
            detail: `Using ${leadTimeOverride}d vendor policy override (was ${input.leadTimeDays}d ${input.leadTimeProvenance})`,
            value: leadTimeUsed,
        });
    } else if (leadTimeBasis === "p90") {
        trace.push({
            step: "lead_time",
            detail: `Using P90 lead ${leadTimeP90}d (median was ${input.leadTimeDays}d, ${input.leadTimeProvenance})`,
            value: leadTimeUsed,
        });
    } else {
        trace.push({
            step: "lead_time",
            detail: `Using ${input.leadTimeDays}d (${input.leadTimeProvenance}) — no P90 distribution yet`,
            value: leadTimeUsed,
        });
    }

    // ── Step 5: cover window ──────────────────────────────────────────────
    // v2.1 — vendor policy targetCoverDays takes precedence over lead+buffer×multiplier.
    // When targetCoverDays is set, safetyMultiplier is intentionally bypassed: Will
    // set the cover deliberately, calibration shouldn't dampen it.
    const buffer = input.coverBufferDays ?? 30;
    const safetyMultiplier = Math.max(0.5, Math.min(2.5, input.safetyMultiplier ?? 1));
    const targetCoverDays = input.targetCoverDays ?? null;
    let coverDays: number;
    if (targetCoverDays != null && targetCoverDays > 0) {
        coverDays = Math.max(leadTimeUsed, targetCoverDays);
        const bypassed = safetyMultiplier !== 1
            ? ` (safetyMultiplier=${safetyMultiplier.toFixed(2)} bypassed — vendor policy authoritative)`
            : "";
        trace.push({
            step: "cover_days",
            detail: `Using ${coverDays}d total cover from vendor policy${bypassed}`,
            value: coverDays,
        });
    } else {
        const adjustedBuffer = Math.round(buffer * safetyMultiplier);
        coverDays = leadTimeUsed + adjustedBuffer;
        if (safetyMultiplier !== 1 && (input.calibrationSampleCount ?? 0) >= 5) {
            const dir = safetyMultiplier > 1 ? "widened" : "tightened";
            trace.push({
                step: "cover_days",
                detail: `Lead ${leadTimeUsed}d + safety ${buffer}d × ${safetyMultiplier.toFixed(2)} ${dir} ` +
                    `(median error ${input.calibrationMedianErrorPct?.toFixed(0)}% over ` +
                    `${input.calibrationSampleCount} samples) = ${coverDays}d cover`,
                value: coverDays,
            });
        } else {
            trace.push({
                step: "cover_days",
                detail: `Lead ${leadTimeUsed}d + ${adjustedBuffer}d safety = ${coverDays}d cover`,
                value: coverDays,
            });
        }
    }

    // ── Step 6: needed eaches (subtract supply NET of reservations) ──────
    // v2.5 (2026-06-09): BOM-driven signal takes precedence when set.
    // Bill's KMS101 case: smoothed `dailyRate × coverDays` under-shoots
    // the actual 30d BOM-driven need for components that are consumed
    // by FG rebuilds (not sold retail). When `bomDrivenNeed` is set,
    // we use the FG-traceback total as the primary signal. The dailyRate
    // path is preserved for BOW&SALE / direct-sale components.
    //
    // v2.8 (2026-07-10): residual reorder cap when open PO already exists.
    // Full target cover (e.g. Colorful 90d) sizes a clean-slate buy.
    // When open PO qty is already in flight, only top up to the order-point
    // window (lead + 30d). Prevents RAWWORM-style "open 42k, still need 84k"
    // double-cover recommendations.
    const ORDER_POINT_BUFFER_DAYS = 30;
    const targetUnits = dailyRate * coverDays;
    const supplyForOrder = effectiveStock + stockOnOrder - reservedQty;
    const bomNeed = input.bomDrivenNeed != null && input.bomDrivenNeed > 0
        ? input.bomDrivenNeed
        : null;
    const baseNeed = bomNeed != null
        ? Math.max(bomNeed, targetUnits)  // BOM-driven OR the smoothed need, whichever is higher
        : targetUnits;
    let rawNeededEaches = Math.max(0, baseNeed - supplyForOrder);
    const orderPointDays = leadTimeUsed + ORDER_POINT_BUFFER_DAYS;
    const orderPointUnits = dailyRate * orderPointDays;
    const residualAtOrderPoint = Math.max(0, orderPointUnits - supplyForOrder);
    // Residual reorder only when an open PO exists AND vendor policy asks for
    // more cover than the order point (lead+30). Clean-slate buys still use full cover.
    const aggressiveCover = targetCoverDays != null && targetCoverDays > orderPointDays;
    const isResidualTopUp = stockOnOrder > 0 && rawNeededEaches > 0 && aggressiveCover;

    if (bomNeed != null) {
        trace.push({
            step: "raw_qty",
            detail: `BOM-driven need: ${Math.round(bomNeed)} (30d FG-traceback) ` +
                `vs smoothed ${Math.round(targetUnits)} (${dailyRate.toFixed(2)}/d × ${coverDays}d) — using max of both, ` +
                `− ${Math.round(effectiveStock)} on hand − ${Math.round(stockOnOrder)} on order` +
                (reservedQty > 0 ? ` − ${Math.round(reservedQty)} reserved` : "") +
                ` = ${Math.round(rawNeededEaches)} needed`,
            value: Math.round(rawNeededEaches),
        });
    } else {
        trace.push({
            step: "raw_qty",
            detail: `${dailyRate.toFixed(2)}/d × ${coverDays}d = ${Math.round(targetUnits)} target ` +
                `− ${Math.round(effectiveStock)} on hand − ${Math.round(stockOnOrder)} on order` +
                (reservedQty > 0 ? ` − ${Math.round(reservedQty)} reserved` : "") +
                ` = ${Math.round(rawNeededEaches)} needed`,
            value: Math.round(rawNeededEaches),
        });
    }

    if (isResidualTopUp && residualAtOrderPoint < rawNeededEaches) {
        const before = rawNeededEaches;
        rawNeededEaches = residualAtOrderPoint;
        trace.push({
            step: "residual_reorder_cap",
            detail:
                `Open PO shortfall: capped ${Math.round(before)} → ${Math.round(rawNeededEaches)} ` +
                `(order-point ${orderPointDays}d = lead ${leadTimeUsed}d + ${ORDER_POINT_BUFFER_DAYS}d ` +
                `needs ${Math.round(orderPointUnits)}; supply ${Math.round(supplyForOrder)} ` +
                `= on hand ${Math.round(effectiveStock)} + on order ${Math.round(stockOnOrder)}` +
                (reservedQty > 0 ? ` − reserved ${Math.round(reservedQty)}` : "") +
                `). Full cover ${coverDays}d is for clean-slate buys only.`,
            value: Math.round(rawNeededEaches),
        });
    } else if (isResidualTopUp) {
        trace.push({
            step: "residual_reorder_cap",
            detail:
                `Open PO shortfall: ${Math.round(rawNeededEaches)} already within order-point gap ` +
                `(${orderPointDays}d needs ${Math.round(orderPointUnits)}; supply ${Math.round(supplyForOrder)}).`,
            value: Math.round(rawNeededEaches),
        });
    }

    // ── Step 7: pack rounding & 30-day supply minimum floor ───────────────
    const { increment: orderIncrementQty, source: orderIncrementSource } = effectiveOrderIncrement(input);
    let suggestedQty = 0;
    const min30DaySupply = dailyRate > 0 ? Math.ceil(dailyRate * 30) : 0;
    // v2.7 — cap the 30-day supply floor at 2× raw need to prevent massive
    // overbuys on slow-moving SKUs where you already have plenty of runway.
    // RMC102 case: raw need 18, 30d floor 59 (3.3× overbuy, $1,609 excess).
    // With cap: floor becomes min(59, 18*2)=36, cognitive-snaps to 40.
    const cappedMin30 = rawNeededEaches > 0
        ? Math.min(min30DaySupply, Math.ceil(rawNeededEaches * 2))
        : min30DaySupply;
    if (rawNeededEaches > 0) {
        let snapped = snapToIncrement(rawNeededEaches, orderIncrementQty);
        let snappedQty = Math.ceil(snapped);
        const fallbackVendor = input.vendorName ?? "vendor";

        if (snappedQty < cappedMin30) {
            snapped = snapToIncrement(cappedMin30, orderIncrementQty);
            snappedQty = Math.ceil(snapped);
            const wasUncapped = min30DaySupply !== cappedMin30;
            trace.push({
                step: "pack_round",
                detail: wasUncapped
                    ? `Bumped to 2×-capped supply floor of ${cappedMin30} (raw 30d supply was ${min30DaySupply}, capped to avoid overbuy) and rounded to nearest ${orderIncrementQty || 1}-pack → ${snappedQty}`
                    : `Bumped to meet 30-day supply minimum of ${min30DaySupply} and rounded to nearest ${orderIncrementQty || 1}-pack → ${snappedQty}`,
                value: snappedQty,
            });
        } else {
            trace.push({
                step: "pack_round",
                detail: orderIncrementSource === "finale"
                    ? `Rounded up to nearest ${orderIncrementQty}-pack → ${snappedQty}`
                    : orderIncrementSource === "vendor_fallback"
                        ? `No Finale pack increment registered; ${fallbackVendor} fallback rounds to ${orderIncrementQty}s → ${snappedQty}`
                        : `No pack increment registered → rounded up to ${snappedQty}`,
                value: snappedQty,
            });
        }
        suggestedQty = snappedQty;
    } else {
        trace.push({
            step: "pack_round",
            detail: "Stock + on-order already covers target window — no order needed",
            value: 0,
        });
    }

    // ── Step 7.5: cognitive/historical/explicit rounding ──────────────────
    // v2.2 — never present an odd number on a draft PO. Snap to a clean number
    // using the historical pattern when available, the explicit override when
    // set, or the magnitude-aware cognitive ladder otherwise.
    let roundingMethod: "cognitive" | "historical" | "vendor_explicit" | null = null;
    let roundingAlternatives: number[] = [];
    if (suggestedQty > 0) {
        const round = roundToCleanQty({
            rawQty: suggestedQty,
            packIncrement: orderIncrementQty,
            historicalQtys: input.historicalLineQtys,
            explicitFavorites: input.favoriteBatches ?? null,
        });
        if (round.method !== "noop" && round.snappedQty !== suggestedQty) {
            const stepName = round.method === "historical" ? "historical_round"
                : round.method === "vendor_explicit" ? "vendor_round"
                : "cognitive_round";
            trace.push({
                step: stepName,
                detail: round.detail,
                value: round.snappedQty,
            });
            suggestedQty = round.snappedQty;
        }
        roundingMethod = round.method === "noop" ? null : round.method;
        roundingAlternatives = round.alternatives;
    }

    // ── Step 7.6 (v2.5, 2026-06-09): historical cap ─────────────────────
    // Bill: "look at past orders and gain amounts from last 3-4 orders".
    // Soft cap on `suggestedQty` based on historical PO batch sizes — the
    // median of `historicalLineQtys × capMultiple` (default 2×). Prevents
    // runaway recommendations for low-volume SKUs where 1× coverDays gives
    // a wildly larger qty than we've ever actually ordered. The cap only
    // applies when we have ≥3 historical line qtys (sparse history is
    // unreliable; trust the formula). Pass `historicalCapMultiple: null`
    // to disable.
    if (
        suggestedQty > 0 &&
        input.historicalCapMultiple !== null &&
        (input.historicalLineQtys ?? []).length >= 3
    ) {
        const cap = (input.historicalCapMultiple ?? 2) *
            median(input.historicalLineQtys!);
        if (suggestedQty > cap) {
            trace.push({
                step: "historical_cap",
                detail: `Capped at ${input.historicalCapMultiple ?? 2}× median of last ${input.historicalLineQtys!.length} PO qtys (median ${Math.round(median(input.historicalLineQtys!))}) → ${Math.round(cap)}`,
                value: Math.round(cap),
            });
            suggestedQty = Math.round(cap);
        }
    }

    // ── Step 8: vendor MOQ — tri-state mode ───────────────────────────────
    // v2.1 — moqMode: 'enforce' (default — bump qty), 'warn' (sets moqWarning,
    // no bump), 'ignore' (no bump, no warn). Mode comes from vendor_reorder_policies.
    const moqMode = input.moqMode ?? "enforce";
    let moqApplied = false;
    let moqWarning = false;
    if (suggestedQty > 0) {
        const minEaches = input.minimumOrderEaches ?? null;
        const minDollars = input.minimumOrderDollars ?? null;
        const unitPrice = input.unitPrice && input.unitPrice > 0 ? input.unitPrice : 0;

        const wouldTriggerEaches = minEaches != null && minEaches > 0 && suggestedQty < minEaches;
        const orderValue = suggestedQty * unitPrice;
        const wouldTriggerDollars = !wouldTriggerEaches
            && minDollars != null && minDollars > 0 && unitPrice > 0 && orderValue < minDollars;

        if (wouldTriggerEaches || wouldTriggerDollars) {
            if (moqMode === "ignore") {
                // Silent — keep the qty as-is, no provenance step.
                // (We could log it, but the whole point of 'ignore' is the user knows MOQ is bogus.)
            } else if (moqMode === "warn") {
                moqWarning = true;
                if (wouldTriggerEaches) {
                    trace.push({
                        step: "moq",
                        detail: `MOQ ${minEaches} eaches not met by ${suggestedQty} (warn-only — no bump per vendor policy)`,
                        value: suggestedQty,
                    });
                } else {
                    trace.push({
                        step: "moq",
                        detail: `MOQ $${minDollars} not met by ${suggestedQty} × $${unitPrice.toFixed(2)} = $${orderValue.toFixed(0)} (warn-only — no bump per vendor policy)`,
                        value: suggestedQty,
                    });
                }
            } else {
                // enforce — existing behavior
                if (wouldTriggerEaches) {
                    const bumped = orderIncrementQty && orderIncrementQty > 1
                        ? Math.ceil(snapToIncrement(minEaches!, orderIncrementQty))
                        : minEaches!;
                    trace.push({
                        step: "moq",
                        detail: `Bumped from ${suggestedQty} to ${bumped} to meet vendor MOQ of ${minEaches} eaches`,
                        value: bumped,
                    });
                    suggestedQty = bumped;
                    moqApplied = true;
                } else if (wouldTriggerDollars) {
                    const minQtyForDollars = Math.ceil(minDollars! / unitPrice);
                    const bumped = orderIncrementQty && orderIncrementQty > 1
                        ? Math.ceil(snapToIncrement(minQtyForDollars, orderIncrementQty))
                        : minQtyForDollars;
                    trace.push({
                        step: "moq",
                        detail: `Bumped from ${suggestedQty} ($${orderValue.toFixed(0)}) to ${bumped} ($${(bumped * unitPrice).toFixed(0)}) to meet vendor MOQ of $${minDollars}`,
                        value: bumped,
                    });
                    suggestedQty = bumped;
                    moqApplied = true;
                }
            }
        }
    }

    // ── Step 8.5: overbuy review flags ────────────────────────────────────
    // v2.1 — when pack rounding or MOQ enforcement creates a large overbuy
    // (>=overbuyReviewPct% above raw need OR >=overbuyReviewDollars), flag
    // the row for Will to review on the dashboard.
    const reviewReasons: string[] = [];
    if (rawNeededEaches > 0 && suggestedQty > rawNeededEaches) {
        const overbuyQty = suggestedQty - rawNeededEaches;
        const overbuyPct = (overbuyQty / rawNeededEaches) * 100;
        const unitPrice = input.unitPrice && input.unitPrice > 0 ? input.unitPrice : 0;
        const overbuyDollars = unitPrice > 0 ? overbuyQty * unitPrice : 0;
        const pctThreshold = input.overbuyReviewPct ?? 50;
        const dollarsThreshold = input.overbuyReviewDollars ?? 1000;
        if (overbuyPct >= pctThreshold || overbuyDollars >= dollarsThreshold) {
            const reason = `MOQ overbuy: +${Math.round(overbuyQty)} extra units` +
                (overbuyDollars > 0 ? ` (+$${overbuyDollars.toFixed(0)})` : "");
            reviewReasons.push(reason);
            trace.push({
                step: "review",
                detail: reason,
                value: Math.round(overbuyQty),
            });
        }
    }
    // ── Step 8.7: historical purchase floor (v2.6) ─────────────────────────
    // Bill: "look at past orders — if we always order 20 from Faust,
    // the system should know that." Previously this was advisory-only
    // (set reviewRequired flag). Now: when a vendor has a consistent
    // order pattern (3+ POs, same qty or within 20%), use the mode as
    // a HARD ordering floor. A PO for 5 units never goes to a vendor
    // that always ships 20.
    let historicalFloorApplied = false;

    // v2.6a: explicit standard_order_qty override (takes priority)
    const standardOrderQty = input.standardOrderQty ?? null;
    if (standardOrderQty && standardOrderQty > 0 && suggestedQty > 0 && suggestedQty < standardOrderQty) {
        const beforeQty = suggestedQty;
        suggestedQty = standardOrderQty;
        historicalFloorApplied = true;
        trace.push({
            step: "standard_order_floor",
            detail: `Bumped from ${beforeQty} to ${standardOrderQty} — vendor standard order qty (explicit policy)`,
            value: standardOrderQty,
        });
    }

    // v2.6b: auto-detect consistent SKU purchase pattern
    if (!historicalFloorApplied && suggestedQty > 0) {
        const history = (input.skuPurchaseHistory ?? []).filter(q => q > 0);
        if (history.length >= 3) {
            // Find mode — most common qty in recent purchases
            const freq = new Map<number, number>();
            for (const q of history) freq.set(q, (freq.get(q) || 0) + 1);
            const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]);
            const [modeQty, modeCount] = sorted[0];
            // Consistent = mode appears in 60%+ of purchases
            const consistencyPct = (modeCount / history.length) * 100;
            if (consistencyPct >= 60 && suggestedQty < modeQty) {
                const beforeQty = suggestedQty;
                suggestedQty = modeQty;
                historicalFloorApplied = true;
                trace.push({
                    step: "historical_floor",
                    detail: `Bumped from ${beforeQty} to ${modeQty} — vendor consistently orders ${modeQty} (${consistencyPct.toFixed(0)}% of ${history.length} past POs)`,
                    value: modeQty,
                });
            }
        }
    }

    // v2.6c: lastPurchaseQty single-point floor (fallback when no multi-PO history)
    if (!historicalFloorApplied && suggestedQty > 0) {
        const lastQty = input.lastPurchaseQty ?? null;
        const history = input.skuPurchaseHistory ?? [];
        if (lastQty && lastQty > 0 && suggestedQty < lastQty && history.length === 0) {
            // Only apply single-point floor if we don't have multi-point history
            // (avoids double-enforcing when both lastPurchaseQty and history exist)
            const deviationPct = Math.round(((lastQty - suggestedQty) / lastQty) * 100);
            if (deviationPct >= 50) {
                const beforeQty = suggestedQty;
                suggestedQty = lastQty;
                historicalFloorApplied = true;
                trace.push({
                    step: "last_purchase_floor",
                    detail: `Bumped from ${beforeQty} to ${lastQty} — last order was ${lastQty} units (${deviationPct}% below)`,
                    value: lastQty,
                });
            }
        }
    }

    // Still log the deviation as a dashboard review reason
    const lastPurchaseQty = input.lastPurchaseQty ?? null;
    if (suggestedQty > 0 && lastPurchaseQty !== null && lastPurchaseQty > 0) {
        const deviationPct = Math.round(((suggestedQty - lastPurchaseQty) / lastPurchaseQty) * 100);
        if (Math.abs(deviationPct) >= 50) {
            const reason = `Last order was ${lastPurchaseQty} units — this order is ${deviationPct > 0 ? '+' : ''}${deviationPct}% different`;
            reviewReasons.push(reason);
            trace.push({
                step: "historical_deviation",
                detail: reason,
                value: deviationPct,
            });
        }
    }

    const reviewRequired = reviewReasons.length > 0;

    // ── Step 9: urgency ───────────────────────────────────────────────────
    const urgency = urgencyFor(adjustedRunwayDays, leadTimeUsed);
    trace.push({
        step: "urgency",
        detail: `Adjusted runway ${Math.round(adjustedRunwayDays)}d vs lead ${leadTimeUsed}d → ${urgency}`,
        value: urgency,
    });

    // ── Backwards-compatible explanation string for legacy UI surfaces ────
    const explanationParts: string[] = [
        input.velocityInflated
            ? `Avg ${dailyRate.toFixed(1)}/day (${input.dailyRateLabel}, capped — Finale reported ${input.velocityRawRate?.toFixed(1)}/d)`
            : `Avg ${dailyRate.toFixed(1)}/day (${input.dailyRateLabel})`,
        `${Math.round(effectiveStock)} in stock → ${Math.round(runwayDays)}d`,
        `Lead ${input.leadTimeDays}d`,
    ];
    if (stockOnOrder > 0) {
        explanationParts.push(
            `${input.openPOCount} open PO (+${Math.round(stockOnOrder)}) → ${Math.round(adjustedRunwayDays)}d adjusted`
        );
    }
    const explanation = explanationParts.join(" · ") + ` — ${urgencyNote(urgency)}.`;

    return {
        sku: input.sku,
        dailyRate,
        runwayDays,
        adjustedRunwayDays,
        coverDays,
        rawNeededEaches,
        suggestedQty,
        urgency,
        explanation,
        provenance: trace,
        formulaVersion: QTY_FORMULA_VERSION,
        leadTimeUsed,
        leadTimeBasis,
        safetyMultiplier,
        reservedQty,
        moqApplied,
        moqWarning,
        reviewRequired,
        reviewReasons,
        roundingMethod,
        roundingAlternatives,
        historicalFloorApplied,
    };
}
