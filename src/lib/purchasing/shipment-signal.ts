/**
 * @file    shipment-signal.ts
 * @purpose Resolve real movement evidence for a set of POs from every store
 *          that actually holds a link — not just `shipments.po_numbers`.
 *
 *          Why: `shipments` is dominated by carrier billing mail (FedEx Billing
 *          Online statements, AAA Cooper statements) that legitimately names no
 *          PO, so judging tracking coverage by `shipments.po_numbers` understates
 *          it badly. A PO also carries its own `tracking_numbers`, and those
 *          resolve to shipment rows through `normalized_tracking_number` even
 *          when the encodings differ ("1551381344" vs "UPS:::1551381344").
 *
 * @author  Hermia
 * @created 2026-11-09
 * @deps    @/lib/db
 */

import { createClient } from "../db";

export interface ShipmentSignal {
    /** Latest delivery scan — a PO split across parcels is in when the last lands. */
    deliveredAt: string | null;
    /** Earliest live carrier ETA on or after today. */
    carrierEta: string | null;
    /** Which stores contributed (for diagnostics). */
    via: string[];
}

const isoDay = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null);
const CHUNK = 80;

/** Bare tracking token: "UPS:::1Z..." → "1Z...". */
export function trackingSuffix(value: string | null | undefined): string {
    return String(value || "").split(":::").pop()!.trim().toUpperCase();
}

/**
 * Merge one piece of evidence into a PO's signal.
 *
 * @param target Mutable signal for the PO.
 * @param patch  Evidence to fold in.
 */
export function mergeSignal(target: ShipmentSignal, patch: Partial<ShipmentSignal> & { today?: string }): void {
    const delivered = isoDay(patch.deliveredAt);
    if (delivered && (!target.deliveredAt || delivered > target.deliveredAt)) {
        target.deliveredAt = delivered;
    }
    const eta = isoDay(patch.carrierEta);
    const today = patch.today;
    if (!target.deliveredAt && eta && (!today || eta >= today)) {
        if (!target.carrierEta || eta < target.carrierEta) target.carrierEta = eta;
    }
    for (const v of patch.via || []) {
        if (!target.via.includes(v)) target.via.push(v);
    }
}

/**
 * Build movement signals for the given POs.
 *
 * Sources, in order of authority: shipment rows reachable from the PO's own
 * `tracking_numbers`, shipment rows that list the PO in `po_numbers`, then
 * `po_shipment_legs` dates.
 *
 * @param poNumbers PO numbers to resolve.
 * @param today     Denver date (YYYY-MM-DD) used to reject stale carrier ETAs.
 * @returns Map of PO number to signal; POs with no evidence are absent.
 */
export async function loadShipmentSignals(
    poNumbers: string[],
    today: string,
): Promise<Map<string, ShipmentSignal>> {
    const out = new Map<string, ShipmentSignal>();
    const ids = Array.from(new Set(poNumbers.map(String).filter(Boolean)));
    if (ids.length === 0) return out;

    const db = createClient();
    if (!db) return out;

    const ensure = (po: string): ShipmentSignal => {
        const cur = out.get(po) || { deliveredAt: null, carrierEta: null, via: [] };
        out.set(po, cur);
        return cur;
    };

    // 1. POs and the tracking numbers recorded against them.
    const { data: poRows } = await db
        .from("purchase_orders")
        .select("po_number, tracking_numbers")
        .in("po_number", ids);

    const suffixToPos = new Map<string, string[]>();
    for (const row of (poRows ?? []) as Array<{ po_number: string; tracking_numbers: string[] | null }>) {
        for (const num of row.tracking_numbers || []) {
            const key = trackingSuffix(num);
            if (!key) continue;
            const arr = suffixToPos.get(key) || [];
            if (!arr.includes(row.po_number)) arr.push(row.po_number);
            suffixToPos.set(key, arr);
        }
    }

    // 2. Shipment rows linked by po_numbers.
    const { data: byPo } = await db
        .from("shipments")
        .select("po_numbers, delivered_at, estimated_delivery_at")
        .eq("active", true)
        .overlaps("po_numbers", ids);
    for (const s of (byPo ?? []) as Array<{
        po_numbers: string[] | null;
        delivered_at: string | null;
        estimated_delivery_at: string | null;
    }>) {
        for (const po of s.po_numbers || []) {
            mergeSignal(ensure(po), {
                deliveredAt: s.delivered_at,
                carrierEta: s.estimated_delivery_at,
                via: ["shipments.po_numbers"],
                today,
            });
        }
    }

    // 3. Shipment rows reachable through the PO's tracking numbers.
    const suffixes = Array.from(suffixToPos.keys());
    for (let i = 0; i < suffixes.length; i += CHUNK) {
        const slice = suffixes.slice(i, i + CHUNK);
        const { data } = await db
            .from("shipments")
            .select("normalized_tracking_number, delivered_at, estimated_delivery_at")
            .eq("active", true)
            .in("normalized_tracking_number", slice);
        for (const s of (data ?? []) as Array<{
            normalized_tracking_number: string | null;
            delivered_at: string | null;
            estimated_delivery_at: string | null;
        }>) {
            const key = String(s.normalized_tracking_number || "").toUpperCase();
            for (const po of suffixToPos.get(key) || []) {
                mergeSignal(ensure(po), {
                    deliveredAt: s.delivered_at,
                    carrierEta: s.estimated_delivery_at,
                    via: ["po.tracking_numbers"],
                    today,
                });
            }
        }
    }

    // 4. PO shipment legs (weakest: expected_date is sparsely maintained).
    const { data: legs } = await db
        .from("po_shipment_legs")
        .select("po_number, expected_date, actual_date")
        .in("po_number", ids);
    for (const l of (legs ?? []) as Array<{
        po_number: string;
        expected_date: string | null;
        actual_date: string | null;
    }>) {
        mergeSignal(ensure(l.po_number), {
            deliveredAt: l.actual_date,
            carrierEta: l.expected_date,
            via: ["po_shipment_legs"],
            today,
        });
    }

    return out;
}
