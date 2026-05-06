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
export const QTY_FORMULA_VERSION = "v2.2-cognitive-round-2026-05-06";

/** Round a quantity up to the nearest multiple of `incrementQty`, with a floor of `incrementQty`. */
export function snapToIncrement(quantity: number, incrementQty: number | null | undefined): number {
    if (!incrementQty || incrementQty <= 1) return quantity;
    return Math.max(incrementQty, Math.ceil(quantity / incrementQty) * incrementQty);
}

export type Urgency = "critical" | "warning" | "watch" | "ok";

export interface RecommenderInput {
    sku: string;
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
    /**
     * v2.2 — explicit per-vendor favorite batches from
     * vendor_reorder_policies.favorite_batches. When set (non-empty), overrides
     * historical learning.
     */
    favoriteBatches?: number[] | null;
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
    const buffer = input.coverBufferDays ?? 60;
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
    const targetUnits = dailyRate * coverDays;
    const supplyForOrder = effectiveStock + stockOnOrder - reservedQty;
    const rawNeededEaches = Math.max(0, targetUnits - supplyForOrder);
    trace.push({
        step: "raw_qty",
        detail: `${dailyRate.toFixed(2)}/d × ${coverDays}d = ${Math.round(targetUnits)} target ` +
            `− ${Math.round(effectiveStock)} on hand − ${Math.round(stockOnOrder)} on order` +
            (reservedQty > 0 ? ` − ${Math.round(reservedQty)} reserved` : "") +
            ` = ${Math.round(rawNeededEaches)} needed`,
        value: Math.round(rawNeededEaches),
    });

    // ── Step 7: pack rounding ─────────────────────────────────────────────
    const orderIncrementQty = input.orderIncrementQty ?? null;
    let suggestedQty = 0;
    if (rawNeededEaches > 0) {
        const snapped = snapToIncrement(rawNeededEaches, orderIncrementQty);
        suggestedQty = Math.ceil(snapped);
        trace.push({
            step: "pack_round",
            detail: orderIncrementQty && orderIncrementQty > 1
                ? `Rounded up to nearest ${orderIncrementQty}-pack → ${suggestedQty}`
                : `No pack increment registered → rounded up to ${suggestedQty}`,
            value: suggestedQty,
        });
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
            const reason = `Large overbuy from ordering constraints: +${Math.round(overbuyQty)} eaches (${Math.round(overbuyPct)}%)` +
                (overbuyDollars > 0 ? `, approx $${overbuyDollars.toFixed(0)}` : "");
            reviewReasons.push(reason);
            trace.push({
                step: "review",
                detail: reason,
                value: Math.round(overbuyQty),
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
    };
}
