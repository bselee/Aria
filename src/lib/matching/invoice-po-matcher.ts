import { createClient } from "@/lib/supabase";
import { InvoiceData } from "@/lib/pdf/invoice-parser";
import { POData } from "@/lib/pdf/po-parser";
import Fuse from "fuse.js";

export interface MatchResult {
    matched: boolean;
    confidence: "exact" | "high" | "medium" | "low" | "none";
    matchedPO: POData | null;
    matchStrategy: string;
    discrepancies: Discrepancy[];
    autoApprove: boolean;      // True if exact match with no discrepancies
}

export interface Discrepancy {
    field: string;
    invoiceValue: unknown;
    poValue: unknown;
    delta?: number;
    severity: "blocking" | "warning" | "info";
}

export async function matchInvoiceToPO(invoice: InvoiceData): Promise<MatchResult> {
    const supabase = createClient();

    // Strategy 1: Exact PO number match
    if (invoice.poNumber) {
        const { data: exactPO } = await supabase
            .from("purchase_orders")
            .select("*")
            .eq("po_number", invoice.poNumber)
            .eq("status", "open")
            .single();

        if (exactPO) {
            const discrepancies = compareInvoiceToPO(invoice, exactPO.raw_data);
            return {
                matched: true,
                confidence: "exact",
                matchedPO: exactPO.raw_data,
                matchStrategy: "PO number exact match",
                discrepancies,
                autoApprove: discrepancies.filter(d => d.severity === "blocking").length === 0,
            };
        }
    }

    // Strategy 2: Fuzzy vendor name + amount match
    const { data: vendorPOs } = await supabase
        .from("purchase_orders")
        .select("*")
        .eq("status", "open")
        .gte("created_at", new Date(Date.now() - 90 * 86400000).toISOString()); // Last 90 days

    if (!vendorPOs?.length) {
        return { matched: false, confidence: "none", matchedPO: null, matchStrategy: "No open POs found", discrepancies: [], autoApprove: false };
    }

    // Fuzzy vendor name match
    const fuse = new Fuse(vendorPOs, { keys: ["vendor_name"], threshold: 0.3 });
    const vendorMatches = fuse.search(invoice.vendorName).map(r => r.item);

    if (!vendorMatches.length) {
        return { matched: false, confidence: "none", matchedPO: null, matchStrategy: "No POs for vendor", discrepancies: [], autoApprove: false };
    }

    // Among vendor matches, find by amount proximity
    const amountMatch = vendorMatches.find(
        po => Math.abs(po.total - invoice.total) / invoice.total < 0.02  // Within 2%
    );

    if (amountMatch) {
        const discrepancies = compareInvoiceToPO(invoice, amountMatch.raw_data);
        return {
            matched: true,
            confidence: "high",
            matchedPO: amountMatch.raw_data,
            matchStrategy: "Vendor + amount fuzzy match",
            discrepancies,
            autoApprove: false,    // Require human confirmation for fuzzy matches
        };
    }

    // Strategy 3: Line item matching (if amounts don't match, try SKU overlap)
    const lineItemMatch = vendorMatches.find(po => {
        const poSkus = new Set(po.raw_data?.lineItems?.map((l: { sku: string }) => l.sku).filter(Boolean));
        const invoiceSkus = new Set(invoice.lineItems?.map(l => l.sku).filter(Boolean));
        const overlap = [...poSkus].filter(sku => invoiceSkus.has(sku)).length;
        return overlap >= 2;
    });

    if (lineItemMatch) {
        return {
            matched: true,
            confidence: "medium",
            matchedPO: lineItemMatch.raw_data,
            matchStrategy: "SKU line item overlap",
            discrepancies: compareInvoiceToPO(invoice, lineItemMatch.raw_data),
            autoApprove: false,
        };
    }

    return {
        matched: false,
        confidence: "low",
        matchedPO: vendorMatches[0]?.raw_data ?? null,
        matchStrategy: "Unconfirmed — closest vendor PO suggested",
        discrepancies: [],
        autoApprove: false,
    };
}

function compareInvoiceToPO(invoice: InvoiceData, po: POData): Discrepancy[] {
    const discrepancies: Discrepancy[] = [];

    // Total amount check
    if (Math.abs(invoice.total - po.total) > 0.01) {
        const delta = invoice.total - po.total;
        discrepancies.push({
            field: "total",
            invoiceValue: invoice.total,
            poValue: po.total,
            delta,
            severity: Math.abs(delta) > po.total * 0.05 ? "blocking" : "warning",
        });
    }

    // Line item quantity checks
    for (const invLine of invoice.lineItems ?? []) {
        const poLine = po.lineItems?.find(
            pl => pl.sku === invLine.sku || pl.description.toLowerCase().includes(invLine.description.toLowerCase().slice(0, 20))
        );
        if (poLine) {
            if (invLine.qty !== poLine.qtyOrdered) {
                discrepancies.push({
                    field: `line_qty:${invLine.description.slice(0, 30)}`,
                    invoiceValue: invLine.qty,
                    poValue: poLine.qtyOrdered,
                    delta: invLine.qty - poLine.qtyOrdered,
                    severity: "warning",
                });
            }
            if (Math.abs(invLine.unitPrice - poLine.unitPrice) > 0.01) {
                discrepancies.push({
                    field: `line_price:${invLine.description.slice(0, 30)}`,
                    invoiceValue: invLine.unitPrice,
                    poValue: poLine.unitPrice,
                    delta: invLine.unitPrice - poLine.unitPrice,
                    severity: Math.abs(invLine.unitPrice - poLine.unitPrice) > poLine.unitPrice * 0.03 ? "blocking" : "warning",
                });
            }
        }
    }

    // Payment terms check
    if (invoice.paymentTerms && po.paymentTerms && invoice.paymentTerms !== po.paymentTerms) {
        discrepancies.push({
            field: "payment_terms",
            invoiceValue: invoice.paymentTerms,
            poValue: po.paymentTerms,
            severity: "info",
        });
    }

    return discrepancies;
}
