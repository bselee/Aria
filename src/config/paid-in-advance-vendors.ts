/**
 * @file    paid-in-advance-vendors.ts
 * @purpose Vendors Bill pays before the goods arrive. A received PO from
 *          these vendors is not waiting on an AP invoice.
 * @author  Hermia
 * @created 2026-10-27
 * @deps    none
 *
 * Bill 2026-11-05 (authoritative list): a handful of vendors require
 * prepayment — Thirsty Earth, Grove Bags, Calyx (Containers/Cure),
 * Sustainable Village, Axiom (Print), Colorful Packaging. Some charge the
 * card on file — PSI / Print Source, Cen-Tec, Stock Bag Depot, Rock On.
 * None of these ever sends a Bill.com invoice, so Receivings must not say
 * "Awaiting vendor invoice" / "No bill yet" for them.
 */

const PAID_IN_ADVANCE = [
    // Prepayment before goods ship:
    "sustainable village",
    "thirsty earth",
    "grove bags",
    "calyx",
    // Card on file (vendor charges the card):
    "colorful packaging",
    "axiom",
    "rock on",
    "cen tec",
    "centec",
    "print source",
    "psi",
    "stock bag depot",
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
