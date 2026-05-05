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

export const QTY_FORMULA_VERSION = "v2.0-calibrated-2026-05-05";

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

    // ── Step 4: lead time basis (P90 if available, else point estimate) ───
    const leadTimeP90 = input.leadTimeP90 ?? null;
    const leadTimeUsed = (leadTimeP90 != null && leadTimeP90 > 0)
        ? leadTimeP90
        : input.leadTimeDays;
    const leadTimeBasis: "p90" | "median" | "point" = (leadTimeP90 != null && leadTimeP90 > 0)
        ? "p90"
        : input.leadTimeProvenance === "vendor_median" ? "median" : "point";
    if (leadTimeBasis === "p90") {
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

    // ── Step 5: cover window with calibration multiplier ──────────────────
    const buffer = input.coverBufferDays ?? 60;
    const safetyMultiplier = Math.max(0.5, Math.min(2.5, input.safetyMultiplier ?? 1));
    const adjustedBuffer = Math.round(buffer * safetyMultiplier);
    const coverDays = leadTimeUsed + adjustedBuffer;
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

    // ── Step 8: vendor MOQ enforcement ────────────────────────────────────
    let moqApplied = false;
    if (suggestedQty > 0) {
        const minEaches = input.minimumOrderEaches ?? null;
        const minDollars = input.minimumOrderDollars ?? null;
        const unitPrice = input.unitPrice && input.unitPrice > 0 ? input.unitPrice : 0;

        if (minEaches && minEaches > 0 && suggestedQty < minEaches) {
            const bumped = orderIncrementQty && orderIncrementQty > 1
                ? Math.ceil(snapToIncrement(minEaches, orderIncrementQty))
                : minEaches;
            trace.push({
                step: "moq",
                detail: `Bumped from ${suggestedQty} to ${bumped} to meet vendor MOQ of ${minEaches} eaches`,
                value: bumped,
            });
            suggestedQty = bumped;
            moqApplied = true;
        } else if (minDollars && minDollars > 0 && unitPrice > 0) {
            const orderValue = suggestedQty * unitPrice;
            if (orderValue < minDollars) {
                const minQtyForDollars = Math.ceil(minDollars / unitPrice);
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
    };
}
