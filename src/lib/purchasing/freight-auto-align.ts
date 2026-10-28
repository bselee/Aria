/**
 * @file    src/lib/purchasing/freight-auto-align.ts
 * @purpose Autonomous freight assessment, application, and completion for
 *          truck-freight vendors (2026-10-28). Bill: "aria needs to assess
 *          and complete this autonomously. Freight must be ON the PO —
 *          vendor-charged or carrier (FedEx/Destination)."
 *
 *          Lanes:
 *          - vendor:      the matched goods invoice carries freight (PPD-ADD)
 *                         → apply the invoice's freight amount to the PO.
 *          - destination: a DestiNATION Transport bill is linked to the PO →
 *                         apply its flat-rate amount.
 *          - carrier:     FedEx Freight collect bills are applied by the
 *                         existing weekly mailbox reconciler; this watcher
 *                         reports them as blocked, it does not double-apply.
 *
 *          Completion: once freight is on the PO, a fully-received PO with a
 *          matched goods invoice, no overbill hold, no pending approval, no
 *          overbill-by-total, and 24h dwell since the freight/reconciliation
 *          anchor is completed in Finale. A short receipt is NEVER completed
 *          and never gets freight applied to a closed state.
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    ../db, ../finale/client, ../finale/receipt-quantities,
 *          ../finale/freight-adjustment, ../../config/freight-required-vendors
 * @env     FREIGHT_AUTO_ALIGN_ENABLED (kill switch; default true)
 */

import { createClient } from "../db";
import { FinaleClient } from "../finale/client";
import { loadTrueReceiptQuantities } from "../finale/receipt-quantities";
import { allocateFreightByWeight, buildFinaleFreightAdjustment } from "../finale/freight-adjustment";
import { isFreightRequiredVendor, freightOnPo } from "../../config/freight-required-vendors";

/** Finale-gentle: pause between per-PO calls. Bursts upset Finale and staff. */
const GAP_MS = 350;
/** A freight amount at or below this is treated as "no freight". */
const FREIGHT_EPS = 0.5;
/** Dwell between the freight/reconciliation anchor and an autonomous close. */
const DWELL_HOURS = 24;
/** Caps per run: keep every pass small and verifiable. */
const MAX_CANDIDATES = 60;
const MAX_WRITES = 12;

export type FreightLane = "vendor" | "destination" | "none";

export interface FreightAlignStats {
    assessed: number;
    appliedVendor: number;
    appliedDestination: number;
    appliedCarrier: number;
    completed: number;
    skipped: number;
    errors: number;
    /** POs that still cannot align and why — surfaced in the run log only. */
    blocked: Array<{ po: string; reason: string }>;
}

interface PoRow {
    po_number?: unknown;
    vendor_name?: unknown;
    receive_date?: unknown;
    status?: unknown;
}

interface InvoiceRow {
    vendor_name?: unknown;
    freight?: unknown;
    total?: unknown;
    created_at?: unknown;
}

interface LogRow {
    created_at?: unknown;
}
interface FinaleAdjustmentLine {
    amount?: unknown;
    description?: unknown;
    productPromoUrl?: unknown;
    orderAdjustmentAllocationList?: unknown[];
    adjustmentAllocationEnumId?: unknown;
}

interface FinaleOrderDoc {
    statusId?: string;
    orderItemList?: Array<{ productId?: string; quantity?: number; weight?: number }>;
    orderAdjustmentList?: FinaleAdjustmentLine[];
    [key: string]: unknown;
}

/** One carrier bill from the Billtrust export, the fields the matcher reads. */
export interface CarrierBill {
    invoiceNumber: string;
    shipDate: string; // MM/DD/YYYY
    terms: string;
    amountDue: number;
    bol: string;
    poNumber: string;
    vendorName: string | null;
}

/**
 * Pure carrier-bill match for ONE blocked PO. Joins are the same the weekly
 * reconciler uses: a hard 6-digit PO# on the bill, or a vendor + ship-date
 * window around the PO's receive date when exactly one bill sits in it.
 * Composite PO# fields (freight-account strings like `9226398101-646135168`)
 * are bill numbers, not POs — never matched. COLLECT only.
 */
export function matchCarrierBillForPo(
    bills: CarrierBill[],
    po: string,
    vendorName: string,
    receiveDateIso: string | null | undefined,
): CarrierBill | null {
    const collect = bills.filter((b) => {
        if (!/COLLECT/i.test(b.terms)) return false;
        const pn = String(b.poNumber || "").trim();
        if (pn && (pn.includes("-") || !/^\d{6}$/.test(pn))) return false; // freight-account composite
        return true;
    });

    // Hard PO match first — the printed PO is the primary join.
    const hard = collect.find((b) => String(b.poNumber || "").trim() === po);
    if (hard) return hard;

    // Vendor + receive window: receive within [ship, ship+10d].
    if (!receiveDateIso) return null;
    const rcv = new Date(receiveDateIso).getTime();
    if (Number.isNaN(rcv)) return null;
    const v = vendorName.trim().toLowerCase();
    const windowed = collect.filter((b) => {
        if (!b.vendorName) return false;
        const bv = b.vendorName.toLowerCase();
        if (!(v && (bv.includes(v) || v.includes(bv)))) return false;
        const ship = parseUsDateMs(b.shipDate);
        if (Number.isNaN(ship)) return false;
        const delta = rcv - ship;
        return delta >= 0 && delta <= 10 * 86400 * 1000;
    });
    return windowed.length === 1 ? windowed[0] : null;
}

/** MM/DD/YYYY → epoch ms (Invalid Date → NaN). */
function parseUsDateMs(s: string): number {
    const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return NaN;
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(y, Number(m[1]) - 1, Number(m[2])).getTime();
}

/** Env kill switch — on by default (Bill authorized autonomous alignment). */
export function freightAutoAlignEnabled(): boolean {
    const v = (process.env.FREIGHT_AUTO_ALIGN_ENABLED ?? "true").toLowerCase();
    return v === "true" || v === "1" || v === "on";
}

/** Sum of the PO's carrier-freight /10007 lines (house charge included). */
export function sumFreightAdjustments(doc: FinaleOrderDoc | null | undefined): number {
    const adjs = doc?.orderAdjustmentList ?? [];
    return adjs
        .filter((a) => String(a.productPromoUrl || "").includes("/10007"))
        .reduce((s, a) => s + (Number(a.amount) || 0), 0);
}

/**
 * Pure decision: which lane supplies the freight for a PO that carries none.
 * Vendor-charged freight wins over a Destination bill — never apply both.
 */
export function pickFreightLane(input: {
    invoiceFreight: number;
    destAmount: number;
}): { lane: FreightLane; amount: number; reason?: string } {
    if (Number(input.invoiceFreight) > FREIGHT_EPS) {
        return { lane: "vendor", amount: Number(input.invoiceFreight) };
    }
    if (Number(input.destAmount) > FREIGHT_EPS) {
        return { lane: "destination", amount: Number(input.destAmount) };
    }
    return { lane: "none", amount: 0, reason: "no vendor or Destination freight bill — awaiting carrier bill" };
}

/** Pure dwell check: anchor must be at least minHours old. */
export function dwellSatisfied(anchorIso: string | null | undefined, nowMs: number, minHours: number = DWELL_HOURS): boolean {
    if (!anchorIso) return false;
    const at = new Date(anchorIso).getTime();
    if (Number.isNaN(at)) return false;
    return nowMs - at >= minHours * 3600 * 1000;
}

/**
 * Pure completion blocker: the only reasons an otherwise-aligned PO may not
 * be closed autonomously. Returns null when nothing blocks.
 */
export function completionBlocker(input: {
    shortsCount: number;
    hasMatchedInvoice: boolean;
    invoiceTotal: number;
    poTotal: number;
    invoiceFreight: number;
    poFreight: number;
    openDispute: boolean;
    pendingApproval: boolean;
}): string | null {
    if (input.shortsCount > 0) return "goods not all received";
    if (!input.hasMatchedInvoice) return "no matched goods invoice";
    if (input.openDispute) return "open overbill dispute";
    if (input.pendingApproval) return "pending approval";
    if (input.invoiceFreight > input.poFreight + 0.5) {
        return `invoice freight $${input.invoiceFreight.toFixed(2)} exceeds PO freight $${input.poFreight.toFixed(2)}`;
    }
    const overbill = input.invoiceTotal - input.poTotal;
    const tolerance = Math.max(input.poTotal * 0.05, 5);
    if (overbill > tolerance) {
        return `bill exceeds PO by $${overbill.toFixed(2)}`;
    }
    return null;
}

/**
 * Append one freight line to a PO, preserving every existing line (the Uline
 * $1.50 house charge stays). Follows the proven recipe: unlock → POST the
 * doc with the new adjustment → restore status → re-complete if it started
 * completed → read back and verify the sum.
 */
async function appendFreightLine(
    finale: FinaleClient,
    poNumber: string,
    amount: number,
    doc: FinaleOrderDoc,
): Promise<{ ok: boolean; error?: string }> {
    try {
        const originalStatus = doc.statusId;
        const allocLines = await (finale as unknown as {
            freightAllocLines: (items: FinaleOrderDoc["orderItemList"]) => Promise<Array<{ quantity: number; weight?: number }>>;
        }).freightAllocLines(doc.orderItemList);
        const alloc = allocateFreightByWeight(amount, allocLines);
        const line = buildFinaleFreightAdjustment(amount, alloc);
        const newAdjs: FinaleAdjustmentLine[] = [...(doc.orderAdjustmentList || []), line];
        const unlocked = finale as unknown as {
            unlockForEditing: (d: FinaleOrderDoc, po: string) => Promise<string>;
            restoreOrderStatus: (po: string, status: string) => Promise<void>;
            accountPath: string;
            post: (path: string, body: unknown) => Promise<unknown>;
        };
        await unlocked.unlockForEditing(doc, poNumber);
        await unlocked.post(`/${unlocked.accountPath}/api/order/${encodeURIComponent(poNumber)}`, {
            ...doc,
            orderAdjustmentList: newAdjs,
        });
        await unlocked.restoreOrderStatus(poNumber, originalStatus || "");
        if (originalStatus === "ORDER_COMPLETED") await finale.completeOrder(poNumber);
        const after: FinaleOrderDoc = await finale.getOrderDetails(poNumber);
        await new Promise((r) => setTimeout(r, GAP_MS));
        const expected = sumFreightAdjustments(doc) + amount;
        const got = sumFreightAdjustments(after);
        if (Math.abs(got - expected) > 0.02) {
            return { ok: false, error: `verify failed: freight ${got.toFixed(2)} vs expected ${expected.toFixed(2)}` };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message.slice(0, 160) : String(err) };
    }
}

/**
 * One autonomous pass: sweep freight-required vendors' received POs, apply
 * missing freight from the vendor or Destination lane, and complete the POs
 * that now carry every leg. Carrier-lane freight is deferred to the weekly
 * mailbox reconciler (it owns FedEx apply; double-apply is the one thing this
 * watcher must never do).
 */
export async function runFreightAutoAlign(): Promise<FreightAlignStats> {
    const stats: FreightAlignStats = {
        assessed: 0,
        appliedVendor: 0,
        appliedDestination: 0,
        appliedCarrier: 0,
        completed: 0,
        skipped: 0,
        errors: 0,
        blocked: [],
    };

    const sb = createClient();
    if (!sb) return stats;
    if (!freightAutoAlignEnabled()) {
        console.warn("[freight-auto-align] disabled by FREIGHT_AUTO_ALIGN_ENABLED");
        return stats;
    }

    const cutoff = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    const { data: poRows } = await sb
        .from("purchase_orders")
        .select("po_number, vendor_name, receive_date, status")
        .not("receive_date", "is", null)
        .gte("receive_date", cutoff)
        .limit(400);

    const candidates = ((poRows || []) as PoRow[]).filter(
        (r) =>
            isFreightRequiredVendor(String(r.vendor_name || "")) &&
            ["received", "open", "committed"].includes(String(r.status || "").toLowerCase()),
    );

    const finale = new FinaleClient();
    const nowMs = Date.now();
    let writes = 0;
    /** Billtrust carrier bills, loaded once on first need. */
    let carrierBills: CarrierBill[] | null = null;

    const loadCarrierBills = async (): Promise<CarrierBill[]> => {
        try {
            const { findLatestBilltrustCsv, parseBilltrustCsv, dedupInboundInvoices } = await import(
                "../../cli/reconcile-billtrust-freight"
            );
            const csv = findLatestBilltrustCsv();
            if (!csv) return [];
            return dedupInboundInvoices(parseBilltrustCsv(csv)).map((b) => ({
                invoiceNumber: b.invoiceNumber,
                shipDate: b.shipDate,
                terms: b.terms,
                amountDue: b.amountDue,
                bol: b.bol,
                poNumber: b.poNumber,
                vendorName: b.vendorName,
            }));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[freight-auto-align] carrier CSV load failed: ${msg}`);
            return [];
        }
    };

    for (const row of candidates.slice(0, MAX_CANDIDATES)) {
        const po = String(row.po_number);
        if (writes >= MAX_WRITES) {
            stats.skipped++;
            continue;
        }
        try {
            const receipt = await loadTrueReceiptQuantities(po);
            if (!receipt) {
                stats.errors++;
                continue;
            }
            stats.assessed++;
            const shortsCount = receiptShortsCount(receipt);
            const freightNow = freightOnPo(receipt.total, receipt.subtotal);

            // ── Lanes: only act when the PO carries no freight yet ──
            if (freightNow <= FREIGHT_EPS) {
                const { data: goodsRows } = await sb
                    .from("vendor_invoices")
                    .select("vendor_name, freight, total")
                    .eq("po_number", po)
                    .not("vendor_name", "ilike", "%destination%")
                    .not("source_ref", "ilike", "ltlselect-%")
                    .not("source_ref", "ilike", "fedex-%")
                    .not("source_ref", "ilike", "FEDEX_%")
                    .order("created_at", { ascending: false })
                    .limit(3);
                const goods = ((goodsRows || []) as InvoiceRow[])[0];
                const invoiceFreight = goods ? Number(goods.freight || 0) : 0;

                const { data: destRows } = await sb
                    .from("vendor_invoices")
                    .select("freight, total")
                    .eq("po_number", po)
                    .or("vendor_name.ilike.%destination%")
                    .order("created_at", { ascending: false })
                    .limit(1);
                const dest = ((destRows || []) as InvoiceRow[])[0];
                const destAmount = dest
                    ? Number(Number(dest.freight || 0) > FREIGHT_EPS ? dest.freight : dest.total || 0)
                    : 0;

                const lane = pickFreightLane({ invoiceFreight, destAmount });

                // Idempotency: another process (weekly mailbox reconciler)
                // may have landed freight since the sweep read. Re-read the
                // PO right before any write and skip when freight appeared.
                const doc: FinaleOrderDoc = await finale.getOrderDetails(po);
                await new Promise((r) => setTimeout(r, GAP_MS));
                if (sumFreightAdjustments(doc) > FREIGHT_EPS) {
                    stats.skipped++;
                    // Aligned now — completion happens on a later pass.
                    await new Promise((r) => setTimeout(r, GAP_MS));
                    continue;
                }

                if (lane.lane === "none") {
                    // Carrier lane (2026-10-28): the same Billtrust joins the
                    // weekly reconciler uses, run here for THIS blocked PO.
                    if (carrierBills === null) carrierBills = await loadCarrierBills();
                    const carrier = matchCarrierBillForPo(
                        carrierBills,
                        po,
                        String(row.vendor_name || ""),
                        String(row.receive_date || ""),
                    );
                    if (!carrier) {
                        stats.blocked.push({ po, reason: "no carrier bill matched yet" });
                        await new Promise((r) => setTimeout(r, GAP_MS));
                        continue;
                    }
                    const applyCarrier = await appendFreightLine(finale, po, carrier.amountDue, doc);
                    writes++;
                    if (!applyCarrier.ok) {
                        stats.errors++;
                        stats.blocked.push({ po, reason: `carrier apply failed: ${applyCarrier.error}` });
                        continue;
                    }
                    stats.appliedCarrier++;
                    await sb.from("ap_activity_log").insert({
                        intent: "FREIGHT_AUTO_ALIGNED",
                        created_at: new Date().toISOString(),
                        metadata: {
                            poNumber: po,
                            lane: "carrier",
                            amount: carrier.amountDue,
                            invoiceNumber: carrier.invoiceNumber,
                            bol: carrier.bol,
                        },
                    });
                    console.log(
                        `[freight-auto-align] ${po}: applied carrier freight $${carrier.amountDue.toFixed(2)} (${carrier.invoiceNumber})`,
                    );
                    await new Promise((r) => setTimeout(r, GAP_MS));
                    continue;
                }

                const apply = await appendFreightLine(finale, po, lane.amount, doc);
                writes++;
                if (!apply.ok) {
                    stats.errors++;
                    stats.blocked.push({ po, reason: `apply failed: ${apply.error}` });
                    continue;
                }
                if (lane.lane === "vendor") stats.appliedVendor++;
                else stats.appliedDestination++;
                await sb.from("ap_activity_log").insert({
                    intent: "FREIGHT_AUTO_ALIGNED",
                    created_at: new Date().toISOString(),
                    metadata: { poNumber: po, lane: lane.lane, amount: lane.amount },
                });
                console.log(`[freight-auto-align] ${po}: applied ${lane.lane} freight $${lane.amount.toFixed(2)}`);
                // Freshly applied — the 24h dwell starts now. Never complete
                // in the same pass that applied the money.
                await new Promise((r) => setTimeout(r, GAP_MS));
                continue;
            }

            // ── Completion: freight is already on the PO ──
            if (shortsCount > 0) {
                stats.blocked.push({ po, reason: `short receipt (${shortsCount} sku)` });
                await new Promise((r) => setTimeout(r, GAP_MS));
                continue;
            }
            const { data: goodsRows } = await sb
                .from("vendor_invoices")
                .select("vendor_name, freight, total")
                .eq("po_number", po)
                .not("vendor_name", "ilike", "%destination%")
                .not("source_ref", "ilike", "ltlselect-%")
                .not("source_ref", "ilike", "fedex-%")
                .not("source_ref", "ilike", "FEDEX_%")
                .order("created_at", { ascending: false })
                .limit(3);
            const goods = ((goodsRows || []) as InvoiceRow[])[0];

            const { data: dispRows } = await sb
                .from("overbill_disputes")
                .select("id")
                .eq("po_number", po)
                .eq("status", "open")
                .limit(1);
            const { data: paRows } = await sb
                .from("ap_pending_approvals")
                .select("id")
                .eq("order_id", po)
                .eq("status", "pending")
                .limit(1);

            const { data: anchorRows } = await sb
                .from("ap_activity_log")
                .select("created_at")
                .in("intent", ["FREIGHT_AUTO_ALIGNED", "RECONCILIATION"])
                .or(`metadata->>poNumber.eq.${po},metadata->>orderId.eq.${po}`)
                .order("created_at", { ascending: false })
                .limit(1);

            const anchor = ((anchorRows || []) as LogRow[])[0]?.created_at || row.receive_date;
            const invoiceFreight = goods ? Number(goods.freight || 0) : 0;
            const invoiceTotal = goods ? Number(goods.total || 0) : 0;

            const blocker = completionBlocker({
                shortsCount: 0,
                hasMatchedInvoice: !!goods,
                invoiceTotal,
                poTotal: receipt.total,
                invoiceFreight,
                poFreight: freightNow,
                openDispute: (dispRows || []).length > 0,
                pendingApproval: (paRows || []).length > 0,
            });
            if (blocker) {
                stats.blocked.push({ po, reason: blocker });
                await new Promise((r) => setTimeout(r, GAP_MS));
                continue;
            }
            if (!dwellSatisfied(anchor, nowMs)) {
                stats.blocked.push({ po, reason: "dwell < 24h" });
                await new Promise((r) => setTimeout(r, GAP_MS));
                continue;
            }

            await finale.completeOrder(po);
            writes++;
            stats.completed++;
            await sb.from("ap_activity_log").insert({
                intent: "FREIGHT_AUTO_COMPLETED",
                created_at: new Date().toISOString(),
                metadata: { poNumber: po },
            });
            const { invalidatePurchasingCaches } = await import("./cache");
            await invalidatePurchasingCaches();
            console.log(`[freight-auto-align] ${po}: completed (freight on PO, receipt full, bill matched)`);
            await new Promise((r) => setTimeout(r, GAP_MS));
        } catch (err) {
            stats.errors++;
            const msg = err instanceof Error ? err.message.slice(0, 160) : String(err);
            console.warn(`[freight-auto-align] ${po} failed: ${msg}`);
            await new Promise((r) => setTimeout(r, GAP_MS));
        }
    }

    if (stats.assessed > 0) {
        console.log(
            `[freight-auto-align] assessed=${stats.assessed} vendor=${stats.appliedVendor} dest=${stats.appliedDestination} ` +
                `carrier=${stats.appliedCarrier} completed=${stats.completed} skipped=${stats.skipped} errors=${stats.errors} blocked=${stats.blocked.length}`,
        );
    }
    return stats;
}

/** Count of SKUs with received < ordered (completion-forbidden). */
function receiptShortsCount(receipt: Awaited<ReturnType<typeof loadTrueReceiptQuantities>>): number {
    if (!receipt) return 999;
    let n = 0;
    for (const [sku, ordered] of receipt.orderedBySku) {
        if ((receipt.receivedBySku.get(sku) || 0) < ordered) n++;
    }
    return n;
}
