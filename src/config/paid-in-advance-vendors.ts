/**
 * @file    paid-in-advance-vendors.ts
 * @purpose Vendors Bill pays before the goods arrive. A received PO from
 *          these vendors is not waiting on an AP invoice.
 * @author  Hermia
 * @created 2026-10-27
 * @deps    none
 *
 * Bill 2026-10-27: Sustainable Village, Cen-Tec, and Axiom are always paid
 * in advance. Colorful Packaging is the same class (credit card, never
 * Bill.com — vendor-memory). Add a name here when Bill names another.
 */

const PAID_IN_ADVANCE = [
    "sustainable village",
    "cen tec",
    "centec",
    "axiom",
    "colorful packaging",
];

/** Bills the whole PO before the shipments finish. Invoice number in Bill.com is the PO number. */
const BILLED_UPFRONT = [
    "new moon",
    "newmoon",
];

function norm(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * True when this supplier is paid before shipment, so Receivings must not
 * say "Awaiting vendor invoice".
 */
export function isPaidInAdvanceVendor(vendorName: string | null | undefined): boolean {
    const n = norm(String(vendorName ?? ""));
    if (!n) return false;
    const compact = n.replace(/ /g, "");
    return PAID_IN_ADVANCE.some((key) => n.includes(key) || compact.includes(key.replace(/ /g, "")));
}

/** True when the vendor bills the full PO up front and then delivers in parts. */
export function isBilledUpfrontVendor(vendorName: string | null | undefined): boolean {
    const n = norm(String(vendorName ?? ""));
    if (!n) return false;
    const compact = n.replace(/ /g, "");
    return BILLED_UPFRONT.some((key) => n.includes(key) || compact.includes(key.replace(/ /g, "")));
}
