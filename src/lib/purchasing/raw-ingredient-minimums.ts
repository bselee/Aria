/**
 * @file    raw-ingredient-minimums.ts
 * @purpose Per-SKU MINIMUM order quantities for raw ingredients that ship in fixed
 *          lots. These are physical constraints (one truckload), not demand math, so
 *          they are recorded explicitly here rather than inferred.
 *
 *          WHY SKU-LEVEL AND NOT VENDOR-LEVEL:
 *          `vendor_reorder_policies.standard_order_qty` is the vendor-wide floor. It
 *          cannot express this rule: Seacoast Compost supplies SCO101/SCO102/SCO104
 *          alongside RAWSEACOASTCOMPOST, and Malibu supplies MC101/MC102/MC109
 *          alongside RAWMALIBUCOMPOST. A vendor-wide 42,000 floor would impose a
 *          ~42,000-unit minimum on those finished goods. The rule is therefore keyed
 *          by SKU.
 *
 *          SEMANTICS: this is a FLOOR, not an increment.
 *          A requirement below the minimum is raised TO the minimum; a requirement
 *          already above it is left alone. It is deliberately NOT snapped to a
 *          multiple of the minimum — PO history shows 42,000 as the normal lot
 *          (RAWWORMCASTINGS 4/4 orders at exactly 42,000, RAWSEACOASTCOMPOST 2/3 with
 *          one 38,000), i.e. a minimum, not a pack multiple. Forcing multiples would
 *          turn a 50,000 lb requirement into 84,000 lb.
 *
 * @author  Hermia
 * @created 2026-09-30
 * @deps    none
 * @env     none
 */

/**
 * SKU → minimum order quantity, in the SKU's stocking unit (lb for these raws).
 * Sourced from Bill (2026-09-30): "requires 42000lbs prior to creating PO".
 */
export const RAW_INGREDIENT_MIN_ORDER_QTY: Readonly<Record<string, number>> = Object.freeze({
    RAWWORMCASTINGS: 42_000,
    RAWSEACOASTCOMPOST: 42_000,
    RAWMALIBUCOMPOST: 42_000,
});

/** Human-readable label for the trace line. */
const UNIT_LABEL = "lb";

/**
 * Minimum order quantity for a SKU, or null when the SKU has no such constraint.
 *
 * @param sku Finale product id (case-insensitive).
 * @returns The minimum order quantity, or null if unconstrained.
 */
export function rawIngredientMinimumFor(sku: string | null | undefined): number | null {
    if (!sku) return null;
    const hit = RAW_INGREDIENT_MIN_ORDER_QTY[String(sku).trim().toUpperCase()];
    return typeof hit === "number" && hit > 0 ? hit : null;
}

/**
 * Descriptive text for why a quantity was raised, for the recommendation trace.
 *
 * @param minimum The applied minimum.
 * @returns A short explanation string.
 */
export function rawIngredientMinimumLabel(minimum: number): string {
    return `raw-ingredient minimum order of ${minimum.toLocaleString("en-US")} ${UNIT_LABEL}`;
}
