/**
 * @file    src/lib/purchasing/freight-sizing.ts
 * @purpose Pure FTL-aware order sizing: snap bulk raw-input needs to whole
 *          trucks (21 totes x 2,000 lb = 42,000 lb) and only then validate
 *          against days of supply. Replaces the naive 45-day coverage floor
 *          that previously forced extra pounds into an already-full truck.
 *          Post-receipt cover (R2) and policy overrides (R2b) are applied
 *          as gates on top of the whole-truck snap.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    src/config/freight-units.ts (freightUnitFor)
 * @env     none
 */

import { freightUnitFor } from "../../config/freight-units";

/** Maximum days of supply any single order may cover (validation gate). */
export const MAX_FREIGHT_COVER_DAYS = 90;

/** Truck multiples must exceed before a second truck is justified. */
export const SECOND_TRUCK_THRESHOLD = 1.5;

/** Result modes: whole-truck orders, a justified partial, or unconstrained. */
export type FreightSizingMode =
    | "full_truck"
    | "multi_truck"
    | "partial"
    | "not_freight_constrained";

/** Inputs to sizeToFreight — raw need plus the context used to validate it. */
export interface FreightSizingInput {
    sku: string;
    rawNeedQty: number;
    dailyRate: number;
    leadTimeDays: number;
    stockOnHand?: number;
    stockOnOrder?: number;
    targetCoverDaysOverride?: number | null;
}

/** Result of sizing: a whole-truck quantity (or a justified partial). */
export interface FreightSizingResult {
    qty: number;
    mode: FreightSizingMode;
    truckCount: number;
    daysOfSupply: number | null;
    reason: string;
}

/**
 * Size a bulk raw need to whole freight trucks.
 *
 * Truck count is 1 for any need up to a full truck; a second truck only
 * appears once the need clears SECOND_TRUCK_THRESHOLD trucks (avoid a
 * barely-over split order). The chosen whole-truck quantity is then
 * validated: the truck's own days of supply must stay within
 * MAX_FREIGHT_COVER_DAYS, and when stockOnHand/stockOnOrder are provided
 * the post-receipt cover must too — otherwise the order falls back to a
 * partial (rawNeedQty, floored at 1) with an operator-facing reason.
 * An explicit targetCoverDaysOverride keeps the truck but flags the
 * conflict in the reason.
 *
 * @param input SKU, raw need, burn rate and optional cover context.
 * @returns     Sized quantity, mode, truck count, days of supply and reason.
 */
export function sizeToFreight(input: FreightSizingInput): FreightSizingResult {
    const {
        sku,
        rawNeedQty,
        dailyRate,
        stockOnHand,
        stockOnOrder,
        targetCoverDaysOverride,
    } = input;
    const unit = freightUnitFor(sku);

    if (unit === null) {
        return {
            qty: rawNeedQty,
            mode: "not_freight_constrained",
            truckCount: 0,
            daysOfSupply: dailyRate > 0 ? rawNeedQty / dailyRate : null,
            reason: "not freight-constrained",
        };
    }

    const fullTruckQty = unit.fullTruckQty;

    // Truck count: one truck for anything up to a full truck; a second
    // truck only once the need clears 1.5 trucks.
    let truckCount = 1;
    let cappedAtOneTruck = false;
    if (rawNeedQty > fullTruckQty) {
        const truckMultiples = rawNeedQty / fullTruckQty;
        truckCount = Math.ceil(truckMultiples);
        if (truckCount === 2 && truckMultiples <= SECOND_TRUCK_THRESHOLD) {
            truckCount = 1;
            cappedAtOneTruck = true;
        }
    }

    const truckQty = truckCount * fullTruckQty;
    const truckDaysOfSupply = dailyRate > 0 ? truckQty / dailyRate : null;

    let qty = truckQty;
    let mode: FreightSizingMode = truckCount > 1 ? "multi_truck" : "full_truck";
    const caveats: string[] = [];

    if (cappedAtOneTruck) {
        caveats.push(
            `Need of ${Math.round(rawNeedQty)} lb is above one full truck but under ` +
                `${SECOND_TRUCK_THRESHOLD} trucks, capped at one full truck.`,
        );
    }

    // A whole truck must not cover more than MAX_FREIGHT_COVER_DAYS on its own.
    if (truckDaysOfSupply !== null && truckDaysOfSupply > MAX_FREIGHT_COVER_DAYS) {
        mode = "partial";
        qty = Math.max(1, rawNeedQty);
        caveats.push(
            `Full-truck qty (${Math.round(truckQty)} lb) would cover ~` +
                `${Math.round(truckDaysOfSupply)} days at ${dailyRate} lb/day, which ` +
                `exceeds max cover of ${MAX_FREIGHT_COVER_DAYS} days; ordering a partial instead.`,
        );
    }

    // R2 (post-receipt cap): stockOnHand + stockOnOrder + qty must not cover
    // more than MAX_FREIGHT_COVER_DAYS after the truck lands.
    if (stockOnHand !== undefined && stockOnOrder !== undefined) {
        const postReceiptDays =
            dailyRate > 0 ? (stockOnHand + stockOnOrder + qty) / dailyRate : null;
        if (postReceiptDays !== null && postReceiptDays > MAX_FREIGHT_COVER_DAYS) {
            mode = "partial";
            qty = Math.max(1, rawNeedQty);
            caveats.push(
                `A full truck would push post-receipt stock to ~` +
                    `${Math.round(postReceiptDays)} days of cover, past the ` +
                    `${MAX_FREIGHT_COVER_DAYS}-day cap; ordering a partial instead.`,
            );
        }
    }

    // R2b (policy override): keep the truck, but surface the conflict.
    if (
        mode !== "partial" &&
        targetCoverDaysOverride !== null &&
        targetCoverDaysOverride !== undefined &&
        targetCoverDaysOverride > 0 &&
        truckDaysOfSupply !== null &&
        truckDaysOfSupply > targetCoverDaysOverride
    ) {
        const truckDays = Math.round(truckDaysOfSupply * 10) / 10;
        caveats.push(
            `policy_override_conflict: truck ${truckDays}d > policy ${targetCoverDaysOverride}d`,
        );
    }

    const snapSentence =
        `Snapped to ${truckCount === 1 ? "a full truck" : `${truckCount} full trucks`} ` +
        `(${Math.round(qty)} lb) for freight efficiency.`;
    const reason =
        caveats.length === 0
            ? snapSentence
            : mode === "partial"
              ? caveats.join(" ")
              : `${snapSentence} ${caveats.join(" ")}`;

    return {
        qty,
        mode,
        truckCount,
        daysOfSupply: dailyRate > 0 ? qty / dailyRate : null,
        reason,
    };
}
