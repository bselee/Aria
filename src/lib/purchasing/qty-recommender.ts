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

export const QTY_FORMULA_VERSION = "v1.0-extracted-2026-05-05";

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
    coverBufferDays?: number;           // default 60 — extra cover above lead time
    orderIncrementQty?: number | null;  // pack rounding (Finale "Std reorder in qty of")
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

    // ── Step 2: stock + on-order ──────────────────────────────────────────
    const effectiveStock = Math.max(0, input.stockOnHand);
    const stockOnOrder = Math.max(0, input.stockOnOrder);
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

    // ── Step 3: runway ────────────────────────────────────────────────────
    const runwayDays = dailyRate > 0 ? effectiveStock / dailyRate : Number.POSITIVE_INFINITY;
    const adjustedRunwayDays = dailyRate > 0
        ? (effectiveStock + stockOnOrder) / dailyRate
        : Number.POSITIVE_INFINITY;
    trace.push({
        step: "runway",
        detail: `${Math.round(effectiveStock)} ÷ ${dailyRate.toFixed(2)}/d = ${Math.round(runwayDays)}d raw, ` +
            `${Math.round(adjustedRunwayDays)}d after on-order`,
        value: Math.round(runwayDays),
    });

    // ── Step 4: cover window ──────────────────────────────────────────────
    const buffer = input.coverBufferDays ?? 60;
    const coverDays = input.leadTimeDays + buffer;
    trace.push({
        step: "cover_days",
        detail: `Lead ${input.leadTimeDays}d (${input.leadTimeProvenance}) + ${buffer}d safety = ${coverDays}d cover`,
        value: coverDays,
    });

    // ── Step 5: needed eaches ─────────────────────────────────────────────
    const targetUnits = dailyRate * coverDays;
    const rawNeededEaches = Math.max(0, targetUnits - effectiveStock - stockOnOrder);
    trace.push({
        step: "raw_qty",
        detail: `${dailyRate.toFixed(2)}/d × ${coverDays}d = ${Math.round(targetUnits)} target ` +
            `− ${Math.round(effectiveStock)} on hand − ${Math.round(stockOnOrder)} on order = ` +
            `${Math.round(rawNeededEaches)} needed`,
        value: Math.round(rawNeededEaches),
    });

    // ── Step 6: pack rounding ─────────────────────────────────────────────
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

    // ── Step 7: urgency ───────────────────────────────────────────────────
    const urgency = urgencyFor(adjustedRunwayDays, input.leadTimeDays);
    trace.push({
        step: "urgency",
        detail: `Adjusted runway ${Math.round(adjustedRunwayDays)}d vs lead ${input.leadTimeDays}d → ${urgency}`,
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
    };
}
