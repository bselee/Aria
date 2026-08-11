/**
 * @file    receivings-enrichment.ts
 * @purpose Enriches a received PO with 3-way match, charges comparison,
 *          and line-level comparison for the GET receivings API.
 * @author  Aria Coder
 * @created 2026-08-11
 * @deps    three-way-match, pack-size-registry, core-client (Finale), db
 * @env     (none — uses injected clients)
 */

import type { ThreeWayMatchResult } from "./three-way-match";

export interface ChargesBreakdown {
    subtotal: number;
    freight: number;
    tax: number;
    tariffs: number;
    total: number;
}

export interface ChargesComparison {
    po: ChargesBreakdown;
    invoice: ChargesBreakdown;
    diffs: ChargesBreakdown;
}

export interface LineComparison {
    productId: string;
    description: string;
    poQty: number;
    poUnitPrice: number;
    receivedQty: number | null;
    invoiceQty: number;
    invoiceUnitPrice: number;
    packMultiplier?: number;
    status: "matched" | "variance" | "blocking";
}

export type MatchStatus = "match" | "possible_match" | "no_match";

export interface EnrichmentResult {
    matchStatus: MatchStatus;
    threeWayMatch: ThreeWayMatchResult | null;
    chargesComparison: ChargesComparison | null;
    lineComparison: LineComparison[];
    /** Parsed line items appended to matchedInvoice for UI consumption. */
    matchedInvoiceLineItems: Array<{ sku?: string; qty?: number; description?: string }> | null;
    matchedInvoiceRawLines: any[] | null;
}

function extractLineItems(inv: any): Array<{ sku?: string; qty?: number; description?: string }> | null {
    const rd = inv?.raw_data as Record<string, unknown> | null;
    if (rd?.lineItems && Array.isArray(rd.lineItems) && rd.lineItems.length > 0) {
        return (rd.lineItems as any[]).map((li: any) => ({
            sku: li.sku || li.productId || li.partNumber || undefined,
            qty: li.qty ?? li.quantity ?? undefined,
            description: li.description || undefined,
        }));
    }
    if (inv?.line_items) {
        try {
            const parsed = typeof inv.line_items === "string" ? JSON.parse(inv.line_items) : inv.line_items;
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map((li: any) => ({
                    sku: li.sku || li.productId || undefined,
                    qty: li.qty ?? li.quantity ?? undefined,
                    description: li.description || undefined,
                }));
            }
        } catch { /* not JSON */ }
    }
    return null;
}

/**
 * Enrich a single received PO with 3-way match, charges comparison,
 * and line-level comparison. Designed to be called in parallel for
 * each PO that has a matched invoice.
 *
 * All external clients (db, FinaleClient) are injected so the function
 * is testable and not coupled to module-level singletons.
 */
export async function enrichReceivedPO(params: {
    po: any;
    poNum: string;
    matchedInvoice: any | null;
    poLines: any[];
    invLines: any[];
    hasReceiveDate: boolean;
    receivedQtys: Record<string, number>;
    packMultipliers: Record<string, number>;
}): Promise<EnrichmentResult> {
    const { po, poNum, matchedInvoice, poLines, invLines, hasReceiveDate, receivedQtys, packMultipliers } = params;

    // Build charges comparison
    const poSubtotal = poLines.reduce(
        (sum: number, li: any) => sum + ((li.quantity ?? 0) * (li.unitPrice ?? 0)),
        0,
    );
    const poTotal = Number(po.total ?? 0);
    const invSubtotal = Number(matchedInvoice?.subtotal ?? 0);
    const invFreight = Number(matchedInvoice?.freight ?? 0);
    const invTax = Number(matchedInvoice?.tax ?? 0);
    const invTotal = Number(matchedInvoice?.total ?? invSubtotal + invFreight + invTax);

    const chargesComparison: ChargesComparison = {
        po: {
            subtotal: Math.round(poSubtotal * 100) / 100,
            freight: 0,
            tax: 0,
            tariffs: 0,
            total: poTotal,
        },
        invoice: {
            subtotal: invSubtotal,
            freight: invFreight,
            tax: invTax,
            tariffs: 0,
            total: invTotal,
        },
        diffs: {
            subtotal: Math.round((invSubtotal - poSubtotal) * 100) / 100,
            freight: invFreight,
            tax: invTax,
            tariffs: 0,
            total: Math.round((invTotal - poTotal) * 100) / 100,
        },
    };

    // Build line comparison
    const matchLines: LineComparison[] = [];

    // Identify invoice lines not on PO
    const unmatchedInvLines: any[] = [];
    for (const invLine of invLines) {
        const invSku = invLine.sku || invLine.productId || "";
        const poLine = poLines.find(
            (pl: any) =>
                (pl.productId || pl.sku || "") === invSku ||
                pl.description === invLine.description,
        );
        if (!poLine) {
            unmatchedInvLines.push(invLine);
        }
    }

    for (const poLine of poLines) {
        const sku = poLine.productId ?? poLine.sku ?? "";
        const invLine = invLines.find(
            (il: any) =>
                (il.sku || il.productId || "") === sku ||
                il.description === poLine.description,
        );
        const receivedQty = receivedQtys[sku] ?? null;
        const pack = packMultipliers[sku];

        matchLines.push({
            productId: sku,
            description: poLine.description ?? "",
            poQty: poLine.quantity ?? 0,
            poUnitPrice: poLine.unitPrice ?? 0,
            receivedQty,
            invoiceQty: invLine?.qty ?? invLine?.quantity ?? 0,
            invoiceUnitPrice: invLine?.unitPrice ?? 0,
            ...(pack ? { packMultiplier: pack } : {}),
            status: "matched",
        });
    }

    // Add invoice-only lines
    for (const invLine of unmatchedInvLines) {
        const sku = invLine.sku || invLine.productId || "";
        matchLines.push({
            productId: sku || "UNKNOWN",
            description: invLine.description ?? "",
            poQty: 0,
            poUnitPrice: 0,
            receivedQty: receivedQtys[sku] ?? null,
            invoiceQty: invLine.qty ?? invLine.quantity ?? 0,
            invoiceUnitPrice: invLine.unitPrice ?? 0,
            status: "blocking",
        });
    }

    // Run 3-way match
    const hasReceipt = hasReceiveDate || Object.values(receivedQtys).some((q) => q > 0);

    let threeWayMatch: ThreeWayMatchResult | null = null;
    let matchStatus: MatchStatus = "no_match";

    try {
        const { evaluateThreeWayMatch } = await import("./three-way-match");
        const matchResult = evaluateThreeWayMatch({
            orderId: poNum,
            hasPurchaseOrder: poLines.length > 0,
            hasReceipt,
            hasInvoice: !!matchedInvoice,
            lines: matchLines.map((l) => ({
                productId: l.productId,
                description: l.description,
                poQty: l.poQty,
                poUnitPrice: l.poUnitPrice,
                receivedQty: l.receivedQty,
                invoiceQty: l.invoiceQty,
                invoiceUnitPrice: l.invoiceUnitPrice,
                packMultiplier: l.packMultiplier,
            })),
        });

        threeWayMatch = matchResult;
        matchStatus = matchResult.canApprove ? "match" : "possible_match";

        // Derive per-line status from discrepancies
        const blockingIds = new Set(
            matchResult.discrepancies.filter((d) => d.blocking).map((d) => d.productId),
        );
        const varianceIds = new Set(
            matchResult.discrepancies.filter((d) => !d.blocking).map((d) => d.productId),
        );
        for (const ml of matchLines) {
            if (blockingIds.has(ml.productId)) {
                ml.status = "blocking";
            } else if (varianceIds.has(ml.productId)) {
                ml.status = "variance";
            }
        }
    } catch {
        matchStatus = "possible_match";
    }

    return {
        matchStatus,
        threeWayMatch,
        chargesComparison,
        lineComparison: matchLines,
        matchedInvoiceLineItems: matchedInvoice ? extractLineItems(matchedInvoice) : null,
        matchedInvoiceRawLines: invLines,
    };
}