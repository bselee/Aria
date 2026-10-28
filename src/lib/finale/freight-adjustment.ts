export const FINALE_FREIGHT_PROMO_URL = "/buildasoilorganics/api/productpromo/10007";
export const FINALE_FREIGHT_DESCRIPTION = "Freight";
export const FINALE_FREIGHT_ALLOCATION = "ADJ_BY_WEIGHT";

export type FreightAllocLine = {
    quantity?: number | null;
    weight?: number | null;
};

export type FinaleFreightAdjustment = {
    amount: number;
    description: string;
    productPromoUrl: string;
    adjustmentAllocationEnumId: string;
    orderAdjustmentAllocationList: number[];
};

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** Product weight in pounds. Finale stores some SKUs as ounces (2 oz displays as 0.12 lb). */
export function weightInPounds(weight: number, uom?: string | null): number {
    const n = Number(weight);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const unit = (uom || "").toLowerCase();
    if (unit.includes("oz")) return n / 16;
    return n;
}

/**
 * Parse a per-unit weight (in pounds) from a Finale product name.
 *
 * Finale's `weight` + `weightUomId` fields are inconsistent: some SKUs store
 * pounds tagged as `WT_oz` (RWBP102 "8oz" → weight 0.5), others store genuine
 * ounces (RWBP105 "2oz 12ea Case" → weight 24). The name is the reliable
 * source of truth, so derive from it first and only fall back to the raw field.
 *
 * Recognized shapes (case-insensitive):
 *   - "… : 1lb"          → 1
 *   - "… : 8oz"          → 0.5   (8 oz ÷ 16)
 *   - "… : 4oz"          → 0.25
 *   - "… (2oz) 12ea Case" → 1.5  (2 oz × 12 per case ÷ 16)
 *   - "… : 16oz/Pint"    → null (fluid volume, not weight; caller falls back)
 *
 * Returns null when the name carries no weight, or only a fluid-volume marker
 * (fl oz, oz/Pint, oz/Quart, oz/Gallon) so callers can fall back to the raw field.
 */
export function parseUnitWeightLb(name: string | null | undefined): number | null {
    const n = (name || "").trim();
    if (!n) return null;

    // Case multiplier first: "(2oz) 12ea Case" → 2 × 12 oz.
    const caseMatch = n.match(/\((\d+(?:\.\d+)?)\s*(oz|lb|ozs|lbs)\)\s*(\d+)\s*(?:ea|each|ct|count|pc)\b/i);
    if (caseMatch) {
        const base = parseFloat(caseMatch[1]);
        const unit = caseMatch[2].toLowerCase();
        const count = parseFloat(caseMatch[3]);
        if (Number.isFinite(base) && Number.isFinite(count) && base > 0 && count > 0) {
            return unit.startsWith("oz") ? (base * count) / 16 : base * count;
        }
    }

    // Fluid-volume markers are NOT weight: "16oz/Pint", "12 fl oz", "oz per gallon".
    if (/\d+\s*fl\.?\s*oz|\d+\s*oz\s*\/\s*(pint|pt|qt|quart|gal|gallon)/i.test(n)) {
        return null;
    }

    // Single weight: "1lb", "8oz", "1.3 lb", "4 oz".
    const single = n.match(/(\d+(?:\.\d+)?)\s*(lb|lbs|oz|ozs)\b/i);
    if (single) {
        const val = parseFloat(single[1]);
        const unit = single[2].toLowerCase();
        if (Number.isFinite(val) && val > 0) {
            return unit.startsWith("oz") ? val / 16 : val;
        }
    }
    return null;
}

/**
 * Resolve a product's per-unit weight in pounds, preferring the name
 * (ground truth) and falling back to the raw `weight` + `weightUomId` fields.
 *
 * @returns pounds, or 0 when the weight is unknown.
 */
export function resolveUnitWeightLb(opts: {
    name?: string | null;
    weight?: number | null;
    weightUomId?: string | null;
}): number {
    const fromName = parseUnitWeightLb(opts.name);
    if (fromName !== null && fromName > 0) return fromName;
    const w = Number(opts.weight) || 0;
    if (w <= 0) return 0;
    return weightInPounds(w, opts.weightUomId);
}

/** Split `amount` across positive masses. Zero-mass slots stay $0. */
function splitByMass(amount: number, masses: number[]): number[] {
    if (!masses.length) return [round2(amount)];
    const totalMass = masses.reduce((sum, mass) => sum + mass, 0);
    if (totalMass <= 0) {
        return masses.map(() => 0);
    }
    const rounded = masses.map((mass) => round2((mass / totalMass) * amount));
    const diff = round2(amount - rounded.reduce((sum, value) => sum + value, 0));
    if (diff !== 0) {
        for (let i = rounded.length - 1; i >= 0; i--) {
            if (masses[i] > 0) {
                rounded[i] = round2(rounded[i] + diff);
                break;
            }
        }
    }
    return rounded;
}

export interface FreightPoWeight {
    /** Finale order ID (PO number). */
    orderId: string;
    /** Total allocation weight for this PO, in pounds (qty × unit weight summed). */
    pounds: number;
}

export interface FreightPoSplit {
    orderId: string;
    pounds: number;
    amount: number;
}

/**
 * Split one freight bill (one truck, multiple POs) across the POs that rode on
 * it, proportional to each PO's total allocation weight in pounds.
 *
 * This mirrors Finale's ADJ_BY_WEIGHT but at the PO level: the single FedEx
 * freight bill has no per-PO weight, so the split comes from qty × unit weight
 * per PO. POs with zero/unknown weight get $0 rather than a fabricated share.
 *
 * Rounding: each share is rounded to cents and the residual is dropped on the
 * last positive-weight PO so the shares sum exactly to `amount`.
 */
export function splitFreightAcrossPos(amount: number, pos: FreightPoWeight[]): FreightPoSplit[] {
    if (!pos.length) return [];
    const masses = pos.map((p) => (Number.isFinite(Number(p.pounds)) && Number(p.pounds) > 0 ? Number(p.pounds) : 0));
    const shares = splitByMass(amount, masses);
    return pos.map((p, i) => ({ orderId: p.orderId, pounds: masses[i], amount: shares[i] }));
}

/**
 * Split freight across PO lines by weight (qty × lb). Empty lines get $0.
 * Falls back to quantity when weight is missing so a 1-line PO still lands.
 */
export function allocateFreightByWeight(amount: number, lines: FreightAllocLine[]): number[] {
    if (!lines.length) return [round2(amount)];

    const masses = lines.map((line) => {
        const qty = Number(line.quantity) || 0;
        if (qty <= 0) return 0;
        const weight = Number(line.weight);
        return Number.isFinite(weight) && weight > 0 ? qty * weight : qty;
    });
    const totalMass = masses.reduce((sum, mass) => sum + mass, 0);
    if (totalMass <= 0) {
        const empty = lines.map(() => 0);
        empty[0] = round2(amount);
        return empty;
    }
    return splitByMass(amount, masses);
}

export type DeliveryAllocOrderLine = {
    productId?: string | null;
    quantity?: number | null;
    weight?: number | null;
};

export type DeliveryAllocShipmentLine = {
    productId?: string | null;
    quantity?: number | null;
};

/**
 * Allocate one delivery's freight onto the order lines for the SKUs on that
 * shipment only. List length matches `orderLines` so Finale can post it.
 * Mass is shipment qty × lb, not the full PO qty, so a later truck does not
 * pull this bill onto SKUs it did not carry. A SKU is charged once, on the
 * first order line that has it.
 *
 * Returns an all-zero list when no shipment SKU is on the order. Callers must
 * not post that.
 */
export function allocateFreightForDelivery(
    amount: number,
    orderLines: DeliveryAllocOrderLine[],
    shipmentLines: DeliveryAllocShipmentLine[],
): number[] {
    const shipQty = new Map<string, number>();
    for (const line of shipmentLines) {
        const sku = String(line.productId || "").trim();
        const qty = Number(line.quantity) || 0;
        if (!sku || qty <= 0) continue;
        shipQty.set(sku, (shipQty.get(sku) || 0) + qty);
    }

    const masses = orderLines.map((line) => {
        const sku = String(line.productId || "").trim();
        const qty = sku ? (shipQty.get(sku) || 0) : 0;
        if (qty <= 0) return 0;
        shipQty.set(sku, 0);
        const weight = Number(line.weight);
        return Number.isFinite(weight) && weight > 0 ? qty * weight : qty;
    });
    return splitByMass(amount, masses);
}

/**
 * True when a 10007 (or Freight-labeled) line will not move unit landed cost.
 * Extra wording, a missing ADJ_BY_WEIGHT flag, or an allocation list that does
 * not match the order line count all skip Finale's landed-cost roll.
 */
export function freightLineSkipsLandedCost(
    adj: {
        description?: string | null;
        productPromoUrl?: string | null;
        adjustmentAllocationEnumId?: string | null;
        orderAdjustmentAllocationList?: number[] | null;
    },
    orderLineCount: number,
): boolean {
    const promo = adj.productPromoUrl ?? "";
    const desc = (adj.description ?? "").trim();
    const isFreight = promo.includes("/10007") || /^freight\b/i.test(desc);
    if (!isFreight) return false;
    if (desc !== FINALE_FREIGHT_DESCRIPTION) return true;
    if (adj.adjustmentAllocationEnumId !== FINALE_FREIGHT_ALLOCATION) return true;
    const alloc = adj.orderAdjustmentAllocationList;
    if (!alloc || alloc.length !== orderLineCount) return true;
    return false;
}

export function buildFinaleFreightAdjustment(
    amount: number,
    allocation?: number[],
): FinaleFreightAdjustment {
    const orderAdjustmentAllocationList =
        allocation && allocation.length > 0 ? allocation.map(round2) : [round2(amount)];
    return {
        amount: round2(amount),
        description: FINALE_FREIGHT_DESCRIPTION,
        productPromoUrl: FINALE_FREIGHT_PROMO_URL,
        adjustmentAllocationEnumId: FINALE_FREIGHT_ALLOCATION,
        orderAdjustmentAllocationList,
    };
}

/** Tax promo constants — Tax must allocate like Freight to reach landed
 *  cost (Bill, 2026-10-28: "Tax needs fixing and should allocate"). */
export const FINALE_TAX_PROMO_URL = "/buildasoilorganics/api/productpromo/10008";
export const FINALE_TAX_DESCRIPTION = "Tax";
export const FINALE_TAX_ALLOCATION = "ADJ_BY_WEIGHT";

/** A Tax promo line with a weight allocation — the same roll as Freight. */
export function buildFinaleTaxAdjustment(
    amount: number,
    allocation?: number[],
): FinaleFreightAdjustment {
    const orderAdjustmentAllocationList =
        allocation && allocation.length > 0 ? allocation.map(round2) : [round2(amount)];
    return {
        amount: round2(amount),
        description: FINALE_TAX_DESCRIPTION,
        productPromoUrl: FINALE_TAX_PROMO_URL,
        adjustmentAllocationEnumId: FINALE_TAX_ALLOCATION,
        orderAdjustmentAllocationList,
    };
}

/**
 * True when a Tax line misses what it needs to reach landed cost: not the
 * bare `Tax` description, missing ADJ_BY_WEIGHT, or an allocation list that
 * does not match the raw item count.
 */
export function taxLineSkipsLandedCost(
    adj: {
        description?: string | null;
        productPromoUrl?: string | null;
        adjustmentAllocationEnumId?: string | null;
        orderAdjustmentAllocationList?: number[] | null;
    },
    orderLineCount: number,
): boolean {
    const promo = adj.productPromoUrl ?? "";
    const desc = (adj.description ?? "").trim();
    const isTax = promo.includes("/10008") || /^tax\b/i.test(desc);
    if (!isTax) return false;
    if (desc !== FINALE_TAX_DESCRIPTION) return true;
    if (adj.adjustmentAllocationEnumId !== FINALE_TAX_ALLOCATION) return true;
    const alloc = adj.orderAdjustmentAllocationList;
    if (!alloc || alloc.length !== orderLineCount) return true;
    return false;
}

/** Build a Freight promo line allocated to the current PO's item list. */
export function freightAdjustmentForPo(
    amount: number,
    items: FreightAllocLine[],
    existingAlloc?: number[] | null,
): FinaleFreightAdjustment {
    const alloc =
        existingAlloc && existingAlloc.length === items.length && items.length > 0
            ? allocateFreightByWeight(
                amount,
                existingAlloc.map((value) => ({ quantity: Math.abs(Number(value) || 0), weight: 1 })),
            )
            : allocateFreightByWeight(amount, items);
    return buildFinaleFreightAdjustment(amount, alloc);
}

export function mergeInvoiceCorrelationNote(existingNotes: string | null | undefined, invoiceNumbers: string[]): string {
    const normalizedInvoices = invoiceNumbers
        .map(invoice => invoice.trim())
        .filter(Boolean);

    if (normalizedInvoices.length === 0) {
        return existingNotes || "";
    }

    const invoiceNote = normalizedInvoices.length === 1
        ? `Invoice #${normalizedInvoices[0]}`
        : `Invoices ${normalizedInvoices.map(invoice => `#${invoice}`).join(", ")}`;

    const existing = (existingNotes || "").trim();
    if (!existing) {
        return invoiceNote;
    }

    return existing.includes(invoiceNote) ? existing : `${existing}\n${invoiceNote}`;
}
