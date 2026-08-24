/**
 * @file    src/config/freight-units.ts
 * @purpose Encode the physical truck reality for bulk raw inputs (Bill,
 *          2026-08-24): a full truck is 21 pallets of totes at ~2,000 lb
 *          each = 42,000 lb. Sizing logic snaps bulk orders to whole trucks
 *          instead of naive coverage floors, so freight efficiency comes
 *          first and days-of-supply is only a validation gate.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    none
 * @env     none
 */

/** Pallets of totes that fit on one full truck. */
export const PALLETS_PER_TRUCK = 21;

/** Physical freight profile for one bulk-input SKU. */
export interface FreightUnit {
    /** Weight of one pallet/tote in pounds. */
    unitWeightLbs: number;
    /** Pallets of totes per full truck. */
    palletsPerTruck: number;
    /** Full-truck quantity in pounds (palletsPerTruck x unitWeightLbs). */
    fullTruckQty: number;
    /** Operator-facing label describing the truck load. */
    label: string;
}

/**
 * Freight profiles keyed by normalized (uppercase) SKU. RAWRICEBRAN and
 * RAWSEACOASTCOMPOST both ship 21 totes x 2,000 lb on a full truck.
 */
export const FREIGHT_UNITS: Record<string, FreightUnit> = {
    RAWRICEBRAN: {
        unitWeightLbs: 2000,
        palletsPerTruck: 21,
        fullTruckQty: 42000,
        label: "21 totes x 2,000 lb",
    },
    RAWSEACOASTCOMPOST: {
        unitWeightLbs: 2000,
        palletsPerTruck: 21,
        fullTruckQty: 42000,
        label: "21 totes x 2,000 lb",
    },
};

/**
 * Look up the freight unit for a SKU. Trims and uppercases the input so
 * callers can pass raw DB or crawler spellings.
 *
 * @param sku SKU to look up.
 * @returns   The freight unit, or null when the SKU has no freight profile.
 */
export function freightUnitFor(sku: string): FreightUnit | null {
    const normalized = sku.trim().toUpperCase();
    return FREIGHT_UNITS[normalized] ?? null;
}
