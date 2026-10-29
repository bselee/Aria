/**
 * @file    src/lib/purchasing/receivings-three-way.ts
 * @purpose Build the 3-way-match verdict + bucketed variance that the Receivings
 *          GET stamps onto every received PO with a matched invoice (WS4,
 *          docs/plans/2026-10-29-aria-dashboard-hardening.md Task 4.1).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `three-way-match.ts` has been able to compute a verdict since July, but the
 * result never reached the Receivings payload: the panel could only show
 * "invoice matched" — never "matched AND ordered/received/billed agree". This
 * module turns the three documents the route already holds into the input the
 * gate expects, then buckets any variance so the row can name the one thing
 * that differs instead of saying "discrepancy".
 *
 * ── DATA CONSTRAINTS (do not relax) ─────────────────────────────────────────
 * Finale enforces a process-wide 500ms serial request interval, and the
 * receivings route has a 20s outer guard that abandons the whole enrichment.
 * So this module is PURE and only ever consumes data the request already has:
 *   - PO lines        : `po.items` from the bulk GraphQL query (unitPrice included)
 *   - receipt         : `item.receivedQuantity` (absent = unknown, never zero)
 *   - invoice lines   : `vendor_invoices.line_items` (OCR output)
 * It must never trigger a per-PO `getOrderDetails` fetch.
 *
 * ── HONESTY RULES (the panel must not lie) ──────────────────────────────────
 * 1. A bill whose PO price side is all zeros cannot be matched. There is
 *    nothing to compare prices against, so the verdict is `incomplete`, never
 *    `matched`. Same for a bill with money but no readable lines, and for a
 *    bill with no positive total.
 * 2. `receivedQty: null` (cold shipment cache) is "unknown", not zero — a
 *    missing read must never fabricate an overbill.
 * 3. PO lines that the invoice never billed are EXCLUDED from the comparison
 *    rather than passed with invoiceQty 0: the gate reads a $0 invoice price as
 *    a 100% price variance, which would be a manufactured exception. Nothing is
 *    claimed about unbilled lines (the panel's "awaiting invoice" leg covers
 *    that case).
 *
 * @deps    ./three-way-match (pure; no I/O, no DB)
 * @created 2026-10-29 (WS4)
 */

import {
    DEFAULT_TOLERANCES,
    evaluateThreeWayMatch,
    type ThreeWayDiscrepancy,
    type ThreeWayLine,
    type ThreeWayTolerances,
    type ThreeWayVerdict,
} from "./three-way-match";

/** The buckets the Receivings row can name. Fixed display order. */
export const VARIANCE_BUCKETS = ["freight", "tax", "fee", "sku", "price", "qty"] as const;
export type VarianceBucket = (typeof VARIANCE_BUCKETS)[number];

/** Why a leg that exists on paper is unusable for matching. */
export type ThreeWayIncompleteReason =
    | "no_invoice"
    | "invoice_amount_unknown"
    | "invoice_lines_unreadable"
    | "po_has_no_lines"
    | "po_prices_missing"
    | "no_comparable_lines";

/** One PO line as the bulk received-PO query delivers it. */
export interface ThreeWayPOItem {
    productId: string;
    /** Ordered quantity in base units. */
    orderedQty: number;
    /** Received quantity in base units; null when the shipment cache is cold. */
    receivedQty: number | null;
    /** PO unit price in base units. 0 / missing means the PO price side is unknown. */
    unitPrice: number;
}

/** One invoice line as `vendor_invoices.line_items` (OCR) delivers it. */
export interface ThreeWayInvoiceLine {
    sku?: string | null;
    productId?: string | null;
    description?: string | null;
    qty: number;
    unitPrice: number;
    extPrice?: number | null;
}

/** Bill header money the route already has on the matched invoice. */
export interface ThreeWayInvoiceHeader {
    freight?: number | null;
    tax?: number | null;
    total?: number | null;
}

export interface BuildReceivingsThreeWayInput {
    orderId: string;
    items: ThreeWayPOItem[];
    invoiceLines: ThreeWayInvoiceLine[];
    /** The matched invoice header, or null when no invoice is matched. */
    invoice: ThreeWayInvoiceHeader | null;
    /**
     * Freight already on the PO (Finale: total − subtotal). Null/undefined when
     * the PO has no subtotal and freight therefore cannot be derived.
     */
    poFreight?: number | null;
    /** Concrete receipt evidence. This route only lists received POs. */
    hasReceipt?: boolean;
    tolerances?: Partial<ThreeWayTolerances>;
}

/** A group of discrepancies sharing one bucket, ready for a chip. */
export interface BucketedVariance {
    bucket: VarianceBucket;
    /** True when at least one member of the bucket blocks payment. */
    blocking: boolean;
    count: number;
    /** Net dollar impact (positive = we are being overcharged). */
    dollarImpact: number;
    messages: string[];
    /** `line` = per-line comparison; `header` = bill freight vs PO freight. */
    source: "line" | "header";
}

/** The `_reconciliation.threeWay` payload. */
export interface ReceivingsThreeWay {
    verdict: ThreeWayVerdict;
    /** Safe to complete/pay today: clean verdict AND no open bucketed variance. */
    canComplete: boolean;
    discrepancies: ThreeWayDiscrepancy[];
    /** Per-line ordered / received / billed (only lines present on both sides). */
    lines: ThreeWayLine[];
    /** Distinct buckets present, in fixed display order. */
    bucket: VarianceBucket[];
    variances: BucketedVariance[];
    totalDollarImpact: number;
    summary: string;
    /** Set when a present-but-unusable leg makes a match impossible. */
    incompleteReason: ThreeWayIncompleteReason | null;
    /** Invoice lines with money but no SKU — could not be aligned to a PO line. */
    unmatchedInvoiceLines: number;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const FREIGHT_RE = /\b(freight|shipping|ship\s+charge|ltl|fedex|ups|delivery|drayage)\b/i;
const TAX_RE = /\b(tax|sales\s+tax|use\s+tax|excise)\b/i;
const FEE_RE = /\b(fee|fees|surcharge|handling|pallet|restock|minimum\s+order|cod)\b/i;

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** SKUs align by exact trimmed, case-insensitive equality — never substring
 *  (S-4738 vs S-473824 is a real trap that would match the wrong line). */
function skuKey(v: unknown): string {
    return String(v ?? "").trim().toUpperCase();
}

/**
 * Bucket a single discrepancy.
 *
 * The gate only emits qty / price / line kinds, so header-ish causes are
 * recognised from the line text: a billed "FREIGHT" line is a freight
 * discrepancy, not a price variance, and a fee line that is not on the PO is a
 * `fee`/`sku` difference rather than a generic SKU mismatch.
 */
export function bucketDiscrepancy(d: ThreeWayDiscrepancy): VarianceBucket {
    const text = `${d.productId ?? ""} ${d.message ?? ""}`;
    const moneyBucket = (): VarianceBucket | null =>
        FREIGHT_RE.test(text) ? "freight" : TAX_RE.test(text) ? "tax" : FEE_RE.test(text) ? "fee" : null;

    if (d.kind === "price_variance") return moneyBucket() ?? "price";
    if (d.kind === "line_not_on_po" || d.kind === "line_not_invoiced") return moneyBucket() ?? "sku";
    return "qty"; // qty_over_billed | qty_short_received | qty_over_received
}

function groupVariances(result: ThreeWayDiscrepancy[]): BucketedVariance[] {
    const byBucket = new Map<VarianceBucket, BucketedVariance>();
    for (const d of result) {
        const bucket = bucketDiscrepancy(d);
        const existing = byBucket.get(bucket);
        if (existing) {
            existing.count += 1;
            existing.blocking = existing.blocking || d.blocking;
            existing.dollarImpact = round2(existing.dollarImpact + num(d.dollarImpact));
            existing.messages.push(d.message);
        } else {
            byBucket.set(bucket, {
                bucket,
                blocking: d.blocking,
                count: 1,
                dollarImpact: round2(num(d.dollarImpact)),
                messages: [d.message],
                source: "line",
            });
        }
    }
    return [...byBucket.values()];
}

/**
 * Freight on the bill vs freight already on the PO.
 *
 * Informational for the gate (Finale has no freight on a PO until AP adds it),
 * but it is exactly the thing Bill reviews, so it suppresses READY. Only a
 * material delta is reported (> $1 AND > 2% of the PO freight) so rounding and
 * a penny of proration never chips a row.
 */
function freightVariance(
    poFreight: number | null | undefined,
    invoice: ThreeWayInvoiceHeader,
): BucketedVariance | null {
    if (poFreight === null || poFreight === undefined) return null;
    const onPo = Math.max(0, num(poFreight));
    const billed = Math.max(0, num(invoice.freight));
    const delta = round2(billed - onPo);
    if (Math.abs(delta) <= 1 || Math.abs(delta) <= onPo * 0.02) return null;
    return {
        bucket: "freight",
        blocking: delta > 0,
        count: 1,
        dollarImpact: delta,
        messages: [
            `freight billed $${billed.toFixed(2)} vs $${onPo.toFixed(2)} on the PO (${delta > 0 ? "+" : "−"}$${Math.abs(delta).toFixed(2)})`,
        ],
        source: "header",
    };
}

function incomplete(
    reason: ThreeWayIncompleteReason,
    summary: string,
    extra: Partial<ReceivingsThreeWay> = {},
): ReceivingsThreeWay {
    return {
        verdict: "incomplete",
        canComplete: false,
        discrepancies: [],
        lines: [],
        bucket: [],
        variances: [],
        totalDollarImpact: 0,
        summary,
        incompleteReason: reason,
        unmatchedInvoiceLines: 0,
        ...extra,
    };
}

// ── main ────────────────────────────────────────────────────────────────────

/**
 * Build the 3-way stamp for one received PO.
 *
 * Never throws: every unusable leg collapses to `incomplete` with a reason the
 * panel can print, because "cannot verify" must never render as "matched".
 */
export function buildReceivingsThreeWay(input: BuildReceivingsThreeWayInput): ReceivingsThreeWay {
    const items = Array.isArray(input.items) ? input.items : [];
    const invoiceLines = Array.isArray(input.invoiceLines) ? input.invoiceLines : [];
    const invoice = input.invoice;
    const hasReceipt = input.hasReceipt !== false;

    // ── Truth guards: a leg that exists on paper but cannot be compared ─────
    if (!invoice) {
        return incomplete("no_invoice", "Cannot 3-way match — no invoice is matched to this PO.");
    }
    if (!(num(invoice.total) > 0)) {
        return incomplete(
            "invoice_amount_unknown",
            "Cannot 3-way match — the matched bill has no readable amount.",
        );
    }
    if (items.length === 0) {
        return incomplete("po_has_no_lines", "Cannot 3-way match — the PO carries no line items.");
    }
    if (!items.some((it) => num(it.unitPrice) > 0)) {
        // Load-bearing: a zero-price PO side would make every comparison
        // vacuously "clean". There is no agreement to report.
        return incomplete(
            "po_prices_missing",
            "Cannot 3-way match — the PO carries no unit prices to compare the bill against.",
        );
    }
    if (invoiceLines.length === 0) {
        return incomplete(
            "invoice_lines_unreadable",
            "Cannot 3-way match — the bill has an amount but no readable line items.",
        );
    }

    // ── Align the three documents by exact SKU ──────────────────────────────
    const invoiceBySku = new Map<string, ThreeWayInvoiceLine>();
    for (const line of invoiceLines) {
        const key = skuKey(line.sku ?? line.productId);
        if (!key || invoiceBySku.has(key)) continue; // first line for a SKU wins
        invoiceBySku.set(key, line);
    }

    const lines: ThreeWayLine[] = [];
    const consumed = new Set<string>();
    let unmatchedInvoiceLines = 0;

    for (const item of items) {
        const key = skuKey(item.productId);
        if (!key) continue;
        const inv = invoiceBySku.get(key);
        if (!inv) continue; // never billed on this bill — nothing to compare (see header)
        consumed.add(key);
        lines.push({
            productId: item.productId,
            poQty: num(item.orderedQty),
            poUnitPrice: num(item.unitPrice),
            // null = receipt unknown. Never coerced to 0 — that would fabricate
            // "billed N, received 0" on a cold shipment cache.
            receivedQty: item.receivedQty === null || item.receivedQty === undefined ? null : num(item.receivedQty),
            invoiceQty: num(inv.qty),
            invoiceUnitPrice: num(inv.unitPrice),
        });
    }

    // Invoice lines the PO does not carry: poQty 0 / poUnitPrice 0 makes the
    // gate report `line_not_on_po`, which is exactly the SKU bucket.
    for (const line of invoiceLines) {
        const key = skuKey(line.sku ?? line.productId);
        if (!key) {
            if (num(line.qty) > 0 || num(line.unitPrice) > 0) unmatchedInvoiceLines += 1;
            continue;
        }
        if (consumed.has(key)) continue;
        consumed.add(key);
        lines.push({
            productId: line.sku || line.productId || key,
            description: line.description || undefined,
            poQty: 0,
            poUnitPrice: 0,
            receivedQty: null,
            invoiceQty: num(line.qty),
            invoiceUnitPrice: num(line.unitPrice),
        });
    }

    if (lines.length === 0) {
        return incomplete(
            "no_comparable_lines",
            "Cannot 3-way match — no bill line shares a SKU with the PO.",
            { unmatchedInvoiceLines },
        );
    }

    // ── The canonical gate ──────────────────────────────────────────────────
    const result = evaluateThreeWayMatch({
        orderId: input.orderId,
        hasPurchaseOrder: true,
        hasReceipt,
        hasInvoice: true,
        lines,
        tolerances: { ...DEFAULT_TOLERANCES, ...(input.tolerances ?? {}) },
    });

    // ── Bucketed variance ───────────────────────────────────────────────────
    const variances = groupVariances(result.discrepancies);
    const freight = freightVariance(input.poFreight, invoice);
    if (freight) variances.push(freight);

    const order = new Map<VarianceBucket, number>(VARIANCE_BUCKETS.map((b, i) => [b, i]));
    variances.sort((a, b) => (order.get(a.bucket) ?? 99) - (order.get(b.bucket) ?? 99));

    const totalDollarImpact = round2(
        variances.reduce((sum, v) => sum + (v.source === "header" ? 0 : v.dollarImpact), 0),
    );

    return {
        verdict: result.verdict,
        // READY requires both the gate's approval and an empty variance list.
        canComplete: result.canApprove && variances.length === 0,
        discrepancies: result.discrepancies,
        lines,
        bucket: variances.map((v) => v.bucket),
        variances,
        totalDollarImpact,
        summary: result.summary,
        incompleteReason: null,
        unmatchedInvoiceLines,
    };
}
