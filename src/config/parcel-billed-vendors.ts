/**
 * @file    src/config/parcel-billed-vendors.ts
 * @purpose Vendors whose inbound carriage is billed to OUR FedEx parcel account
 *          (Express/Ground, FedEx Billing Online) rather than to the vendor.
 *
 *          Their invoice prints "Shipping / BAS FedEx Account" at $0.00 and a
 *          "Tracking no.:" line, so nothing on their paperwork prices the
 *          carriage; the charge arrives on a FedEx Billing Online invoice days
 *          after delivery, with no PO number on it. The only join is the
 *          tracking ID, which is what `reconcile-parcel-tracking-freight.ts`
 *          does, and what the `parcel-freight-reconcile` cron runs.
 *
 *          Distinct from `freight-required-vendors.ts`: that list says a PO must
 *          not close at $0 freight (it includes these vendors too). This list
 *          says WHERE the amount comes from — the parcel bill, not the vendor
 *          invoice and not DestiNATION.
 *
 * @author  Hermia
 * @created 2026-11-04
 * @deps    none
 */

/** Vendor name keys (normalised, alnum only) whose carriage rides our parcel account. */
export const PARCEL_BILLED_VENDORS = [
    "safe solutions", // TweetMint Plant Wash (TEC101/TEC102), Howard City MI -> Montrose CO
];

function norm(name: string | null | undefined): string {
    return String(name ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

/**
 * True when this vendor's inbound freight is billed to our FedEx parcel account.
 *
 * Matches on the space/punctuation-stripped name so `Safe Solutions, Inc.`
 * (invoice side) and `SafeSolutions` (Finale supplier) resolve the same way.
 */
export function isParcelBilledVendor(vendorName: string | null | undefined): boolean {
    const n = norm(vendorName);
    if (!n) return false;
    return PARCEL_BILLED_VENDORS.some((key) => n.includes(norm(key)));
}

/** The raw keys, for enumerating POs/invoices by vendor. */
export function parcelBilledVendorKeys(): string[] {
    return [...PARCEL_BILLED_VENDORS];
}
