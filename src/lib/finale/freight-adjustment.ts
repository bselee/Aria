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
