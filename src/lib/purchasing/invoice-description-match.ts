/**
 * @file    invoice-description-match.ts
 * @purpose Resolve a vendor invoice line's free-text DESCRIPTION to the Finale
 *          SKU it names, so the invoice can be matched to its PO by exact-SKU
 *          overlap even when the invoice prints no SKU.
 *
 *          Miles (Fermented Plant Extracts, OCR'd as "Miles Filippelli") bills
 *          by description — "Comfrey Gallon", "Peach half gallon" — with a
 *          two-tier price ($13 half-gallon, $24 gallon) shared across the whole
 *          catalog. Price alone therefore cannot identify the line (every
 *          half-gallon is $13, every gallon is $24), and the OCR line carries
 *          `sku: ""`. The description is the goods' identity: resolve it to the
 *          Finale productId, then match exact SKU against PO line items.
 *
 *          Pure functions only — no I/O, no DB. The caller (invoice-po-matcher)
 *          supplies vendor-matched PO rows and owns any auto-apply decision.
 *
 * @author  Hermia
 * @created 2026-11-04
 */

/** Miles extract products: normalized keyword → { half-gallon SKU, gallon SKU }. */
const MILES_EXTRACT_SKUS: Record<string, { half: string; gallon: string }> = {
    comfrey: { half: "BASLCE102", gallon: "BASLCE103" },
    hemp: { half: "BASLHE105", gallon: "BASLHE104" },
    pumpkin: { half: "BASLPE103", gallon: "BASLPE102" },
    peach: { half: "BASLPEE103", gallon: "BASLPEE102" },
    nettle: { half: "FNE102", gallon: "FNE101" },
    watermelon: { half: "FWE101", gallon: "FWE102" },
    willow: { half: "FWI101", gallon: "FWI102" },
    // "horset" prefix also catches the OCR typo "horsetaial".
    horset: { half: "HTF102", gallon: "HTF101" },
};

/** Miles single-SKU items (no half/gallon split). */
const MILES_SINGLE_SKUS: Array<{ keyword: string; sku: string }> = [
    { keyword: "wetting", sku: "JWA101" },
    { keyword: "jadam", sku: "JWA101" },
];

/**
 * True when a vendor/sender name is Miles in any spelling. The invoice OCR
 * name is usually "Fermented Plant Extracts"; the sender is "Miles Filippelli".
 */
export function isMilesVendorName(vendorName: string | null | undefined): boolean {
    const letters = String(vendorName ?? "").toLowerCase().replace(/[^a-z]/g, "");
    return letters.includes("miles") || letters.includes("fermentedplant");
}

/**
 * Resolve a Miles invoice line description to its Finale SKU.
 *
 * "Comfrey Gallon" → BASLCE103; "comfrey half gallon" → BASLCE102;
 * "Peach Half Gallon" → BASLPEE103; "Herbal Wetting Agent" → JWA101.
 *
 * @returns the Finale productId, or null when the description names no Miles
 *          product.
 */
export function resolveMilesDescriptionToSku(description: string | null | undefined): string | null {
    const d = String(description ?? "").toLowerCase();
    if (!d) return null;

    for (const [keyword, skus] of Object.entries(MILES_EXTRACT_SKUS)) {
        if (d.includes(keyword)) {
            const half = /\bhalf\b|1\/2|½/.test(d);
            return half ? skus.half : skus.gallon;
        }
    }
    for (const { keyword, sku } of MILES_SINGLE_SKUS) {
        if (d.includes(keyword)) return sku;
    }
    return null;
}

/** Extract the Finale SKUs named by a set of invoice line descriptions. */
export function skusFromInvoiceDescriptions(
    lineItems: Array<{ description?: string | null }> | null | undefined,
): string[] {
    const out: string[] = [];
    for (const li of lineItems ?? []) {
        const sku = resolveMilesDescriptionToSku(li?.description ?? null);
        if (sku && !out.includes(sku)) out.push(sku);
    }
    return out;
}

/** A purchase_orders row carrying `line_items`, as the matcher fetches it. */
export interface DescriptionPoRow {
    po_number?: string | null;
    vendor_name?: string | null;
    issue_date?: string | null;
    total_amount?: number | string | null;
    total?: number | string | null;
    status?: string | null;
    line_items?: unknown;
}

/** One resolved invoice line: its Finale SKU plus the ordered quantity. */
interface ResolvedLine {
    sku: string;
    qty: number;
}

/** One PO line's productId + remaining quantity (three-state, like unit-price). */
interface PoSkuLine {
    productId: string;
    /** null = unknown, 0 = fully received, > 0 = still owed. */
    remainingQty: number | null;
}

/** Coerce a `line_items` value (JSONB array or JSON string) to an array. */
function coerceToArray(lineItems: unknown): unknown[] {
    if (Array.isArray(lineItems)) return lineItems;
    if (typeof lineItems === "string") {
        try {
            const parsed: unknown = JSON.parse(lineItems);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

/** Pull `{productId, remainingQty}` out of a PO's `line_items` (Finale shape). */
function poSkuLines(lineItems: unknown): PoSkuLine[] {
    const out: PoSkuLine[] = [];
    for (const raw of coerceToArray(lineItems)) {
        const li = (raw ?? {}) as Record<string, unknown>;
        const productId = String(li.productId ?? "").trim();
        if (!productId) continue;

        const hasRemaining = li.remainingQty !== undefined && li.remainingQty !== null;
        let remainingQty: number | null = null;
        if (hasRemaining) {
            const r = Number(li.remainingQty);
            remainingQty = Number.isFinite(r) ? r : null;
        }
        // No `quantity` fallback: an ABSENT remainingQty means an old PO that
        // predates remaining tracking (received), not "quantity still owed".
        out.push({ productId, remainingQty });
    }
    return out;
}

/** A PO that carries at least one of the invoice's resolved SKUs. */
export interface DescriptionSkuHit {
    poNumber: string;
    vendorName: string;
    orderDate: string;
    total: number;
    status: string;
    matchedSkus: string[];
    /** True when the PO matched every resolved line on the invoice. */
    matchedAllLines: boolean;
}

/**
 * Score PO rows by exact-SKU overlap against the SKUs an invoice's
 * descriptions resolve to, with a remaining-quantity guard. A PO line covers
 * an invoice line only when it carries that SKU AND still has the remaining
 * quantity to satisfy the line (a fully-received PO at `remainingQty: 0` is
 * NOT cover — 125408 vs a fresh "Comfrey Gallon" bill). A PO that matches
 * every resolved line is `matchedAllLines`, the conclusive signal the caller
 * may auto-apply on.
 *
 * @param invoiceLines the invoice's line items (description → SKU, qty guard).
 * @param poRows       vendor-matched purchase_orders rows carrying `line_items`.
 * @returns            hits with >= 1 matching SKU, conclusive first.
 */
export function scoreDescriptionSkuCandidates(
    invoiceLines: Array<{ description?: string | null; qty?: number | null }> | null | undefined,
    poRows: DescriptionPoRow[],
): DescriptionSkuHit[] {
    const resolved: ResolvedLine[] = [];
    for (const li of invoiceLines ?? []) {
        const sku = resolveMilesDescriptionToSku(li?.description ?? null);
        if (!sku) continue;
        const qty = Number(li?.qty ?? 0);
        resolved.push({ sku, qty: Number.isFinite(qty) ? qty : 0 });
    }
    if (resolved.length === 0) return [];

    const hits: DescriptionSkuHit[] = [];
    for (const po of poRows ?? []) {
        const poNumber = String(po?.po_number ?? "").trim();
        if (!poNumber || /DropshipPO$/i.test(poNumber)) continue;

        const poLines = poSkuLines(po.line_items);
        const matched: string[] = [];
        for (const { sku, qty } of resolved) {
            const covered = poLines.some((pl) => {
                if (pl.productId !== sku) return false;
                // Only an OPEN line covers: remainingQty must be present and > 0.
                // An absent (null) or zero remainingQty is a received PO — not cover.
                if (pl.remainingQty === null || pl.remainingQty <= 0) return false;
                if (qty > 0) return pl.remainingQty >= qty;
                return true;
            });
            if (covered && !matched.includes(sku)) matched.push(sku);
        }
        if (matched.length === 0) continue;

        hits.push({
            poNumber,
            vendorName: po.vendor_name || "",
            orderDate: String(po.issue_date || ""),
            total: Number(po.total_amount || po.total || 0),
            status: String(po.status || "unknown"),
            matchedSkus: matched,
            matchedAllLines: matched.length === resolved.length,
        });
    }

    hits.sort((a, b) => {
        if (a.matchedAllLines !== b.matchedAllLines) return a.matchedAllLines ? -1 : 1;
        return b.matchedSkus.length - a.matchedSkus.length;
    });
    return hits;
}
