/**
 * @file    completion-gate.ts
 * @purpose Shared "should this PO complete?" gate for the 3-way match. Both the
 *          pre-check in the receivings complete_po handler and the lifecycle
 *          belt-and-suspenders gate call this so they read the SAME invoice line
 *          source (vendor_invoices) and build the SAME comparison the UI's
 *          variance classifier does. Centralizing it removes the drift that let
 *          PO 125051 complete despite a BLOCKING unknown-SKU variance (the gate
 *          queried the legacy `invoices` table, which has no line_items column,
 *          so it silently skipped).
 * @author  Aria Coder
 * @created 2026-08-12
 * @deps    ./three-way-match
 * @env     (none — pure functions)
 */

import {
    evaluateThreeWayMatch,
    type ThreeWayMatchResult,
    type ThreeWayLine,
} from "./three-way-match";

/** One normalized invoice line, in the shape the 3-way gate consumes. */
export interface InvoiceLine {
    sku?: string;
    qty: number;
    unitPrice: number;
    description?: string;
}

/** One PO line, normalized for the gate. */
export interface GatePoLine {
    productId: string;
    description?: string;
    quantity: number;
    unitPrice: number;
    receivedQty?: number | null;
}

export interface CompletionGateInput {
    /** Finale PO number. */
    orderId: string;
    /** True only with concrete receipt evidence (receive_date in the past). */
    hasReceipt: boolean;
    /** True when a vendor_invoices row is matched to this PO. */
    hasInvoice: boolean;
    /** PO line items (productId + quantity; unitPrice often absent in the local cache). */
    poLines: GatePoLine[];
    /** Invoice line items (OCR output from vendor_invoices). */
    invoiceLines: InvoiceLine[];
    /** Per-SKU actually-received quantities (caller-loaded from Finale). */
    receivedQtys: Record<string, number>;
    /** Per-SKU pack multipliers for UOM normalization. */
    packMultipliers: Record<string, number>;
}

export interface CompletionGateResult {
    /** True only when the 3-way match is clean and completion may proceed. */
    ok: boolean;
    /** Present when ok=false — a clear, user-facing reason. */
    blockReason?: string;
    /** One-line match summary (populated for both pass and fail). */
    summary?: string;
}

/**
 * Extract normalized invoice line items from a vendor_invoices row.
 * Mirrors the GET receivings enrichment (line_items column first, then
 * raw_data.lineItems fallback) so the gate and the UI read identical OCR output.
 * Handles both snake_case (unit_price) and camelCase (unitPrice) price fields.
 *
 * @param row A vendor_invoices row (or null/undefined).
 * @returns Normalized lines; empty array when no extractable line data exists.
 */
export function extractInvoiceLines(row: any): InvoiceLine[] {
    if (!row) return [];
    const rd = row.raw_data as Record<string, unknown> | null;
    let src: unknown = null;
    if (row.line_items) {
        src = row.line_items;
    } else if (rd?.lineItems && Array.isArray(rd.lineItems) && rd.lineItems.length > 0) {
        src = rd.lineItems;
    }
    if (!src) return [];

    let items: unknown;
    try {
        items = typeof src === "string" ? JSON.parse(src) : src;
    } catch {
        return [];
    }
    if (!Array.isArray(items)) return [];

    return (items as any[]).map((li: any) => ({
        sku: li.sku ?? li.productId ?? li.partNumber ?? undefined,
        qty: Number(li.qty ?? li.quantity ?? 0),
        unitPrice: Number(li.unit_price ?? li.unitPrice ?? 0),
        description: li.description ?? undefined,
    }));
}

/** Case-insensitive SKU match, with a null-guarded description fallback. */
function lineMatches(invLine: InvoiceLine, poLine: GatePoLine): boolean {
    const invSku = (invLine.sku ?? "").trim();
    const poSku = (poLine.productId ?? "").trim();
    if (invSku && poSku && invSku.toLowerCase() === poSku.toLowerCase()) return true;
    if (
        invLine.description != null &&
        poLine.description != null &&
        invLine.description === poLine.description
    ) {
        return true;
    }
    return false;
}

/**
 * Run the canonical 3-way completion gate.
 *
 * FAIL-OPEN on missing data: when either side lacks extractable line items there
 * is nothing to compare, so the gate returns { ok: true } (skip) rather than
 * blocking completion. This mirrors the original guard
 * (`invoiceData?.line_items && poData?.line_items`), which only evaluated the
 * match when BOTH the PO and invoice had lines. Most invoices still lack
 * OCR-extracted lines, so a fail-closed gate here would halt completion for
 * nearly every PO.
 *
 * When both sides have lines, it builds the comparison set from PO lines PLUS
 * invoice-only lines (so an invoiced SKU absent from the PO becomes a blocking
 * "line_not_on_po", matching the UI's classifier), then evaluates the canonical
 * 3-way match. Any blocking discrepancy — unknown SKU, over-billing, price
 * variance, or a missing receipt — returns ok=false.
 *
 * @param input Documents and per-line figures to compare.
 * @returns ok=true when the match is clean (or skipped for lack of data), else
 *          ok=false with a clear blockReason.
 */
export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateResult {
    // Fail-open: no line data on either side → nothing to compare → skip.
    if (input.poLines.length === 0 || input.invoiceLines.length === 0) {
        return {
            ok: true,
            summary: `3-way match skipped — no line-item data to compare for PO ${input.orderId}.`,
        };
    }

    const match = runThreeWayMatch(input);
    if (match.canApprove) {
        return { ok: true, summary: match.summary };
    }
    return { ok: false, blockReason: match.summary, summary: match.summary };
}

/**
 * Build the comparison line set the canonical 3-way match consumes: PO lines
 * first (each matched against its invoice line, if any), then invoice-only
 * lines so an invoiced SKU absent from the PO becomes a blocking
 * "line_not_on_po" — matching the UI's classifier.
 *
 * Shared by the completion gate and the automation runner so both read the
 * identical comparison. Pure — no I/O.
 *
 * @param input Documents and per-line figures to compare.
 * @returns Canonical ThreeWayLine set in base units (pack-normalized).
 */
export function buildThreeWayLines(input: CompletionGateInput): ThreeWayLine[] {
    const lines: ThreeWayLine[] = [];
    const matchedInvSkus = new Set<string>();

    // PO lines first (each matched against its invoice line, if any).
    for (const pl of input.poLines) {
        const sku = pl.productId ?? "";
        const il = input.invoiceLines.find((l) => lineMatches(l, pl));
        if (il && il.sku) matchedInvSkus.add(il.sku);
        const receivedQty =
            input.receivedQtys[sku] !== undefined
                ? input.receivedQtys[sku]
                : input.hasReceipt
                    ? (pl.receivedQty ?? pl.quantity ?? null)
                    : null;
        const pack = input.packMultipliers[sku];
        lines.push({
            productId: pl.productId ?? "UNKNOWN",
            description: pl.description,
            poQty: pl.quantity ?? 0,
            poUnitPrice: pl.unitPrice ?? 0,
            receivedQty,
            invoiceQty: il?.qty ?? 0,
            invoiceUnitPrice: il?.unitPrice ?? 0,
            ...(pack ? { packMultiplier: pack } : {}),
        });
    }

    // Invoice-only lines → "line_not_on_po" (blocking) when the PO never lists them.
    for (const il of input.invoiceLines) {
        const sku = il.sku ?? "";
        if (sku && matchedInvSkus.has(sku)) continue;
        lines.push({
            productId: sku || "UNKNOWN",
            description: il.description,
            poQty: 0,
            poUnitPrice: 0,
            receivedQty: input.receivedQtys[sku] ?? null,
            invoiceQty: il.qty ?? 0,
            invoiceUnitPrice: il.unitPrice ?? 0,
        });
    }

    return lines;
}

/**
 * Run the canonical 3-way match against the gate's input, returning the FULL
 * verdict — including "incomplete" when a required leg (receipt/invoice/PO) is
 * missing. The completion gate consumes this via `canApprove`; the automation
 * runner consumes the whole verdict so it can record `three_way_incomplete`
 * distinct from a real `three_way_exception`.
 *
 * @param input Documents and per-line figures to compare.
 * @returns The authoritative ThreeWayMatchResult.
 */
export function runThreeWayMatch(input: CompletionGateInput): ThreeWayMatchResult {
    return evaluateThreeWayMatch({
        orderId: input.orderId,
        hasPurchaseOrder: input.poLines.length > 0,
        hasReceipt: input.hasReceipt,
        hasInvoice: input.hasInvoice,
        lines: buildThreeWayLines(input),
    });
}
