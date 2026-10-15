/**
 * @file    src/lib/purchasing/vendor-po-units.ts
 * @purpose Pure helpers that read a vendor's OWN purchase orders out of a Finale
 *          orderViewConnection payload and sum booked units per SKU.
 *          This exists because the Amazon capture used to count only the POs the export
 *          names plus the POs the capture tool itself created. A PO keyed by hand, whose
 *          Amazon PO field is blank, appeared in neither list and so was invisible, and
 *          the capture re-booked units the shelf already had (125349 over 124371,
 *          125353 over 124933). Reading the vendor's POs directly closes that hole.
 * @author  Hermia
 * @created 2026-10-15
 * @deps    none
 * @env     none
 */

/** One line of one vendor PO, reduced to what coverage math needs. */
export interface VendorPoLine {
    /** Finale order url, e.g. /buildasoilorganics/api/order/125353 */
    orderUrl: string;
    /** Finale statusId, e.g. ORDER_LOCKED, ORDER_COMPLETED, ORDER_CANCELLED */
    status: string;
    /** Finale orderDate (the date the PO claims, not when it was keyed) */
    orderDate: string;
    /** Finale productId (the SKU) */
    sku: string;
    /** Units ordered on this line */
    quantity: number;
}

/** A cancelled PO never books stock, whatever its lines say. */
const CANCELLED = /CANCEL/i;

/**
 * Finale returns most numbers as strings, and blank/null for untouched fields.
 * @param value Raw value from a GraphQL payload.
 * @returns The number, or 0 when it cannot be read as a finite number.
 */
export function parsePoNumber(value: unknown): number {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "string") {
        const n = Number.parseFloat(value.trim());
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asEdges(node: unknown): unknown[] {
    const edges = asRecord(node)?.edges;
    return Array.isArray(edges) ? edges : [];
}

/**
 * Reduce an `orderViewConnection` payload to vendor PO lines.
 *
 * Cancelled POs are dropped, and when `partyId` is given a PO is kept only if its
 * supplier party url ends in that id, so a supplier filter that is looser than expected
 * on the server side cannot leak another vendor's units into the totals.
 *
 * @param json Parsed GraphQL response body.
 * @param partyId Optional supplier party id (e.g. the Amazon party) to confirm locally.
 * @returns One entry per order line that carries a SKU.
 */
export function extractVendorPoLines(json: unknown, partyId?: string): VendorPoLine[] {
    const root = asRecord(json);
    const connection = asRecord(root?.data)?.orderViewConnection ?? asRecord(root)?.orderViewConnection;
    const wanted = partyId ? String(partyId).split("/").pop() : undefined;
    const lines: VendorPoLine[] = [];
    for (const edge of asEdges(connection)) {
        const node = asRecord(asRecord(edge)?.node);
        if (!node) continue;
        const status = String(node.status ?? "");
        if (CANCELLED.test(status)) continue;
        if (wanted) {
            const supplierParty = asRecord(node.supplier)?.partyUrl;
            const actual = String(supplierParty ?? "").split("/").pop();
            if (actual !== wanted) continue;
        }
        const orderUrl = String(node.orderUrl ?? "");
        const orderDate = String(node.orderDate ?? "");
        for (const itemEdge of asEdges(node.itemList)) {
            const item = asRecord(asRecord(itemEdge)?.node);
            if (!item) continue;
            const sku = String(asRecord(item.product)?.productId ?? "").trim();
            if (!sku) continue;
            lines.push({ orderUrl, status, orderDate, sku, quantity: parsePoNumber(item.quantity) });
        }
    }
    return lines;
}

/**
 * Total the units each SKU already has on a PO.
 * @param lines Lines from {@link extractVendorPoLines}.
 * @returns SKU (trimmed) to units ordered.
 */
export function sumUnitsBySku(lines: readonly VendorPoLine[]): Map<string, number> {
    const totals = new Map<string, number>();
    for (const line of lines) {
        const sku = line.sku.trim();
        if (!sku) continue;
        totals.set(sku, (totals.get(sku) ?? 0) + line.quantity);
    }
    return totals;
}

/**
 * Add `extra` into `target` in place, creating keys as needed.
 *
 * Used to fold the vendor's own POs into the units the capture already counts as booked,
 * so both sources land on one map before coverage is computed.
 *
 * @param target Map to mutate.
 * @param extra Units to add.
 */
export function mergeUnits(target: Map<string, number>, extra: ReadonlyMap<string, number>): void {
    for (const [sku, units] of extra) {
        const key = sku.trim();
        if (!key) continue;
        target.set(key, (target.get(key) ?? 0) + units);
    }
}

/**
 * Pull the PO number out of a Finale order url.
 *
 * Booked units arrive from three sources (POs the export names, POs the capture tool made,
 * and the vendor's own POs) and the same PO can appear in several, so the PO number is what
 * they are de-duplicated on.
 *
 * @param orderUrl e.g. "/buildasoilorganics/api/order/124933", or a bare PO number.
 * @returns The trailing path segment, trimmed; empty when there is nothing usable.
 */
export function poNumberOf(orderUrl: string): string {
    const raw = String(orderUrl ?? "").trim();
    if (!raw) return "";
    const segment = raw.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
    try {
        return decodeURIComponent(segment).replace(/^#/, "").trim();
    } catch {
        return segment.trim();
    }
}
