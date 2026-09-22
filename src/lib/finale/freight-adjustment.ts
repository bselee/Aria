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
