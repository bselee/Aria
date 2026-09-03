/**
 * @file    src/lib/purchasing/oag-powder-policy.ts
 * @purpose Organics Alive / ASLE powder MTO + CYC FPF policy constants.
 *          Martin (2026-07-28): powders are make-to-order, not stocked in
 *          Edmonton, 100–120 day order-to-delivery, pay upfront. Lot sizes
 *          locked to Finale PO 124788 (V-N/V-PK 5520, V-TR/V-K 2760).
 *          FPF finished (OAG218/219) is CYC co-pack fill — never order RAW
 *          OAG228. FPF-only POs must not vendor-cycle-lock powder RAW buys.
 * @author  Hermia
 * @created 2026-07-29
 * @deps    none (pure data + helpers)
 */

import { resolveVendorLeadOverride, resolveVendorLeadFloor } from "./vendor-lead-overrides";

/** Martin / Finale 124788 powder MTO lead (calendar days). */
export const OAG_POWDER_LEAD_DAYS = 120;

/** Post-receipt cover target (Quinton-style lead + 90). */
export const OAG_POWDER_POST_COVER_DAYS = 90;

/** RAW powder SKUs (BAS MFG packs 1/5/25lb from these). */
export const OAG_POWDER_RAW_SKUS = [
    "OAG222", // V-N 10-2-2
    "OAG223", // V-TR 4-5-5
    "OAG224", // V-PK 0-10-8
    "OAG225", // V-K 0-2-10
] as const;

export type OagPowderRawSku = (typeof OAG_POWDER_RAW_SKUS)[number];

/** Standard order lots from PO 124788 — only these sizes. */
export const OAG_POWDER_LOT_QTY: Record<OagPowderRawSku, number> = {
    OAG222: 5520,
    OAG223: 2760,
    OAG224: 5520,
    OAG225: 2760,
};

/** Favorite batch ladder for cognitive rounding on OA powder vendor. */
export const OAG_POWDER_FAVORITE_BATCHES = [2760, 5520] as const;

/**
 * CYC-filled finished FPF — buy as finished from OA, not BAS-packed from drum.
 * POs containing only these SKUs must not lock the powder RAW order cycle.
 */
export const OAG_FPF_CYC_FINISHED_SKUS = ["OAG218", "OAG219"] as const;

/** RAW FPF 50gal — never order (ROM DNR; CYC fills finished instead). */
export const OAG_FPF_RAW_DNR_SKU = "OAG228";

/** Finale party id for Organics Alive (trailing-space name variant uses same id). */
export const ORGANICS_ALIVE_PARTY_ID = "10566";

/** Finale party id for ASLE (liquid drums + occasional powder supplier tag). */
export const ASLE_PARTY_ID = "10944";

const _powderSet = new Set<string>(OAG_POWDER_RAW_SKUS);
const _fpfCycSet = new Set<string>(OAG_FPF_CYC_FINISHED_SKUS);

export function isOagPowderRawSku(productId: string | null | undefined): boolean {
    if (!productId) return false;
    return _powderSet.has(String(productId).trim().toUpperCase());
}

export function isOagFpfCycFinishedSku(productId: string | null | undefined): boolean {
    if (!productId) return false;
    return _fpfCycSet.has(String(productId).trim().toUpperCase());
}

export function isOagFpfRawDnrSku(productId: string | null | undefined): boolean {
    if (!productId) return false;
    return String(productId).trim().toUpperCase() === OAG_FPF_RAW_DNR_SKU;
}

/**
 * SKU-level lead override for powder RAW. Returns null for non-powder SKUs
 * so caller keeps vendor policy / Finale / default chain.
 */
export function getOagPowderLeadOverrideDays(
    productId: string | null | undefined,
): number | null {
    return isOagPowderRawSku(productId) ? OAG_POWDER_LEAD_DAYS : null;
}

export function getOagPowderLotQty(productId: string | null | undefined): number | null {
    if (!productId) return null;
    const sku = String(productId).trim().toUpperCase() as OagPowderRawSku;
    return OAG_POWDER_LOT_QTY[sku] ?? null;
}

/**
 * True when a PO's line items are exclusively CYC FPF finished goods
 * (or empty/unknown → false so we don't ignore powder/mixed POs).
 */
export function isFpfCycOnlyPo(productIds: Array<string | null | undefined> | null | undefined): boolean {
    if (!productIds || productIds.length === 0) return false;
    const cleaned = productIds
        .map((p) => (p == null ? "" : String(p).trim().toUpperCase()))
        .filter(Boolean);
    if (cleaned.length === 0) return false;
    return cleaned.every((p) => _fpfCycSet.has(p));
}

/**
 * Resolve effective lead days for ordering.
 * Priority: powder MTO policy → vendor fixed override → SKU observed receipts →
 *           vendor policy → base → vendor minimum floor.
 */
export function resolveLeadTimeDays(params: {
    productId: string | null | undefined;
    /** Vendor name — enables vendor-level fixed override + minimum floor. */
    vendorName?: string | null;
    vendorPolicyLeadDays?: number | null;
    /** Observed planning lead from Finale send→receive samples for this SKU. */
    skuObservedLeadDays?: number | null;
    skuObservedProvenance?: string | null;
    baseLeadDays: number;
}): { days: number; provenance: string } {
    const skuLead = getOagPowderLeadOverrideDays(params.productId);
    if (skuLead != null) {
        return {
            days: skuLead,
            provenance: `${skuLead}d OAG powder MTO policy (Martin/124788)`,
        };
    }

    // Fixed vendor override (multi-delivery inflation / long-lead import) — absolute.
    const vendorOverride = resolveVendorLeadOverride(params.vendorName);
    if (vendorOverride) {
        return {
            days: vendorOverride.days,
            provenance: `${vendorOverride.days}d vendor override · ${vendorOverride.reason}`,
        };
    }

    let days: number;
    let provenance: string;
    if (params.skuObservedLeadDays != null && params.skuObservedLeadDays > 0) {
        days = params.skuObservedLeadDays;
        provenance = params.skuObservedProvenance
            ?? `${params.skuObservedLeadDays}d SKU observed`;
    } else if (params.vendorPolicyLeadDays != null && params.vendorPolicyLeadDays > 0) {
        days = params.vendorPolicyLeadDays;
        provenance = `${params.vendorPolicyLeadDays}d vendor policy override`;
    } else {
        days = params.baseLeadDays;
        provenance = `${params.baseLeadDays}d base`;
    }

    // Vendor minimum floor — raises over-optimistic measured leads (made-to-order
    // vendors whose single-sample lows are PO-after-order artifacts).
    const vendorFloor = resolveVendorLeadFloor(params.vendorName);
    if (vendorFloor && days < vendorFloor.days) {
        return {
            days: vendorFloor.days,
            provenance: `${vendorFloor.days}d vendor floor (measured ${days}d) · ${vendorFloor.reason}`,
        };
    }

    return { days, provenance };
}
