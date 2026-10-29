/**
 * @file    src/lib/purchasing/bill-po-links.ts
 * @purpose Many-to-many bill→PO linkage (Gap 24): one vendor bill can cover
 *          several Finale POs, and it must be nameable on EACH of them.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `vendor_invoices.po_number` is single-valued. When a Bill.com bill pays for
 * two or three Finale POs (the Miles 10/27 delivery shape), writing the bill on
 * one row left every sibling PO reading "awaiting vendor invoice" forever —
 * even though the bill, the email and the PDF all existed. `bill_po_links`
 * (supabase/migrations/20261029_bill_po_links.sql) records the bill against
 * every PO it covers; these helpers turn link rows into the answers the
 * dashboard asks:
 *
 *   "which POs does this bill cover?"      → coversPosForInvoice / poNumbersForInvoice
 *   "which bills cover this PO?"            → invoicesForPo
 *   "is this PO on a multi-PO bill?"        → isPoCoveredByMultiPoBill
 *   "what rows do I write for this bill?"   → linkBillsToPos
 *
 * ── LINK-ROW SHAPE ─────────────────────────────────────────────────────────
 * The table stores (id, vendor_invoice_id, po_number, created_at) — no invoice
 * number. Two of the helpers are asked about an invoice NUMBER, so a link row
 * may carry `invoice_number` (or an embedded `vendor_invoices` object) that the
 * CALLER joined in from `vendor_invoices`. A link row with neither cannot be
 * attributed by number and is ignored by the invoice-number lookups — that is
 * deliberate: guessing a number from a UUID would be fabrication.
 *
 * ── HONESTY RULES ──────────────────────────────────────────────────────────
 * 1. A link row is the only proof that a bill covers a PO. Nothing here infers
 *    coverage from totals, dates or vendor names.
 * 2. PO numbers and invoice numbers are compared trimmed; invoice numbers are
 *    additionally case-insensitive (OCR casing drifts, PO ids do not).
 * 3. `vendor_invoices.po_number` is still authoritative for the PRIMARY PO, so
 *    coversPos unions it with the link rows rather than trusting links alone.
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────
 * Zero I/O: no PostgREST, no filesystem, no clock. The route fetches and these
 * functions decide, so every edge case is unit-testable.
 *
 * @deps    none
 * @created 2026-10-29
 */

/** A `bill_po_links` row, optionally enriched with the parent bill's identity. */
export interface BillPoLink {
    /** `bill_po_links.vendor_invoice_id` → `vendor_invoices.id`. */
    vendor_invoice_id: string;
    /** A Finale PO this bill covers. */
    po_number: string;
    /** Optional: the bill's invoice number, joined in by the caller. */
    invoice_number?: string | null;
    /** Optional: PostgREST embedded `vendor_invoices(invoice_number)` shape. */
    vendor_invoices?: { invoice_number?: string | null } | null;
}

/** The bill identity the helpers compare against links. */
export interface BillIdentity {
    id: string;
    invoice_number?: string | null;
    /** Legacy single-valued link; treated as one more covered PO. */
    po_number?: string | null;
}

/** Trim a PO number for comparison; `null`/`undefined` become "". */
function normalizePo(value: unknown): string {
    return String(value ?? "").trim();
}

/** Trim + upper-case an invoice number for comparison. */
function normalizeInvoiceNumber(value: unknown): string {
    return String(value ?? "").trim().toUpperCase();
}

/** Numeric-aware, locale-stable ordering so "PO 125429 + 125430" reads right. */
function comparePo(a: string, b: string): number {
    return a.localeCompare(b, "en", { numeric: true });
}

/** The invoice number a link row carries, whichever enrichment shape the caller used. */
function invoiceNumberOf(link: BillPoLink): string {
    const embedded = link?.vendor_invoices?.invoice_number;
    return normalizeInvoiceNumber(link?.invoice_number ?? embedded ?? "");
}

/**
 * Build the link rows to write for one bill.
 *
 * The bill's own `po_number` is included automatically (links are a superset of
 * the legacy column), followed by every distinct PO number passed in. Blank and
 * duplicate entries are dropped, order is preserved, and a bill with no id
 * yields no rows — an unattributable link is worse than none.
 *
 * @param bill      The parent bill (`vendor_invoices` row): id + identity.
 * @param poNumbers Every Finale PO the bill covers.
 * @returns Link rows ready to insert into `bill_po_links`.
 */
export function linkBillsToPos(
    bill: BillIdentity,
    poNumbers: ReadonlyArray<string | null | undefined>,
): BillPoLink[] {
    const id = normalizePo(bill?.id);
    if (!id) return [];

    const seen = new Set<string>();
    const rows: BillPoLink[] = [];
    const add = (raw: unknown): void => {
        const po = normalizePo(raw);
        if (!po || seen.has(po)) return;
        seen.add(po);
        rows.push({
            vendor_invoice_id: id,
            po_number: po,
            invoice_number: bill?.invoice_number ? String(bill.invoice_number).trim() : null,
        });
    };

    add(bill.po_number);
    for (const po of poNumbers) add(po);
    return rows;
}

/**
 * Every PO number one bill covers, sorted. Unions the bill's legacy
 * `po_number` with its link rows, so a multi-PO bill never loses its primary PO
 * and a legacy single-PO bill still answers with one entry.
 *
 * Link rows are matched by `vendor_invoice_id` (exact). Invoice numbers are only
 * used as a fallback when the bill has no id — duplicate invoice numbers across
 * vendors exist, so number matching alone is not trusted when an id is known.
 *
 * @param bill  The bill whose coverage to resolve.
 * @param links Link rows the caller has fetched for the bills on screen.
 * @returns Distinct PO numbers, sorted (`["125429","125430"]`).
 */
export function coversPosForInvoice(bill: BillIdentity, links: ReadonlyArray<BillPoLink>): string[] {
    const id = normalizePo(bill?.id);
    const invoiceNumber = normalizeInvoiceNumber(bill?.invoice_number);
    const pos = new Set<string>();

    const legacy = normalizePo(bill?.po_number);
    if (legacy) pos.add(legacy);

    for (const link of links ?? []) {
        const linkId = normalizePo(link?.vendor_invoice_id);
        const matches = id
            ? linkId === id
            : Boolean(invoiceNumber) && invoiceNumberOf(link) === invoiceNumber;
        if (!matches) continue;
        const po = normalizePo(link?.po_number);
        if (po) pos.add(po);
    }

    return [...pos].sort(comparePo);
}

/**
 * Every PO number a bill covers, looked up by invoice NUMBER (the identifier the
 * dashboard and email threads speak in).
 *
 * @param invoiceNumber The bill's invoice number, as shown to a human.
 * @param links         Link rows enriched with `invoice_number`.
 * @returns Distinct PO numbers, sorted; empty when no link carries that number.
 */
export function poNumbersForInvoice(invoiceNumber: string, links: ReadonlyArray<BillPoLink>): string[] {
    const wanted = normalizeInvoiceNumber(invoiceNumber);
    if (!wanted) return [];

    const pos = new Set<string>();
    for (const link of links ?? []) {
        if (invoiceNumberOf(link) !== wanted) continue;
        const po = normalizePo(link?.po_number);
        if (po) pos.add(po);
    }
    return [...pos].sort(comparePo);
}

/**
 * Every invoice number that covers one PO, sorted.
 *
 * @param poNumber Finale PO number (orderId / poNumber).
 * @param links    Link rows enriched with `invoice_number`.
 * @returns Distinct invoice numbers, sorted; empty when the PO has no links.
 */
export function invoicesForPo(poNumber: string, links: ReadonlyArray<BillPoLink>): string[] {
    const wanted = normalizePo(poNumber);
    if (!wanted) return [];

    const bills = new Set<string>();
    for (const link of links ?? []) {
        if (normalizePo(link?.po_number) !== wanted) continue;
        const inv = invoiceNumberOf(link);
        if (inv) bills.add(inv);
    }
    return [...bills].sort();
}

/**
 * True when some bill covering this PO also covers a different PO.
 *
 * This is the "the sibling is not awaiting an invoice — it is on the same bill"
 * question. A PO with no links, or only single-PO bills, answers false.
 *
 * @param poNumber The PO to test.
 * @param links    Link rows (invoice numbers not required).
 */
export function isPoCoveredByMultiPoBill(
    poNumber: string,
    links: ReadonlyArray<BillPoLink>,
): boolean {
    const wanted = normalizePo(poNumber);
    if (!wanted) return false;

    // Group by bill: id when present, else the invoice number it carries.
    const posByBill = new Map<string, Set<string>>();
    for (const link of links ?? []) {
        const billKey = normalizePo(link?.vendor_invoice_id) || invoiceNumberOf(link);
        const po = normalizePo(link?.po_number);
        if (!billKey || !po) continue;
        if (!posByBill.has(billKey)) posByBill.set(billKey, new Set());
        posByBill.get(billKey)!.add(po);
    }

    for (const coveredPos of posByBill.values()) {
        if (coveredPos.has(wanted) && coveredPos.size > 1) return true;
    }
    return false;
}
