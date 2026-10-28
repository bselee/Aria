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

    // Bare 8-digit dropship ref (base, or base + a single letter, with no
    // "-DropshipPO" suffix): shape alone cannot tell which suffixed row it is
    // (23581487 -> 23581487-S-DropshipPO, 23578097A -> 23578097A-DropshipPO),
    // so resolve the DB spelling first so the write joins. Falls through to
    // shape/existence below when no row matches (a genuine bare row, or a PO
    // not yet propagated to purchase_orders).
    if (/^2\d{7}[A-Z]?$/i.test(clean)) {
        const resolved = await resolveDropshipPOByRef(clean);
        if (resolved) return resolved;
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

/**
 * Resolve a bare 8-digit dropship ref (base, or base + a single trailing
 * letter) to the purchase_orders spelling, in this locked order:
 *
 *   1. Exact DB spelling match (candidate equals a stored po_number verbatim,
 *      case-insensitive) -> that row.
 *   2. Base has exactly one row -> that row, letter ignored. The letter is OCR
 *      noise (S/5, B/8, A/4), never authoritative, so a mangled "23581487S"
 *      still resolves to "23581487-S-DropshipPO".
 *   3. Base has more than one row and no exact match -> null, never guess.
 *
 * The base is restricted to the 2-prefixed dropship family (`^2\d{7}$`): every
 * 8-digit dropship PO in purchase_orders starts with 2, so a non-2-prefixed
 * candidate (an AAA Cooper PRO like "64058931", a B.L. digit-run) is rejected
 * here without a DB round-trip. A bare 235xxxxxxx that resolves to no row stays
 * null — that is what keeps class 11 (carrier P.O. box / Finale SALES_ORDER
 * holding a bare 8-digit) closed.
 *
 * @param ref  Raw 8-digit candidate (e.g. "23578097", "23578097A").
 * @returns    The purchase_orders.po_number spelling, or null when no row's
 *             base matches, or when the base is ambiguous (or on DB error —
 *             fail closed).
 */
export async function resolveDropshipPOByRef(ref: string): Promise<string | null> {
    const clean = String(ref ?? "").trim();
    if (!/^2\d{7}[A-Z]?$/i.test(clean)) return null;
    const base = clean.slice(0, 8);
    try {
        const client = createClient();
        const { data, error } = await client
            .from("purchase_orders")
            .select("po_number")
            .ilike("po_number", `${base}%`);
        if (error) {
            console.warn(
                `[po-ref-validator] dropship ref lookup failed for ${clean}: ` +
                `${error.message || error}`,
            );
            return null;
        }
        const spellings = Array.from(
            new Set((data ?? []).map((r: any) => r.po_number as string)),
        );
        // Rule 1: exact spelling match (candidate == a stored po_number).
        const exact = spellings.find((s) => s.toLowerCase() === clean.toLowerCase());
        if (exact) return exact;
        // Rule 2 (single row, letter ignored) and rule 3 (ambiguous -> null).
        return spellings.length === 1 ? spellings[0] : null;
    } catch (err: any) {
        console.warn(
            `[po-ref-validator] dropship ref lookup threw for ${clean}: ` +
            `${err?.message || err}`,
        );
        return null;
    }
}

/**
 * Thin wrapper for callers that hold only a bare 8-digit base (no trailing
 * letter). Delegates to resolveDropshipPOByRef, which owns the ambiguity
 * preference.
 */
export async function resolveDropshipPOByBase(base: string): Promise<string | null> {
    return resolveDropshipPOByRef(base);
}

/**
 * Gate a list of extracted PO refs before they are written. Standard 5-7 digit
 * label-bounded refs and Finale vendor-ref 6-digit refs pass through untouched.
 * An 8-digit dropship candidate (bare base or base + single letter) must resolve
 * to a purchase_orders base — otherwise it is dropped, so a cancelled sales
 * order "23566017" with no PO row never becomes a PO ref.
 *
 * The resolved value is the DB's own spelling, so the write joins back to the
 * row (e.g. "23578097A" -> "23578097A-DropshipPO").
 *
 * @param poNumbers  Raw refs from an extractor (label-bounded + bare + vendor-ref).
 * @returns          Resolved refs, de-duplicated; 8-digit candidates with no
 *                   base are omitted.
 */
export async function resolveExtractedPOs(poNumbers: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const ref of poNumbers) {
        if (/^\d{8}[A-Z]?$/i.test(ref)) {
            const spelling = await resolveDropshipPOByRef(ref);
            if (spelling) out.push(spelling);
        } else {
            out.push(ref);
        }
    }
    return Array.from(new Set(out));
}
