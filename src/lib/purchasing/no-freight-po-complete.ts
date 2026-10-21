/**
 * @file    no-freight-po-complete.ts
 * @purpose Complete Finale POs that are still Committed after receipt when the
 *          vendor has no history of freight that needs attaching, and the
 *          matched invoice goods total lines up with the PO.
 *
 *          Separate from po-auto-complete.ts. That watcher is off
 *          (PO_AUTO_COMPLETE_ENABLED) and only sees Active Purchases, which
 *          drops high-confidence received POs. Do not flip that flag. Freight
 *          vendors still wait on a carrier Freight line.
 *
 *          Live writes require NO_FREIGHT_PO_COMPLETE_ENABLED or an explicit
 *          CLI --live. Default is dry-run.
 *
 * @author  Hermia
 * @created 2026-09-28
 * @deps    db, finale/client, vendor-freight-pattern, po-receipt-state
 * @env     NO_FREIGHT_PO_COMPLETE_ENABLED — "true"|"1"|"on" allows the cron
 *          to call completeOrder. Unset = dry-run.
 */

import { createClient } from "../db";
import { hasPurchaseOrderReceipt } from "./po-receipt-state";
import {
    classifyVendorFreightPattern,
    noFreightOverrideMatchers,
    type PatternEvidence,
    type VendorFreightPatternResult,
} from "./vendor-freight-pattern";

/** Penny rounding. A dollar off is not aligned. */
export const AMOUNT_ALIGN_TOLERANCE = 0.5;
/** Below this, treat a freight figure as OCR noise, not a bill to attach. */
export const FREIGHT_NOISE = 0.5;

const UNUSABLE_INVOICE_STATUSES = new Set(["rejected", "disregarded", "void", "voided"]);

export type NoFreightEligibility =
    | { eligible: true; pattern: VendorFreightPatternResult; invoiceGoods: number; poGoodsTotal: number }
    | { eligible: false; reason: string; pattern: VendorFreightPatternResult | null };

export interface NoFreightInvoice {
    invoiceNumber: string | null;
    status: string | null;
    subtotal: number;
    freight: number;
    tax: number;
    total: number;
}

export interface NoFreightPOInput {
    orderId: string;
    vendorName: string;
    /** Finale statusId. Committed is ORDER_LOCKED. */
    finaleStatusId: string;
    /** Caller decided receipt. A past receiveDate is not enough. */
    finaleReceived: boolean;
    /** Ordered units across goods lines. When set with receivedQty, short units hold. */
    orderedQty?: number | null;
    /** Units on non-cancelled shipments. Null means we could not see them. */
    receivedQty?: number | null;
    poGoodsTotal: number;
    poFreightAmount: number;
    invoices: NoFreightInvoice[];
}

export function noFreightCompleteEnabled(): boolean {
    const v = (process.env.NO_FREIGHT_PO_COMPLETE_ENABLED ?? "false").toLowerCase();
    return v === "true" || v === "1" || v === "on";
}

export function invoiceGoodsAmount(inv: NoFreightInvoice): number {
    if (inv.subtotal > 0) return inv.subtotal;
    const derived = inv.total - inv.freight - inv.tax;
    return derived > 0 ? derived : 0;
}

/** True when any prior PO had freight on the invoice or on the PO. */
export function vendorHasFreightAttachHistory(evidence: PatternEvidence[]): boolean {
    return evidence.some(ev => ev.invoiceFreight > FREIGHT_NOISE || ev.hadFreightOnPO);
}

function usableInvoices(invoices: NoFreightInvoice[]): NoFreightInvoice[] {
    const seen = new Set<string>();
    const out: NoFreightInvoice[] = [];
    for (const inv of invoices) {
        const status = (inv.status || "").toLowerCase();
        if (UNUSABLE_INVOICE_STATUSES.has(status)) continue;
        if (invoiceGoodsAmount(inv) <= 0) continue;
        const number = (inv.invoiceNumber || "").replace(/,/g, "").trim();
        if (number) {
            const key = `${number}|${inv.total.toFixed(2)}`;
            if (seen.has(key)) continue;
            seen.add(key);
        }
        out.push(inv);
    }
    return out;
}

/**
 * Pure close gate for a committed, received, no-freight PO.
 * Amounts must align. A freight figure on this invoice or PO always holds.
 */
export function checkNoFreightCompleteEligibility(
    po: NoFreightPOInput,
    evidence: PatternEvidence[] = [],
): NoFreightEligibility {
    if (/dropship/i.test(po.orderId)) {
        return { eligible: false, reason: "dropship PO", pattern: null };
    }

    if (po.finaleStatusId === "ORDER_COMPLETED") {
        return { eligible: false, reason: "already ORDER_COMPLETED", pattern: null };
    }
    if (po.finaleStatusId !== "ORDER_LOCKED") {
        return {
            eligible: false,
            reason: `finale status ${po.finaleStatusId || "missing"} is not committed`,
            pattern: null,
        };
    }

    const pattern = classifyVendorFreightPattern(po.vendorName, evidence);
    if (pattern.pattern !== "no_freight" || pattern.confidence !== "high") {
        return {
            eligible: false,
            reason: `vendor pattern ${pattern.pattern} confidence=${pattern.confidence} source=${pattern.source}`,
            pattern,
        };
    }
    // Override vendors (Miles, Thrive, Stock Bag, Colorado Worm) are confirmed
    // no-freight even if one old OCR row has a stray freight figure. A learned
    // pattern is not: any freight-attach history holds the vendor.
    if (pattern.source !== "override" && vendorHasFreightAttachHistory(evidence)) {
        return {
            eligible: false,
            reason: "history includes freight that needed attaching",
            pattern,
        };
    }

    if (po.orderedQty != null && po.orderedQty > 0) {
        if (po.receivedQty == null) {
            return { eligible: false, reason: "cannot confirm full receipt from shipments", pattern };
        }
        if (po.receivedQty + 0.001 < po.orderedQty) {
            return {
                eligible: false,
                reason: `not fully received (${po.receivedQty} of ${po.orderedQty})`,
                pattern,
            };
        }
    } else if (!po.finaleReceived) {
        return { eligible: false, reason: "not Finale-received", pattern };
    }

    if (po.poFreightAmount > FREIGHT_NOISE) {
        return {
            eligible: false,
            reason: `PO already has freight $${po.poFreightAmount.toFixed(2)}`,
            pattern,
        };
    }

    const invoices = usableInvoices(po.invoices);
    if (invoices.length === 0) {
        return { eligible: false, reason: "no matched invoice with a usable total", pattern };
    }

    const invoiceFreight = invoices.reduce((s, inv) => s + (inv.freight > 0 ? inv.freight : 0), 0);
    if (invoiceFreight > FREIGHT_NOISE) {
        return {
            eligible: false,
            reason: `invoice shipping/freight $${invoiceFreight.toFixed(2)} is not on the PO`,
            pattern,
        };
    }

    if (!(po.poGoodsTotal > 0)) {
        return { eligible: false, reason: "PO goods total is zero", pattern };
    }

    const invoiceGoods = invoices.reduce((s, inv) => s + invoiceGoodsAmount(inv), 0);
    const delta = invoiceGoods - po.poGoodsTotal;
    if (Math.abs(delta) > AMOUNT_ALIGN_TOLERANCE) {
        const side = delta < 0 ? "short" : "over";
        return {
            eligible: false,
            reason: `amounts ${side} by $${Math.abs(delta).toFixed(2)} (invoice $${invoiceGoods.toFixed(2)} vs PO $${po.poGoodsTotal.toFixed(2)})`,
            pattern,
        };
    }

    return { eligible: true, pattern, invoiceGoods, poGoodsTotal: po.poGoodsTotal };
}

export function poGoodsTotalFromOrder(po: {
    orderItemListTotal?: number | string | null;
    orderItemList?: Array<{ quantity?: number | string | null; unitPrice?: number | string | null }>;
}): number {
    const header = Number(po.orderItemListTotal);
    if (Number.isFinite(header) && header > 0) return header;
    return (po.orderItemList || []).reduce((sum, item) => {
        return sum + (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
    }, 0);
}

export function poFreightFromAdjustments(
    adjustments: Array<{ productPromoUrl?: string; description?: string; amount?: number | string | null }> | undefined,
): number {
    return (adjustments || [])
        .filter(adj => {
            const url = String(adj.productPromoUrl || "");
            const desc = String(adj.description || "").toLowerCase();
            return url.endsWith("/productpromo/10007") || desc.includes("freight");
        })
        .reduce((sum, adj) => sum + (Number(adj.amount) || 0), 0);
}

export function shipmentReceiptQty(
    orderItems: Array<{ productId?: string | null; quantity?: number | string | null }> | undefined,
    shipments: Array<{ statusId?: string | null; shipmentItemList?: Array<{ productId?: string | null; quantity?: number | string | null }> }>,
): { ordered: number; received: number; complete: boolean } {
    const orderedBy = new Map<string, number>();
    for (const item of orderItems || []) {
        const id = String(item.productId || "").trim();
        const qty = Number(item.quantity) || 0;
        if (!id || qty <= 0) continue;
        orderedBy.set(id, (orderedBy.get(id) || 0) + qty);
    }
    const receivedBy = new Map<string, number>();
    for (const shipment of shipments) {
        if (String(shipment.statusId || "").toUpperCase() === "SHIPMENT_CANCELLED") continue;
        for (const line of shipment.shipmentItemList || []) {
            const id = String(line.productId || "").trim();
            const qty = Number(line.quantity) || 0;
            if (!id || qty <= 0) continue;
            receivedBy.set(id, (receivedBy.get(id) || 0) + qty);
        }
    }
    let ordered = 0;
    let received = 0;
    let complete = orderedBy.size > 0;
    for (const [id, qty] of orderedBy) {
        ordered += qty;
        const got = receivedBy.get(id) || 0;
        received += Math.min(got, qty);
        if (got + 0.001 < qty) complete = false;
    }
    return { ordered, received, complete };
}

export function finaleReceivedFromOrder(
    po: {
        statusId?: string | null;
        receiveDate?: string | null;
        orderDate?: string | null;
        shipmentUrlList?: string[];
    },
    shipments: Array<{ statusId?: string | null; status?: string | null; receiveDate?: string | null }> = [],
): boolean {
    const live = shipments
        .filter(s => String(s.statusId || s.status || "").toUpperCase() !== "SHIPMENT_CANCELLED")
        .map(s => ({
            status: s.status || s.statusId || null,
            receiveDate: s.receiveDate || null,
        }));
    return hasPurchaseOrderReceipt({
        status: po.statusId === "ORDER_LOCKED" ? "committed" : po.statusId,
        receiveDate: po.receiveDate || null,
        orderDate: po.orderDate || null,
        shipments: live,
    });
}

export interface NoFreightRunStats {
    scanned: number;
    eligible: number;
    completed: number;
    skipped: number;
    errors: number;
    dryRun: boolean;
    lines: string[];
}

export interface NoFreightRunOptions {
    /** Force a Finale write for this invocation. Cron leaves this false and uses the env flag. */
    live?: boolean;
    /** Cap Finale reads. Default 30. */
    limit?: number;
    orderId?: string;
}

function supplierName(po: { orderRoleList?: Array<{ roleTypeId?: string; partyName?: string }> }, fallback: string): string {
    const role = (po.orderRoleList || []).find(r => r.roleTypeId === "SUPPLIER");
    const name = role?.partyName?.trim();
    return name || fallback;
}

/**
 * Scan committed no-freight vendors and complete the ones whose receipt and
 * invoice goods already line up. Dry-run unless live or the env flag is on.
 */
export async function runNoFreightPOComplete(opts: NoFreightRunOptions = {}): Promise<NoFreightRunStats> {
    const actuallyLive = opts.live === true || (opts.live === undefined && noFreightCompleteEnabled());
    const stats: NoFreightRunStats = {
        scanned: 0,
        eligible: 0,
        completed: 0,
        skipped: 0,
        errors: 0,
        dryRun: !actuallyLive,
        lines: [],
    };

    const sb = createClient();
    if (!sb) {
        stats.lines.push("db unavailable");
        return stats;
    }

    const matchers = noFreightOverrideMatchers();
    const orFilter = matchers.map(m => `vendor_name.ilike.*${m}*`).join(",");
    let query = sb
        .from("purchase_orders")
        .select("po_number,vendor_name,status,lifecycle_stage,receive_date,issue_date")
        .or(orFilter)
        .in("status", ["open", "received"])
        .order("issue_date", { ascending: false })
        .limit(200);
    if (opts.orderId) {
        query = sb
            .from("purchase_orders")
            .select("po_number,vendor_name,status,lifecycle_stage,receive_date,issue_date")
            .eq("po_number", opts.orderId)
            .limit(1);
    }
    const { data, error } = await query;
    if (error) {
        stats.errors++;
        stats.lines.push(`candidate query failed: ${error.message || error}`);
        return stats;
    }

    const rows = ((data || []) as Array<{
        po_number: string;
        vendor_name: string | null;
        status: string | null;
        lifecycle_stage: string | null;
    }>).filter(row => {
        const stage = String(row.lifecycle_stage || "").toUpperCase();
        return stage !== "COMPLETED" && stage !== "CANCELLED";
    });

    const cap = opts.limit ?? 30;
    const candidates = rows.slice(0, cap);
    stats.scanned = candidates.length;

    const { finaleClient } = await import("../finale/client");

    for (const row of candidates) {
        const orderId = row.po_number;
        const vendorName = row.vendor_name || "";
        try {
            const details = await finaleClient.getOrderDetails(orderId);
            const shipments: Array<{ statusId?: string; shipmentItemList?: Array<{ productId?: string; quantity?: number }> }> = [];
            for (const url of (details.shipmentUrlList || []).slice(0, 15)) {
                try {
                    shipments.push(await finaleClient.get(url));
                } catch {
                    // A missing shipment is not receipt proof.
                }
            }
            const qty = shipmentReceiptQty(details.orderItemList, shipments);
            const received = qty.complete;
            const { data: invRows, error: invErr } = await sb
                .from("vendor_invoices")
                .select("invoice_number,status,subtotal,freight,tax,total")
                .eq("po_number", orderId)
                .limit(20);
            if (invErr) throw new Error(invErr.message || "invoice query failed");

            const invoices: NoFreightInvoice[] = ((invRows || []) as Array<Record<string, unknown>>).map(inv => ({
                invoiceNumber: inv.invoice_number == null ? null : String(inv.invoice_number),
                status: inv.status == null ? null : String(inv.status),
                subtotal: Number(inv.subtotal) || 0,
                freight: Number(inv.freight) || 0,
                tax: Number(inv.tax) || 0,
                total: Number(inv.total) || 0,
            }));

            const dbHasGoods = invoices.some(inv => inv.subtotal > 0 || inv.total > 0);
            if (!dbHasGoods && String(details.statusId || "") === "ORDER_LOCKED") {
                const { findGmailInvoicesForPo } = await import("./no-freight-gmail-invoices");
                const poLineTotals = (details.orderItemList || []).map((item: { quantity?: number; unitPrice?: number }) =>
                    (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0),
                ).filter((n: number) => n > 0);
                const gmailInvoices = await findGmailInvoicesForPo({
                    orderId,
                    vendorName,
                    orderDate: details.orderDate || null,
                    poLineTotals,
                });
                invoices.push(...gmailInvoices);
            }

            const elig = checkNoFreightCompleteEligibility(
                {
                    orderId,
                    vendorName: vendorName || supplierName(details, ""),
                    finaleStatusId: String(details.statusId || ""),
                    finaleReceived: received,
                    orderedQty: qty.ordered,
                    receivedQty: shipments.length > 0 || qty.ordered === 0 ? qty.received : null,
                    poGoodsTotal: poGoodsTotalFromOrder(details),
                    poFreightAmount: poFreightFromAdjustments(details.orderAdjustmentList),
                    invoices,
                },
                [],
            );

            if (!elig.eligible) {
                stats.skipped++;
                if (elig.reason === "already ORDER_COMPLETED") continue;
                const line = `HOLD ${orderId} (${vendorName}): ${elig.reason}`;
                stats.lines.push(line);
                console.log(`[no-freight-complete] ${line}`);
                continue;
            }

            stats.eligible++;
            const summary =
                `${actuallyLive ? "COMPLETE" : "WOULD COMPLETE"} ${orderId} (${vendorName}) ` +
                `invoice $${elig.invoiceGoods.toFixed(2)} = PO $${elig.poGoodsTotal.toFixed(2)}`;
            stats.lines.push(summary);
            console.log(`[no-freight-complete] ${summary}`);

            if (!actuallyLive) continue;

            await finaleClient.completeOrder(orderId);
            stats.completed++;
            try {
                await sb.from("ap_activity_log").insert({
                    email_from: vendorName,
                    email_subject: `PO ${orderId} no-freight completed`,
                    intent: "NO_FREIGHT_PO_COMPLETED",
                    action_taken: `Completed committed received PO #${orderId} from ${vendorName} — no freight to attach, amounts aligned`,
                    metadata: {
                        poId: orderId,
                        vendorName,
                        pattern: "no_freight",
                        invoiceGoods: elig.invoiceGoods,
                        poGoodsTotal: elig.poGoodsTotal,
                    },
                });
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.warn(`[no-freight-complete] PO ${orderId} completed but activity write failed: ${message}`);
            }
        } catch (err: unknown) {
            stats.errors++;
            const message = err instanceof Error ? err.message : String(err);
            const line = `ERROR ${orderId} (${vendorName}): ${message}`;
            stats.lines.push(line);
            console.error(`[no-freight-complete] ${line}`);
        }
    }

    return stats;
}
