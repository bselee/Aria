/**
 * @file    eta-predictions.ts
 * @purpose Record what ETA we predicted each day and from which evidence, then
 *          score those predictions against the date the goods actually landed.
 *          Without this, "arrival dates are a guess" can never be measured or
 *          disproved — the report recomputes on demand and throws the result away.
 *
 * @author  Hermia
 * @created 2026-11-09
 * @deps    @/lib/db, @/lib/finale/client, ./po-eta
 */

import { createClient } from "@/lib/db";
import { FinaleClient } from "@/lib/finale/client";
import { resolvePoEta, withVendorSlip } from "./po-eta";
import { leadTimeService } from "../builds/lead-time-service";
import { loadShipmentSignals } from "./shipment-signal";

const NUMERIC = /^\d+$/;
const isoDay = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null);

export interface RecordResult {
    openPos: number;
    recorded: number;
    error?: string;
}

export interface ScoreBucket {
    provenance: string;
    n: number;
    /** Mean signed error in days. Positive = arrived later than predicted. */
    biasDays: number;
    /** Mean absolute error in days. */
    maeDays: number;
    /** Share that landed within ±1 day. */
    withinOneDayPct: number;
}

/**
 * Snapshot today's ETA for every open PO.
 *
 * Uses the same resolver as the dashboard and the Friday report, with the same
 * evidence inputs (carrier scan → carrier ETA → vendor date → Finale planned →
 * lead time), so the stored prediction is exactly what the team was shown.
 *
 * @param opts.today Snapshot date override (YYYY-MM-DD, Denver).
 * @returns Counts of open POs and rows written.
 */
export async function recordEtaPredictions(
    opts: { today?: string } = {},
): Promise<RecordResult> {
    const db = createClient();
    if (!db) return { openPos: 0, recorded: 0, error: "DB unavailable" };
    const today =
        opts.today ||
        new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });

    let pos: any[] = [];
    try {
        const client = new FinaleClient();
        pos = await client.getRecentPurchaseOrders(180, 500);
    } catch (err: unknown) {
        return {
            openPos: 0,
            recorded: 0,
            error: err instanceof Error ? err.message : String(err),
        };
    }

    const numeric = pos.filter((p) => NUMERIC.test(String(p.orderId || "")));
    const ids = numeric.map((p) => String(p.orderId));

    // Lifecycle + vendor-stated dates from the mirror.
    const metaByPo = new Map<string, { status: string; life: string; vendorEta: string | null }>();
    if (ids.length > 0) {
        const { data } = await db
            .from("purchase_orders")
            .select("po_number, status, lifecycle_stage, vendor_stated_eta")
            .in("po_number", ids);
        for (const r of (data ?? []) as Array<{
            po_number: string;
            status: string | null;
            lifecycle_stage: string | null;
            vendor_stated_eta: string | null;
        }>) {
            metaByPo.set(String(r.po_number), {
                status: String(r.status || ""),
                life: String(r.lifecycle_stage || ""),
                vendorEta: isoDay(r.vendor_stated_eta),
            });
        }
    }

    // Real movement evidence, from every store that holds a link: the PO's own
    // tracking numbers, shipments that list the PO, and shipment legs.
    const signals = await loadShipmentSignals(ids, today);

    const rows: Array<Record<string, unknown>> = [];
    for (const p of numeric) {
        const poNumber = String(p.orderId);
        const meta = metaByPo.get(poNumber);
        if (/cancel/i.test(String(p.status || "")) || /cancel/i.test(meta?.life || "")) continue;
        if (/received|completed|invoiced/i.test(String(p.status || ""))) continue;
        if (/RECEIVED|COMPLETED|INVOICED/.test(meta?.life || "")) continue;

        const ship = signals.get(poNumber);
        const eta = await resolvePoEta({
            vendorName: String(p.vendorName || ""),
            orderDate: isoDay(p.orderDate),
            plannedReceiveDate: isoDay(p.receiveDate),
            vendorStatedEta: meta?.vendorEta ?? null,
            shipment: ship
                ? { deliveredAt: ship.deliveredAt, estimatedDeliveryAt: ship.carrierEta }
                : null,
            today,
        });

        rows.push({
            po_number: poNumber,
            vendor_name: p.vendorName || null,
            snapshot_date: today,
            // Score the date we actually show. The board and the Friday report
            // both push forecasts to the vendor's p90, so the snapshot must use
            // the same adjustment or the accuracy score measures a number no
            // one sees.
            predicted_date: withVendorSlip(
                eta.date,
                eta.provenance,
                await leadTimeService
                    .getDistribution(String(p.vendorName || ""))
                    .then((d) => (d && d.p90 > d.p50 ? d.p90 - d.p50 : 0))
                    .catch(() => 0),
            ) ?? eta.date,
            provenance: eta.provenance,
            updated_at: new Date().toISOString(),
        });
    }

    if (rows.length === 0) return { openPos: 0, recorded: 0 };

    const { error } = await db
        .from("po_eta_predictions")
        .upsert(rows, { onConflict: "po_number,snapshot_date" });
    if (error) return { openPos: rows.length, recorded: 0, error: error.message };

    return { openPos: rows.length, recorded: rows.length };
}

/**
 * Score stored predictions against the date the goods actually landed.
 *
 * Actual date precedence: a carrier delivery scan on a PO-linked shipment,
 * then the PO's own past receive_date when the PO is marked received. A future
 * receive_date is a schedule, not an arrival, and is ignored.
 *
 * Takes each PO's most recent prediction, so the score measures how good our
 * final forecast was rather than a stale one from weeks earlier.
 *
 * @param opts.days Look-back window for predictions (default 90).
 * @returns One bucket per evidence source, plus the overall count.
 */
export async function scoreEtaPredictions(
    opts: { days?: number } = {},
): Promise<{ buckets: ScoreBucket[]; scored: number; error?: string }> {
    const db = createClient();
    if (!db) return { buckets: [], scored: 0, error: "DB unavailable" };
    const days = Math.max(7, Math.min(365, opts.days ?? 90));

    const { data, error } = await db.rpc("score_po_eta_predictions", { p_days: days });
    if (error) return { buckets: [], scored: 0, error: error.message };

    const buckets = ((data ?? []) as Array<{
        provenance: string;
        n: number | string;
        bias_days: number | string | null;
        mae_days: number | string | null;
        within_one_day_pct: number | string | null;
    }>).map((r) => ({
        provenance: r.provenance,
        n: Number(r.n) || 0,
        biasDays: Number(r.bias_days) || 0,
        maeDays: Number(r.mae_days) || 0,
        withinOneDayPct: Number(r.within_one_day_pct) || 0,
    }));

    return { buckets, scored: buckets.reduce((s, b) => s + b.n, 0) };
}
