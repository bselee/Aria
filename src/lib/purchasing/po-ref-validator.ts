/**
 * @file    po-ref-validator.ts
 * @purpose Validate that an extracted PO reference is a real purchase order
 *          before it is written to any ledger (ap_local_forwards, invoice_cache,
 *          vendor_invoices, shipments). Two-layer acceptance:
 *            1. Shape — Finale PO format, deterministic and DB-free:
 *                 standard 6-digit "1xxxxx" (125257, 100347, 113179) or
 *                 dropship 8-digit "2xxxxxxx" (23320587, 21410811) with an
 *                 optional "-DropshipPO" suffix and optional alphanumeric
 *                 segment (A-DropshipPO, -S-DropshipPO, -SF1-DropshipPO).
 *            2. Existence — present in purchase_orders.po_number
 *               (case-insensitive), which admits legacy/zero-padded shapes
 *               (0400773, 0265201, 4520-DropshipPO) that don't match the
 *               standard Finale format. The DB's own spelling is returned so
 *               downstream writes carry the value that joins.
 *          A ref that is neither shaped nor in purchase_orders is nulled and
 *          the string logged as a document trace, so a freight-statement
 *          "ADV ORDER 4798" can never become a phantom PO.
 *
 *          Shape acceptance is independent of existence on purpose: a PO
 *          created in Finale five minutes ago is not in purchase_orders yet and
 *          must still pass. That is why the check is an OR, not a lookup.
 *
 * @author  aria-coder
 * @created 2026-10-27
 * @deps    @/lib/db (createClient) — existence check only
 */
import { createClient } from "@/lib/db";

// Finale PO shapes (derived from purchase_orders.po_number distribution):
//   standard  "1" + 5 digits  → 6 digits total (125257, 100347, 113179, 13862)
//   dropship  "2" + 7 digits  → 8 digits total (23320587, 21410811), plus an
//             optional "-DropshipPO" suffix with an optional attached/dashed
//             alphanumeric segment (A/B/F1 attached, -S/-SF1/-SA dashed). The
//             required "DropshipPO" anchor rejects a trailing "-1" rating
//             estimate and over-long digit runs.
const STANDARD_PO_RE = /^1\d{5}$/;
const DROPSHIP_PO_RE = /^2\d{7}(?:(?:-?[A-Z0-9]+)?-DROPSHIPPO)?$/i;

/**
 * Normalize a raw PO ref for shape/existence checks: trim and strip the common
 * "PO-", "P.O.", "ORDER", "#" prefixes (mirrors normalizePoString in
 * shipment-intelligence without pulling that module in). Case is preserved so a
 * dropship "-DropshipPO" suffix keeps its spelling; shape matching is
 * case-insensitive and existence is an ilike lookup.
 */
function normalizeRef(ref: string): string {
    return String(ref)
        .trim()
        .replace(/^(?:PO|P\.?O\.?|ORDER)[-\s]?#?\s*/i, "")
        .replace(/^#\s*/, "")
        .trim();
}

/**
 * True when the ref matches a Finale PO shape (standard 6-digit or dropship
 * 8-digit). Pure and synchronous — the deterministic, battery-testable half of
 * the validator.
 */
export function isPoShaped(ref: string | null | undefined): boolean {
    if (!ref) return false;
    const s = normalizeRef(ref);
    if (!s) return false;
    return STANDARD_PO_RE.test(s) || DROPSHIP_PO_RE.test(s);
}

/**
 * Return the purchase_orders.po_number spelling for `ref` (case-insensitive),
 * or null when absent. DB errors are treated as "unconfirmed" (null) so the
 * caller rejects non-shaped refs — failing open on existence costs a manual
 * match; failing closed costs a wrong PO.
 */
export async function poRefExistsInPurchaseOrders(ref: string): Promise<string | null> {
    try {
        const client = createClient();
        const { data, error } = await client
            .from("purchase_orders")
            .select("po_number")
            .ilike("po_number", ref)
            .limit(1)
            .maybeSingle();
        if (error) {
            console.warn(
                `[po-ref-validator] existence check failed for ${JSON.stringify(ref)}: ` +
                `${error.message || error}`,
            );
            return null;
        }
        return data?.po_number ?? null;
    } catch (err: any) {
        console.warn(
            `[po-ref-validator] existence check threw for ${JSON.stringify(ref)}: ` +
            `${err?.message || err}`,
        );
        return null;
    }
}

/**
 * Validate a PO ref before it is written. Returns the normalized ref when it
 * is Finale-shaped, or the purchase_orders spelling when it already exists
 * there; otherwise returns null and logs the rejected string as a document
 * trace.
 *
 * @param ref      Raw PO ref (e.g. "4798", "PO-125257", "23320587-DropshipPO").
 * @param context  Optional provenance string included in the rejection log
 *                 (e.g. gmail message id).
 */
export async function validatePoRef(
    ref: string | null | undefined,
    context?: string,
): Promise<string | null> {
    const raw = String(ref ?? "").trim();
    const clean = normalizeRef(raw);
    if (!clean) return null;

    // A ref that exists verbatim in purchase_orders wins over normalization: 37
    // live rows are stored with a literal "PO-" prefix (PO-124430, PO-124516 …),
    // and returning the stripped form would write a ref that cannot join back to
    // the PO row. Shape acceptance stays after this check for refs typed with a
    // prefix that the DB does not carry ("PO-125257" -> 125257).
    if (clean !== raw) {
        const rawSpelling = await poRefExistsInPurchaseOrders(raw);
        if (rawSpelling) return rawSpelling;
    }

    if (isPoShaped(clean)) return clean;
    const dbSpelling = await poRefExistsInPurchaseOrders(clean);
    if (dbSpelling) return dbSpelling;

    console.warn(
        `[po-ref-validator] rejected non-PO ref ${JSON.stringify(clean)} ` +
        `(not Finale-shaped, not in purchase_orders)${context ? ` — ${context}` : ""}`,
    );
    return null;
}
