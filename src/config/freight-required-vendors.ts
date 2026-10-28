/**
 * @file    src/config/freight-required-vendors.ts
 * @purpose Vendors whose POs must carry trucking freight before they count as
 *          complete (2026-10-28). Bill: Rootwise, Uline, Garys, International
 *          Molasses, Lind Marine "must have trucking freight added... just as
 *          invoice aligns, freight should align as well. Whether charged by
 *          vendor or we scheduled ourselves through FedEx or destination."
 *
 *          The list is NOT exhaustive (Bill's words: "Not complete list").
 *          Add vendors by name as they are identified; the settlement and
 *          completion gates below read this list, so a missing entry means a
 *          freight-less PO slips through.
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    none
 */

const FREIGHT_REQUIRED = [
    "rootwise",
    "uline",
    "garys worm",
    "garies worm", // OCR/alias variant seen in vendor data
    "gary's worm",
    "international molasses",
    "int molasses",
    "lind marine",
];

function norm(name: string): string {
    return String(name ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function matches(keys: string[], name: string | null | undefined): boolean {
    const n = norm(name ?? "");
    if (!n) return false;
    const compact = n.replace(/ /g, "");
    return keys.some((key) => n.includes(key) || compact.includes(key.replace(/ /g, "")));
}

/**
 * True when the vendor's POs must carry trucking freight (vendor-charged or
 * carrier-added) before they may settle or complete.
 */
export function isFreightRequiredVendor(vendorName: string | null | undefined): boolean {
    return matches(FREIGHT_REQUIRED, vendorName);
}

/**
 * Freight already on the PO, Finale truth: total minus the goods subtotal.
 * Finale carries no freight line until the invoice amount is applied.
 */
export function freightOnPo(total: number | null | undefined, subtotal: number | null | undefined): number {
    const t = Number(total ?? 0);
    const s = Number(subtotal ?? 0);
    if (t <= s) return 0;
    return Math.round((t - s) * 100) / 100;
}
