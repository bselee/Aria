export const FINALE_FREIGHT_PROMO_URL = "/buildasoilorganics/api/productpromo/10007";
export const FINALE_FREIGHT_DESCRIPTION = "Freight";

export function buildFinaleFreightAdjustment(amount: number): {
    amount: number;
    description: string;
    productPromoUrl: string;
} {
    return {
        amount,
        description: FINALE_FREIGHT_DESCRIPTION,
        productPromoUrl: FINALE_FREIGHT_PROMO_URL,
    };
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
