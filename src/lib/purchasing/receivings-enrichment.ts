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
    poAdjustments?: { freight: number; tax: number; tariffs: number };
}): Promise<EnrichmentResult> {
    const { po, poNum, matchedInvoice, poLines, invLines, hasReceiveDate, receivedQtys, packMultipliers } = params;
    const poAdj = params.poAdjustments ?? { freight: 0, tax: 0, tariffs: 0 };

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

    const r2 = (n: number) => Math.round(n * 100) / 100;

    const chargesComparison: ChargesComparison = {
        po: {
            subtotal: r2(poSubtotal),
            freight: r2(poAdj.freight),
            tax: r2(poAdj.tax),
            tariffs: r2(poAdj.tariffs),
            total: r2(poTotal),
        },
        invoice: {
            subtotal: r2(invSubtotal),
            freight: r2(invFreight),
            tax: r2(invTax),
            tariffs: 0,
            total: r2(invTotal),
        },
        diffs: {
            subtotal: r2(invSubtotal - poSubtotal),
            freight: r2(invFreight - poAdj.freight),
            tax: r2(invTax - poAdj.tax),
            tariffs: r2(0 - poAdj.tariffs),
            total: r2(invTotal - poTotal),
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

    // ── Total-only comparison when the invoice has no extracted lines ─────────
    // HERMIA(2026-08-11): most invoices are photo/OCR captures where only the
    // TOTAL was extracted (line_items: []). Feeding those into the line-level
    // gate produced a false "100% price variance" on every line, because every
    // invoiceUnitPrice was 0. When there are no invoice lines, compare the one
    // number we actually have — invoice total vs PO total — and say so plainly.
    const invoiceHasLines = invLines.length > 0
        && invLines.some((l: any) => Number(l.qty ?? l.quantity ?? 0) > 0);

    if (matchedInvoice && !invoiceHasLines) {
        const poCompare = poSubtotal > 0 ? poSubtotal : poTotal;
        const invCompare = invTotal > 0 ? invTotal : invSubtotal;
        const delta = r2(invCompare - poCompare);
        const pct = poCompare > 0 ? Math.abs(delta) / poCompare : 1;
        // 2% band mirrors DEFAULT_TOLERANCES.pricePct
        const withinTolerance = poCompare > 0 && pct <= 0.02;

        matchStatus = withinTolerance ? "match" : "possible_match";
        threeWayMatch = {
            orderId: poNum,
            verdict: withinTolerance ? "matched" : "variance",
            canApprove: withinTolerance,
            missingLegs: [],
            discrepancies: withinTolerance ? [] : [{
                productId: "(order total)",
                kind: "price_variance",
                blocking: false,
                dollarImpact: Math.abs(delta),
                message: `Invoice total $${invCompare.toFixed(2)} vs PO total $${poCompare.toFixed(2)} — ${delta > 0 ? "over" : "under"} by $${Math.abs(delta).toFixed(2)} (${(pct * 100).toFixed(1)}%). Invoice has no itemized lines; compared on totals only.`,
            }],
            totalDollarImpact: withinTolerance ? 0 : Math.abs(delta),
            summary: withinTolerance
                ? `Totals agree ($${invCompare.toFixed(2)}) — no itemized invoice lines, matched on total.`
                : `Total differs by $${Math.abs(delta).toFixed(2)} (${(pct * 100).toFixed(1)}%) — invoice $${invCompare.toFixed(2)} vs PO $${poCompare.toFixed(2)}. No itemized invoice lines.`,
        };
        // Leave per-line rows informational — no invoice side to compare against
        for (const ml of matchLines) ml.status = "matched";

        return {
            matchStatus,
            threeWayMatch,
            chargesComparison,
            lineComparison: matchLines,
            matchedInvoiceLineItems: extractLineItems(matchedInvoice),
            matchedInvoiceRawLines: invLines,
        };
    }

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