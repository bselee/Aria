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

/**
 * What KIND of difference this is. Bill(2026-08-11): "the view needs to
 * discern shipping, taxes fees, and sku or product variences to make a
 * decision" — a $221 freight add is a different call than a $221 price hike,
 * so the UI must never lump them into one number.
 */
export type VarianceKind =
    | "freight"          // shipping / delivery charge
    | "tax"              // sales tax
    | "tariff"           // duty / tariff
    | "fee"              // surcharge, handling, minimum, pallet, etc.
    | "product_price"    // same SKU, different unit price
    | "product_qty"      // same SKU, different quantity
    | "sku_unknown"      // invoiced SKU not on the PO
    | "sku_missing"      // PO SKU never invoiced
    | "unexplained";     // totals differ but no itemized cause available

export interface VarianceItem {
    kind: VarianceKind;
    /** SKU when product-level, else a label like "Freight". */
    label: string;
    /** PO-side amount ($). */
    poAmount: number | null;
    /** Invoice-side amount ($). */
    invoiceAmount: number | null;
    /** invoice - po. Positive = we are being charged more. */
    delta: number;
    /** True when this must be resolved before completing. */
    blocking: boolean;
    /** One-line, decision-ready explanation. */
    message: string;
}

/** Roll-up so the collapsed row can show a one-glance verdict. */
export interface VarianceSummary {
    /** Sum of every delta ($). */
    netDelta: number;
    /** Per-kind dollar totals, for the collapsed chips. */
    byKind: Partial<Record<VarianceKind, number>>;
    /** True when nothing needs review. */
    clean: boolean;
    /** True when at least one item blocks completion. */
    hasBlocking: boolean;
    /** Short verdict, e.g. "Freight +$221.60" or "3 differences, +$412.10". */
    headline: string;
    items: VarianceItem[];
}

export interface EnrichmentResult {
    matchStatus: MatchStatus;
    threeWayMatch: ThreeWayMatchResult | null;
    chargesComparison: ChargesComparison | null;
    lineComparison: LineComparison[];
    /** Decision-ready variance breakdown (freight / tax / fees / SKU). */
    variance: VarianceSummary | null;
    /** Parsed line items appended to matchedInvoice for UI consumption. */
    matchedInvoiceLineItems: Array<{ sku?: string; qty?: number; description?: string }> | null;
    matchedInvoiceRawLines: any[] | null;
}

const KIND_LABEL: Record<VarianceKind, string> = {
    freight: "Freight",
    tax: "Tax",
    tariff: "Tariff",
    fee: "Fees",
    product_price: "Price",
    product_qty: "Qty",
    sku_unknown: "Unknown SKU",
    sku_missing: "Not invoiced",
    unexplained: "Unexplained",
};

/** Build the roll-up (headline + per-kind chips) from raw variance items. */
function summarizeVariance(items: VarianceItem[]): VarianceSummary {
    const byKind: Partial<Record<VarianceKind, number>> = {};
    let netDelta = 0;
    for (const it of items) {
        byKind[it.kind] = r2((byKind[it.kind] ?? 0) + it.delta);
        netDelta += it.delta;
    }
    netDelta = r2(netDelta);
    const hasBlocking = items.some((i) => i.blocking);

    // Zero-delta rows are informational context (e.g. "freight already applied"),
    // not differences — a PO carrying only those is still a clean match.
    const actionable = items.filter((i) => Math.abs(i.delta) > 0.01 || i.blocking);
    const clean = actionable.length === 0;

    let headline: string;
    if (clean) {
        headline = "No differences";
    } else if (actionable.length === 1) {
        const it = actionable[0];
        headline = `${KIND_LABEL[it.kind]} ${it.delta >= 0 ? "+" : "-"}$${Math.abs(it.delta).toFixed(2)}`;
    } else {
        const kinds = [...new Set(actionable.map((i) => i.kind))];
        const chips = kinds.map((k) => KIND_LABEL[k]).join(" + ");
        headline = `${chips} — net ${netDelta >= 0 ? "+" : "-"}$${Math.abs(netDelta).toFixed(2)}`;
    }

    return { netDelta, byKind, clean, hasBlocking, headline, items };
}

/** Round to cents. */
function r2(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * Classify every difference between a PO and its invoice into decidable
 * buckets: freight, tax, tariff, fees, product price, product qty, unknown SKU.
 *
 * Ordering matters. Charge-level differences (freight/tax/tariff) are resolved
 * FIRST and removed from the residual, so a freight-only invoice never shows up
 * as a phantom product-price variance. Whatever total difference remains after
 * lines + charges are accounted for is reported honestly as "unexplained"
 * rather than silently attributed to a category it may not belong to.
 */
function classifyVariance(args: {
    poLines: Array<{ productId: string; quantity: number; unitPrice: number; description?: string }>;
    invLines: Array<{ sku?: string; qty: number; unitPrice: number; description?: string }>;
    poSubtotal: number;
    poTotal: number;
    poAdj: { freight: number; tax: number; tariffs: number };
    invSubtotal: number;
    invFreight: number;
    invTax: number;
    invTotal: number;
    tolerancePct?: number;
    toleranceAbs?: number;
}): VarianceItem[] {
    const {
        poLines, invLines, poSubtotal, poTotal, poAdj,
        invSubtotal, invFreight, invTax, invTotal,
    } = args;
    const tolPct = args.tolerancePct ?? 0.02;
    const tolAbs = args.toleranceAbs ?? 1.0;
    const items: VarianceItem[] = [];

    const material = (d: number, base: number) =>
        Math.abs(d) > tolAbs && (base <= 0 || Math.abs(d) / base > tolPct);

    // ── 0. Freight-only invoice ───────────────────────────────────────────────
    // HERMIA(2026-08-11): carrier bills (FedEx/LTL) get attached to the goods PO
    // by the matcher. Those have freight == total and no goods lines. Treating
    // them as a variance produced nonsense: PO 125057 reported BOTH "freight
    // +$363.95" AND "unexplained -$30,365.40" for the same $363.95 carrier bill,
    // double-counting one document. A freight-only invoice is a CLASSIFICATION,
    // not a price discrepancy — report it once and stop.
    const invBase0 = invTotal > 0 ? invTotal : invSubtotal;
    const freightIsWholeInvoice =
        invFreight > 0
        && invBase0 > 0
        && Math.abs(invFreight - invBase0) <= 0.02
        && invLines.length === 0;

    if (freightIsWholeInvoice) {
        const delta = r2(invFreight - poAdj.freight);
        // Freight already applied to the PO at this amount → this document is
        // settled, not a variance. reconcile-billtrust-freight / -ltlselect
        // write it under productpromo/10007 ahead of receivings review.
        if (Math.abs(delta) <= 0.02) {
            return [{
                kind: "freight",
                label: "Freight-only invoice",
                poAmount: poAdj.freight,
                invoiceAmount: invFreight,
                delta: 0,
                blocking: false,
                message: `Freight-only invoice — $${invFreight.toFixed(2)} already applied to this PO. Nothing to do; it does not settle the $${(poSubtotal > 0 ? poSubtotal : poTotal).toFixed(2)} of goods.`,
            }];
        }
        return [{
            kind: "freight",
            label: "Freight-only invoice",
            poAmount: poAdj.freight || null,
            invoiceAmount: invFreight,
            delta,
            blocking: false,
            message: poAdj.freight > 0
                ? `Freight-only invoice — $${invFreight.toFixed(2)} carrier charge vs $${poAdj.freight.toFixed(2)} already on the PO (${delta >= 0 ? "+" : "-"}$${Math.abs(delta).toFixed(2)}).`
                : `Freight-only invoice — $${invFreight.toFixed(2)} carrier charge, no goods billed and no freight yet on the PO. Apply as freight; it does not settle the $${(poSubtotal > 0 ? poSubtotal : poTotal).toFixed(2)} of goods.`,
        }];
    }

    // ── 1. Freight ────────────────────────────────────────────────────────────
    // Only meaningful when the invoice actually itemizes a freight figure.
    // HERMIA(2026-08-11): most BAS invoices are OCR/photo captures that store
    // freight: 0 while the freight is baked into the total. Comparing that 0
    // against real PO freight produced nonsense — PO 125101 reported "Freight
    // $0.00 invoiced vs $5200.00 on PO (-$5200.00)" AND a +$4730 unexplained
    // line for the same document. When the invoice reports no freight we cannot
    // conclude the vendor didn't charge it, so stay silent and let the
    // goods-level comparison below carry the signal.
    const invoiceItemizesFreight = invFreight > 0;
    const freightDelta = invoiceItemizesFreight ? r2(invFreight - poAdj.freight) : 0;
    if (invoiceItemizesFreight && Math.abs(freightDelta) > 0.01) {
        items.push({
            kind: "freight",
            label: "Freight",
            poAmount: poAdj.freight,
            invoiceAmount: invFreight,
            delta: freightDelta,
            // Freight added by the vendor is expected on many orders — surface,
            // don't block. BAS-paid COLLECT freight is reconciled separately.
            blocking: false,
            message: poAdj.freight > 0
                ? `Freight $${invFreight.toFixed(2)} invoiced vs $${poAdj.freight.toFixed(2)} on PO (${freightDelta >= 0 ? "+" : "-"}$${Math.abs(freightDelta).toFixed(2)}).`
                : `Freight $${invFreight.toFixed(2)} invoiced — none on PO.`,
        });
    }

    // ── 2. Tax ────────────────────────────────────────────────────────────────
    const taxDelta = r2(invTax - poAdj.tax);
    if (Math.abs(taxDelta) > 0.01) {
        items.push({
            kind: "tax",
            label: "Tax",
            poAmount: poAdj.tax,
            invoiceAmount: invTax,
            delta: taxDelta,
            blocking: false,
            message: poAdj.tax > 0
                ? `Tax $${invTax.toFixed(2)} invoiced vs $${poAdj.tax.toFixed(2)} on PO.`
                : `Tax $${invTax.toFixed(2)} invoiced — none on PO.`,
        });
    }

    // ── 3. Tariff / duty ──────────────────────────────────────────────────────
    if (Math.abs(poAdj.tariffs) > 0.01) {
        items.push({
            kind: "tariff",
            label: "Tariff",
            poAmount: poAdj.tariffs,
            invoiceAmount: null,
            delta: r2(-poAdj.tariffs),
            blocking: false,
            message: `PO carries $${poAdj.tariffs.toFixed(2)} tariff/duty not itemized on the invoice.`,
        });
    }

    // ── 4. Per-SKU price and quantity ─────────────────────────────────────────
    const invBySku = new Map<string, { qty: number; unitPrice: number; description?: string }>();
    for (const il of invLines) {
        const k = String(il.sku ?? "").trim().toUpperCase();
        if (!k) continue;
        const prev = invBySku.get(k);
        if (prev) {
            prev.qty += il.qty;
        } else {
            invBySku.set(k, { qty: il.qty, unitPrice: il.unitPrice, description: il.description });
        }
    }

    const matchedInvKeys = new Set<string>();
    let goodsAccounted = 0;

    for (const pl of poLines) {
        const key = String(pl.productId ?? "").trim().toUpperCase();
        const il = invBySku.get(key);
        if (!il) {
            // PO line the invoice never billed. Only worth surfacing when the
            // invoice DOES have itemized lines — otherwise it's just "no lines".
            if (invLines.length > 0) {
                items.push({
                    kind: "sku_missing",
                    label: pl.productId,
                    poAmount: r2(pl.quantity * pl.unitPrice),
                    invoiceAmount: null,
                    delta: 0,
                    blocking: false,
                    message: `${pl.productId}: on PO (${pl.quantity} @ $${pl.unitPrice.toFixed(2)}) but not on this invoice.`,
                });
            }
            continue;
        }
        matchedInvKeys.add(key);
        goodsAccounted += il.qty * il.unitPrice;

        // Quantity
        const qtyDelta = il.qty - pl.quantity;
        if (Math.abs(qtyDelta) > 0.001) {
            const overBilled = qtyDelta > 0;
            items.push({
                kind: "product_qty",
                label: pl.productId,
                poAmount: pl.quantity,
                invoiceAmount: il.qty,
                delta: r2(qtyDelta * pl.unitPrice),
                // Billing for MORE than ordered is the cardinal AP block.
                blocking: overBilled,
                message: `${pl.productId}: invoiced ${il.qty} vs ${pl.quantity} on PO (${overBilled ? "over" : "under"} by ${Math.abs(qtyDelta)}).`,
            });
        }

        // Unit price
        const priceDelta = r2(il.unitPrice - pl.unitPrice);
        if (material(priceDelta, pl.unitPrice)) {
            const pct = pl.unitPrice > 0 ? (priceDelta / pl.unitPrice) * 100 : 100;
            items.push({
                kind: "product_price",
                label: pl.productId,
                poAmount: pl.unitPrice,
                invoiceAmount: il.unitPrice,
                delta: r2(priceDelta * (il.qty || pl.quantity)),
                // Price INCREASE beyond tolerance blocks; a decrease is a win.
                blocking: priceDelta > 0,
                message: `${pl.productId}: $${il.unitPrice.toFixed(2)}/unit invoiced vs $${pl.unitPrice.toFixed(2)} on PO (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%).`,
            });
        }
    }

    // ── 5. Invoiced SKUs that aren't on the PO ────────────────────────────────
    for (const [key, il] of invBySku) {
        if (matchedInvKeys.has(key)) continue;
        const ext = r2(il.qty * il.unitPrice);
        goodsAccounted += ext;
        items.push({
            kind: "sku_unknown",
            label: il.description ? `${key} (${il.description})` : key,
            poAmount: null,
            invoiceAmount: ext,
            delta: ext,
            // Could be a legitimate alias (e.g. TX7101 vs TX70-CaseQt) — needs eyes.
            blocking: true,
            message: `${key}: invoiced ${il.qty} @ $${il.unitPrice.toFixed(2)} = $${ext.toFixed(2)} but not present on the PO. Check for a SKU alias or an unauthorized add.`,
        });
    }

    // ── 6. Residual ───────────────────────────────────────────────────────────
    // Anything the itemized breakdown above cannot account for. Reported as
    // "unexplained" rather than guessed at.
    const poBase = poSubtotal > 0 ? poSubtotal : poTotal;
    const invBase = invTotal > 0 ? invTotal : invSubtotal;

    if (invLines.length === 0) {
        // No itemized invoice lines: totals are the only honest comparison.
        // Choose the PO baseline that matches what the invoice total represents.
        // If the invoice itemizes freight, its total includes freight, so compare
        // against PO goods + PO freight. If it doesn't, we can't tell whether the
        // total includes freight — compare goods-to-goods and say so.
        const poBaseline = invoiceItemizesFreight
            ? r2(poBase + poAdj.freight)
            : poBase;
        const residual = r2(invBase - poBaseline - freightDelta);
        if (material(residual, poBaseline)) {
            const caveat = !invoiceItemizesFreight && poAdj.freight > 0
                ? ` PO also carries $${poAdj.freight.toFixed(2)} freight; the invoice does not itemize freight, so it's unclear whether its total includes any.`
                : "";
            items.push({
                kind: "unexplained",
                label: "Order total",
                poAmount: r2(poBaseline),
                invoiceAmount: r2(invBase),
                delta: residual,
                blocking: false,
                message: `Goods differ by ${residual >= 0 ? "+" : "-"}$${Math.abs(residual).toFixed(2)} — invoice $${invBase.toFixed(2)} vs PO $${poBaseline.toFixed(2)}. Invoice has no itemized lines, so the cause can't be attributed automatically.${caveat}`,
            });
        }
    } else {
        // Lines exist: check the invoice total against goods + freight + tax.
        // Freight is only additive when the invoice total EXCEEDS the goods it
        // itemized; on many invoices (e.g. American Extracts SF4474) subtotal
        // already includes freight, and adding it again invented a phantom fee.
        const freightIsAdditive = invBase > r2(goodsAccounted + invTax) + 0.02;
        const reconstructed = r2(goodsAccounted + invTax + (freightIsAdditive ? invFreight : 0));
        const residual = r2(invBase - reconstructed);
        if (material(residual, invBase)) {
            items.push({
                kind: "fee",
                label: "Unitemized charges",
                poAmount: null,
                invoiceAmount: residual,
                delta: residual,
                blocking: false,
                message: `$${Math.abs(residual).toFixed(2)} on the invoice total is not explained by line items + freight + tax — likely a surcharge, handling, or minimum-order fee.`,
            });
        }
    }

    // ── 7. PO freight context ─────────────────────────────────────────────────
    // Freight already applied to the PO with nothing to compare against on the
    // invoice side. Zero delta, purely informational — it tells you freight is
    // handled so you don't go hunting for a missing carrier bill.
    if (!invoiceItemizesFreight && poAdj.freight > 0.01) {
        items.push({
            kind: "freight",
            label: "Freight (on PO)",
            poAmount: poAdj.freight,
            invoiceAmount: null,
            delta: 0,
            blocking: false,
            message: `$${poAdj.freight.toFixed(2)} freight already applied to this PO. This invoice does not itemize freight separately.`,
        });
    }

    return items;
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

    // Build charges comparison.
    // Prefer Finale's own subtotal (goods-only, adjustment-free) and fall back to
    // reconstructing it from line items only when GraphQL didn't supply it.
    const poLineSum = poLines.reduce(
        (sum: number, li: any) => sum + ((li.quantity ?? 0) * (li.unitPrice ?? 0)),
        0,
    );
    const poSubtotal = Number(po.subtotal ?? 0) > 0 ? Number(po.subtotal) : poLineSum;
    const poTotal = Number(po.total ?? 0);
    const invSubtotal = Number(matchedInvoice?.subtotal ?? 0);
    const invFreight = Number(matchedInvoice?.freight ?? 0);
    const invTax = Number(matchedInvoice?.tax ?? 0);
    const invTotal = Number(matchedInvoice?.total ?? invSubtotal + invFreight + invTax);

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

    // ── Classify every difference into decidable buckets ──────────────────────
    // Bill(2026-08-11): "The view needs to discern shipping, taxes fees, and
    // sku or product variences to make a decision." One net dollar number is
    // not actionable — the caller needs to know WHICH bucket moved.
    const varianceItems = matchedInvoice
        ? classifyVariance({
            poLines: poLines.map((l: any) => ({
                productId: String(l.productId ?? ""),
                quantity: Number(l.quantity ?? 0),
                unitPrice: Number(l.unitPrice ?? 0),
                description: l.description,
            })),
            invLines: invLines.map((l: any) => ({
                sku: l.sku ?? l.productId,
                qty: Number(l.qty ?? l.quantity ?? 0),
                unitPrice: Number(l.unitPrice ?? l.unit_price ?? 0),
                description: l.description,
            })),
            poSubtotal, poTotal, poAdj,
            invSubtotal, invFreight, invTax, invTotal,
        })
        : [];
    const variance = matchedInvoice ? summarizeVariance(varianceItems) : null;

    // Run 3-way match
    const hasReceipt = hasReceiveDate || Object.values(receivedQtys).some((q) => q > 0);

    let threeWayMatch: ThreeWayMatchResult | null = null;
    let matchStatus: MatchStatus = "no_match";

    // ── Total-only comparison when the invoice has no extracted lines ─────────
    // HERMIA(2026-08-11): most invoices are photo/OCR captures where only the
    // TOTAL was extracted (line_items: []). Feeding those into the line-level
    // gate produced a false "100% price variance" on every line, because every
    // invoiceUnitPrice was 0. When there are no invoice lines, lean on the
    // classifier's bucketed result instead of the line gate.
    const invoiceHasLines = invLines.length > 0
        && invLines.some((l: any) => Number(l.qty ?? l.quantity ?? 0) > 0);

    if (matchedInvoice && !invoiceHasLines) {
        const v = variance!;
        matchStatus = v.clean ? "match" : "possible_match";
        threeWayMatch = {
            orderId: poNum,
            verdict: v.clean ? "matched" : v.hasBlocking ? "exception" : "variance",
            canApprove: v.clean,
            missingLegs: [],
            discrepancies: v.items.map((it) => ({
                productId: it.label,
                kind: it.kind === "product_qty" ? "qty_over_billed" : "price_variance",
                blocking: it.blocking,
                dollarImpact: Math.abs(it.delta),
                message: it.message,
            })) as any,
            totalDollarImpact: Math.abs(v.netDelta),
            summary: v.clean
                ? `Totals agree ($${(invTotal || invSubtotal).toFixed(2)}) — no itemized invoice lines, matched on total.`
                : v.headline,
        };
        for (const ml of matchLines) ml.status = "matched";

        return {
            matchStatus,
            threeWayMatch,
            chargesComparison,
            lineComparison: matchLines,
            variance,
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
        variance,
        matchedInvoiceLineItems: matchedInvoice ? extractLineItems(matchedInvoice) : null,
        matchedInvoiceRawLines: invLines,
    };
}