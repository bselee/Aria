/**
 * @file    src/lib/purchasing/deliver-bill-vendors.ts
 * @purpose Domain model for vendors that bill AS they deliver. Bill's words
 *          (2026-10-28): Miles, Cowoco, CR Minerals, Rootwise and Thrive bill
 *          per delivery. Several deliveries land on one blanket PO (CR
 *          Minerals ~4, Miles also multi). These vendors "hardly ever fill or
 *          complete a PO in a single delivery" but invoice accordingly — so a
 *          bill smaller than the PO total is EXPECTED, not a discrepancy. The
 *          hazard is the opposite direction: invoices that do NOT match their
 *          delivery and "almost always over bill us a complete PO".
 *
 *          New Moon is deliberately NOT here: it always bills up front (the
 *          full-PO bill lands in Bill.com with the PO number as the invoice
 *          number — see BILLED_UPFRONT in @/config/paid-in-advance-vendors).
 *          Its partial receipts must never read as an invoice-vs-delivery
 *          overbill; that is its normal billing pattern.
 *
 *          A partial receipt from these vendors is therefore a normal state,
 *          and invoice-vs-delivery comparison (not invoice-vs-PO) is the
 *          review that matters.
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    none
 */

const DELIVER_AND_BILL = [
    "miles filippelli",
    "fermented plant extracts",
    "cowoco",
    "cr minerals",
    "rootwise",
    "thrive",
];

/** Vendors whose POs are known blanket orders with several deliveries. */
const BLANKET_MULTI_DELIVERY = [
    "cr minerals",
];

function norm(name: string): string {
    return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function matches(keys: string[], name: string | null | undefined): boolean {
    const n = norm(name ?? "");
    if (!n) return false;
    const compact = n.replace(/ /g, "");
    return keys.some((key) => n.includes(key) || compact.includes(key.replace(/ /g, "")));
}

/**
 * True when this vendor bills per delivery rather than per PO. A bill from
 * these vendors covering only part of a PO is the normal pattern.
 */
export function isDeliverAndBillVendor(vendorName: string | null | undefined): boolean {
    return matches(DELIVER_AND_BILL, vendorName);
}

/**
 * True when this vendor's POs are blanket orders known to receive multiple
 * deliveries (CR Minerals ~4 per PO). Display-layer: "N still open" is the
 * expected shape of a healthy row, not a short to chase.
 */
export function isBlanketMultiDeliveryVendor(vendorName: string | null | undefined): boolean {
    return matches(BLANKET_MULTI_DELIVERY, vendorName);
}
