/**
 * @file    raw-ingredient-minimums.ts
 * @purpose Per-SKU order BOUNDS for raw ingredients that ship in fixed lots. These are
 *          physical/operational constraints, not demand math, so they are recorded
 *          explicitly here rather than inferred.
 *
 *          WHY SKU-LEVEL AND NOT VENDOR-LEVEL:
 *          `vendor_reorder_policies.standard_order_qty` is the vendor-wide floor. It
 *          cannot express these rules: Seacoast Compost supplies SCO101/SCO102/SCO104
 *          alongside RAWSEACOASTCOMPOST, and Malibu supplies MC101/MC102/MC109
 *          alongside RAWMALIBUCOMPOST. A vendor-wide bound would impose truckload
 *          quantities on those finished goods. The rules are therefore keyed by SKU.
 *
 *          MINIMUM SEMANTICS — a FLOOR, not an increment.
 *          A requirement below the minimum is raised TO the minimum; a requirement
 *          already above it is left alone. It is deliberately NOT snapped to a multiple
 *          of the minimum. PO history: RAWWORMCASTINGS 4/4 orders at exactly 42,000,
 *          RAWSEACOASTCOMPOST 42,000 / 38,000 / 42,000. Bill (2026-09-30): "Order size
 *          will vary. We can order 42000 but vendors may ship less." So 42,000 is what
 *          we ORDER, not a guaranteed receipt — never assume a full load arrives.
 *
 *          MAXIMUM SEMANTICS — a conservative ceiling.
 *          Bill (2026-09-30): "We want to err on the conservative side while providing
 *          coverage for builds in the window. We rarely need more than 1-1.5 loads per
 *          month." A build-requirement-derived rate can imply multi-month orders far
 *          beyond anything ever bought — it produced a 126,000 lb suggestion for worm
 *          castings, i.e. 3 loads, which Bill called "a ridiculous amount". The ceiling
 *          keeps coverage for the window without letting the formula order more than
 *          ~1.5 loads at a time.
 *
 * @author  Hermia
 * @created 2026-09-30
 * @deps    none
 * @env     none
 */

/** One truckload, in the SKU's stocking unit (lb for these raws). */
export const RAW_LOAD_QTY = 42_000;

/** Most we will order in one recommendation: 1.5 loads. */
const MAX_LOADS_PER_ORDER = 1.5;

export interface RawIngredientOrderBounds {
    /** Never create a PO below this. */
    minOrderQty: number;
    /** Never recommend more than this in a single order. */
    maxOrderQty: number;
}

const BOUNDS: Readonly<Record<string, RawIngredientOrderBounds>> = Object.freeze({
    RAWWORMCASTINGS: { minOrderQty: RAW_LOAD_QTY, maxOrderQty: RAW_LOAD_QTY * MAX_LOADS_PER_ORDER },
    RAWSEACOASTCOMPOST: { minOrderQty: RAW_LOAD_QTY, maxOrderQty: RAW_LOAD_QTY * MAX_LOADS_PER_ORDER },
    RAWMALIBUCOMPOST: { minOrderQty: RAW_LOAD_QTY, maxOrderQty: RAW_LOAD_QTY * MAX_LOADS_PER_ORDER },
});

const UNIT_LABEL = "lb";

/**
 * Order bounds for a SKU, or null when the SKU has no such constraint.
 *
 * @param sku Finale product id (case-insensitive).
 * @returns Bounds, or null if unconstrained.
 */
export function rawIngredientBoundsFor(sku: string | null | undefined): RawIngredientOrderBounds | null {
    if (!sku) return null;
    const hit = BOUNDS[String(sku).trim().toUpperCase()];
    return hit ?? null;
}

/**
 * Minimum order quantity for a SKU, or null when unconstrained.
 *
 * @param sku Finale product id (case-insensitive).
 * @returns The minimum order quantity, or null.
 */
export function rawIngredientMinimumFor(sku: string | null | undefined): number | null {
    const b = rawIngredientBoundsFor(sku);
    return b ? b.minOrderQty : null;
}

/**
 * Maximum order quantity for a SKU, or null when unconstrained.
 *
 * @param sku Finale product id (case-insensitive).
 * @returns The maximum order quantity, or null.
 */
export function rawIngredientMaximumFor(sku: string | null | undefined): number | null {
    const b = rawIngredientBoundsFor(sku);
    return b ? b.maxOrderQty : null;
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

/**
 * Descriptive text for why a quantity was capped, for the recommendation trace.
 *
 * @param maximum The applied maximum.
 * @returns A short explanation string.
 */
export function rawIngredientMaximumLabel(maximum: number): string {
    return `raw-ingredient ceiling of ${maximum.toLocaleString("en-US")} ${UNIT_LABEL} `
        + `(1.5 loads per order)`;
}
