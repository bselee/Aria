/**
 * @file    src/lib/purchasing/vendor-lead-overrides.ts
 * @purpose Vendor-level lead-time overrides from the Aug 2026 lead-time audit.
 *          Finale's PO-level send→receive history is systematically wrong for
 *          some vendors, in opposite directions:
 *
 *          1. MULTI-DELIVERY inflation — one PO = many truck receipts; Finale's
 *             receiveDate stamps the LAST truck, so the measured lead reads far
 *             longer than the real order-to-first-delivery. CR Minerals pumice
 *             reads ~33d when the real lead is 7–10 working days (~14 calendar).
 *          2. PO-AFTER-ORDER deflation — the PO is created in Finale AFTER the
 *             order was actually placed (phone/email), so the measured window is
 *             compressed. Colorful's made-to-order bags read as low as 17d when
 *             real production is ~50d.
 *          3. IMPORT / no reliable Finale history — Covico CWP09 coconut water
 *             powder is an imported long-lead line with no usable Finale history;
 *             BAS declares 188d.
 *
 *          These are hard-coded (not DB) because they are discovered facts that
 *          must never drift back to the poisoned measured value.
 *
 * @author  Hermia
 * @created 2026-08-31
 * @deps    none (pure data + helpers)
 */

export interface VendorLeadOverride {
    /** Lead days (calendar). */
    days: number;
    /** Human-readable reason — surfaces in provenance labels. */
    reason: string;
}

/**
 * FIXED authoritative overrides — REPLACE the measured lead entirely (highest
 * priority). Use when Finale's measured lead is simply wrong, not just low.
 */
export const VENDOR_LEAD_OVERRIDES: Record<string, VendorLeadOverride> = {
    "cr minerals": {
        days: 14,
        reason: "7–10 working days; multi-delivery PO inflates Finale to ~33d",
    },
    covico: {
        days: 188,
        reason: "CWP09 imported coconut water powder — long lead (BAS 188d)",
    },
};

/**
 * MINIMUM floors — RAISE the measured lead when it is too optimistic. Used for
 * made-to-order vendors whose single-sample lows are PO-after-order artifacts.
 */
export const VENDOR_LEAD_FLOORS: Record<string, VendorLeadOverride> = {
    "sustainable village": {
        days: 14,
        reason: "working-day order cycle",
    },
    "colorful packaging": {
        days: 50,
        reason: "made-to-order bags; PO-after-order understates single-sample lows",
    },
};

function resolve(
    map: Record<string, VendorLeadOverride>,
    vendorName: string | null | undefined,
): VendorLeadOverride | null {
    if (!vendorName) return null;
    const key = vendorName.trim().toLowerCase();
    for (const [pattern, entry] of Object.entries(map)) {
        if (key.includes(pattern) || pattern.includes(key)) return entry;
    }
    return null;
}

/** Fixed authoritative lead override for a vendor, or null if none. */
export function resolveVendorLeadOverride(
    vendorName: string | null | undefined,
): VendorLeadOverride | null {
    return resolve(VENDOR_LEAD_OVERRIDES, vendorName);
}

/** Minimum lead floor for a vendor, or null if none. */
export function resolveVendorLeadFloor(
    vendorName: string | null | undefined,
): VendorLeadOverride | null {
    return resolve(VENDOR_LEAD_FLOORS, vendorName);
}
