/**
 * @file    po-reliability-scorer.ts
 * @purpose Score open POs as "deliverable" or "stuck" so the qty recommender
 *          only credits supply from POs with real evidence of progress.
 *
 *          A PO is deliverable when it has at least one signal of forward
 *          motion: vendor ack, tracking number, shipment movement, or
 *          a lifecycle stage indicating active transit. POs without any
 *          evidence — sent but ignored, or tracking that went dark — do
 *          NOT count toward stockOnOrder. The SKU stays orderable so the
 *          buyer can reorder rather than waiting on a ghost PO.
 *
 *          If Supabase is unavailable, ALL POs are conservatively treated
 *          as deliverable (over-credit is safer than triggering false
 *          reorder recommendations).
 *
 * @author  Hermia
 * @created 2026-06-11
 * @deps    @/lib/supabase (purchase_orders, shipments tables)
 * @env     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@/lib/supabase";

// ── Types ────────────────────────────────────────────────────────────────────

/** An open PO from Finale's Committed/Locked status. */
export interface OpenPOBase {
    orderId: string;
    quantity: number;
    orderDate: string;
    dueDate?: string | null;
}

/** Stuck reason labels for provenance logging. */
export type StuckReason =
    | "no_record"          // no Supabase row — PO never tracked
    | "not_sent"           // has a record but po_sent_verified_at is null
    | "no_ack_no_tracking" // sent but vendor silent, no tracking
    | "stale_tracking"     // tracking exists but no movement in STALE_TRACKING_DAYS
    | "overdue_no_eta"     // past due date with no ETA or movement
    | "delivered";         // already delivered (shouldn't be in openPOs, but safety)

/** An open PO enriched with delivery reliability assessment. */
export interface OpenPOReliable extends OpenPOBase {
    /** True when the PO has evidence of real forward progress. */
    isDeliverable: boolean;
    /** Why the PO is not deliverable (empty string when isDeliverable=true). */
    stuckReason: StuckReason | "";
    /** Days since the PO was ordered (from orderDate). */
    ageDays: number;
}

// ── Thresholds ───────────────────────────────────────────────────────────────

/** Days after sending with no ack and no tracking before a PO is considered stuck. */
const NO_ACK_NO_TRACKING_DAYS = 7;

/** Days since last tracking movement before tracking is considered stale. */
const STALE_TRACKING_DAYS = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysSince(dateStr: string | null | undefined): number | null {
    if (!dateStr) return null;
    const ts = new Date(dateStr).getTime();
    if (isNaN(ts)) return null;
    return Math.floor((Date.now() - ts) / 86_400_000);
}

// ── Supabase row shape (narrow selection) ────────────────────────────────────

interface PORow {
    po_number: string;
    tracking_numbers: string[] | null;
    lifecycle_stage: string | null;
    last_movement_summary: string | null;
    vendor_acknowledged_at: string | null;
    vendor_noncomm_at: string | null;
    po_sent_verified_at: string | null;
    po_sent_at: string | null;
}

interface ShipmentRow {
    po_numbers: string[] | null;
    status_category: string | null;
    delivered_at: string | null;
    last_checked_at: string | null;
    updated_at: string | null;
}

// ── Core functions ───────────────────────────────────────────────────────────

/**
 * Enrich Finale open POs with Supabase lifecycle data to assess deliverability.
 * Queries purchase_orders + shipments in one pass, then scores each PO.
 *
 * If Supabase is unavailable, ALL POs are conservatively treated as deliverable
 * (preserves pre-v2.7 behavior — over-credit is safer than triggering false
 * reorder recommendations).
 */
export async function enrichOpenPOs(openPOs: OpenPOBase[]): Promise<OpenPOReliable[]> {
    if (openPOs.length === 0) return [];

    const supabase = createClient();
    if (!supabase) {
        // No Supabase → conservative: assume all deliverable (old behavior).
        return openPOs.map(po => ({
            ...po,
            isDeliverable: true,
            stuckReason: "" as const,
            ageDays: daysSince(po.orderDate) ?? 0,
        }));
    }

    const orderIds = openPOs.map(po => po.orderId);

    // Fetch PO lifecycle data + shipments in parallel. If Supabase is flaky
    // (522 timeout, pool exhaustion, network blip), treat every PO as
    // deliverable — fail-open so we don't accidentally show double-order
    // recommendations for POs the vendor has acknowledged and is shipping.
    let poRes: any = { data: [] };
    let shipRes: any = { data: [] };
    try {
        const results = await Promise.all([
            supabase
                .from("purchase_orders")
                .select(
                    "po_number, tracking_numbers, lifecycle_stage, last_movement_summary, " +
                    "vendor_acknowledged_at, vendor_noncomm_at, po_sent_verified_at, po_sent_at"
                )
                .in("po_number", orderIds),
            supabase
                .from("shipments")
                .select("po_numbers, status_category, delivered_at, last_checked_at, updated_at")
                .overlaps("po_numbers", orderIds),
        ]);
        poRes = results[0];
        shipRes = results[1];
    } catch (err: any) {
        console.warn(`[po-reliability] Supabase fetch failed (${orderIds.length} POs), failing open:`, err?.message ?? err);
        return openPOs.map(po => ({
            ...po,
            isDeliverable: true,
            stuckReason: "" as const,
            ageDays: daysSince(po.orderDate) ?? 0,
        }));
    }

    // Index lifecycle data by PO number. If Supabase returned an error
    // object instead of rows (e.g. pool busy, connection reset), treat
    // every PO as deliverable (fail-open).
    if (poRes.error) {
        console.warn(`[po-reliability] Supabase PO query returned error, failing open:`, poRes.error.message);
        return openPOs.map(po => ({
            ...po,
            isDeliverable: true,
            stuckReason: "" as const,
            ageDays: daysSince(po.orderDate) ?? 0,
        }));
    }

    const poMap = new Map<string, PORow>();
    for (const row of (poRes.data ?? []) as PORow[]) {
        poMap.set(row.po_number, row);
    }

    // Index shipment data by PO number. If shipment query failed,
    // continue with PO-only scoring — shipments are supplementary.
    const shipmentsByPO = new Map<string, ShipmentRow[]>();
    for (const s of (shipRes.data ?? []) as ShipmentRow[]) {
        for (const po of (s.po_numbers ?? []) as string[]) {
            if (!shipmentsByPO.has(po)) shipmentsByPO.set(po, []);
            shipmentsByPO.get(po)!.push(s);
        }
    }

    // Score each PO.
    return openPOs.map(po => {
        const age = daysSince(po.orderDate) ?? 0;
        const row = poMap.get(po.orderId);
        const ships = shipmentsByPO.get(po.orderId) ?? [];

        // No Supabase record at all — PO may have just been created in Finale
        // but not yet tracked by Aria. Conservative: assume deliverable if young
        // (< 3 days), stuck if older.
        if (!row) {
            return {
                ...po,
                isDeliverable: age < 3,
                stuckReason: age < 3 ? ("" as const) : ("no_record" as const),
                ageDays: age,
            };
        }

        const hasTracking = (row.tracking_numbers && row.tracking_numbers.length > 0)
            || ships.length > 0;
        const hasAck = !!row.vendor_acknowledged_at;
        const hasSent = !!row.po_sent_verified_at || !!row.po_sent_at;
        const anyDelivered = ships.some(
            s => s.delivered_at || s.status_category === "delivered"
        );
        const lifecycle = row.lifecycle_stage ?? "";

        // Already delivered — shouldn't be in openPOs but handle gracefully.
        if (anyDelivered || lifecycle === "received" || lifecycle === "completed") {
            return {
                ...po,
                isDeliverable: false,
                stuckReason: "delivered" as const,
                ageDays: age,
            };
        }

        // Vendor non-committal — treated as not deliverable.
        if (row.vendor_noncomm_at) {
            return {
                ...po,
                isDeliverable: false,
                stuckReason: "no_ack_no_tracking" as const,
                ageDays: age,
            };
        }

        // Active lifecycle stages that indicate forward progress.
        const activeStages = new Set([
            "in_transit", "shipped", "out_for_delivery",
            "partial_delivery", "tracking_active",
        ]);
        if (activeStages.has(lifecycle)) {
            return {
                ...po,
                isDeliverable: true,
                stuckReason: "" as const,
                ageDays: age,
            };
        }

        // Tracking exists — check if it's stale.
        if (hasTracking) {
            const lastMovement = ships
                .map(s => s.last_checked_at ?? s.updated_at)
                .filter(Boolean)
                .sort()
                .pop();
            const movementAge = daysSince(lastMovement);
            if (movementAge != null && movementAge >= STALE_TRACKING_DAYS) {
                return {
                    ...po,
                    isDeliverable: false,
                    stuckReason: "stale_tracking" as const,
                    ageDays: age,
                };
            }
            // Tracking with recent movement → deliverable.
            return {
                ...po,
                isDeliverable: true,
                stuckReason: "" as const,
                ageDays: age,
            };
        }

        // Has vendor ack → deliverable (waiting for shipment).
        if (hasAck) {
            return {
                ...po,
                isDeliverable: true,
                stuckReason: "" as const,
                ageDays: age,
            };
        }

        // No ack, no tracking. Check age threshold.
        const sentAge = daysSince(row.po_sent_verified_at ?? row.po_sent_at);
        if (sentAge != null && sentAge >= NO_ACK_NO_TRACKING_DAYS) {
            return {
                ...po,
                isDeliverable: false,
                stuckReason: "no_ack_no_tracking" as const,
                ageDays: age,
            };
        }

        // Sent recently but no response yet — give it time, assume deliverable.
        if (hasSent) {
            return {
                ...po,
                isDeliverable: true,
                stuckReason: "" as const,
                ageDays: age,
            };
        }

        // Not sent yet (just a Finale PO, not transmitted). Not deliverable.
        return {
            ...po,
            isDeliverable: false,
            stuckReason: "not_sent" as const,
            ageDays: age,
        };
    });
}

/**
 * Returns true if at least one PO has delivery evidence.
 * Used as a lifecycle/chase signal — not the sole gate for supply credit.
 */
export function hasDeliverablePO(pos: OpenPOReliable[]): boolean {
    return pos.some(po => po.isDeliverable);
}

/**
 * Sum of quantities from deliverable POs only.
 * Lifecycle view: how much supply has forward-motion evidence.
 */
export function deliverableStockOnOrder(pos: OpenPOReliable[]): number {
    return pos
        .filter(po => po.isDeliverable)
        .reduce((sum, po) => sum + po.quantity, 0);
}

/**
 * HERMIA(2026-07-10): Demand-side supply credit for reorder math.
 *
 * Finale Committed/Locked open PO qty is real supply on the timeline.
 * Zeroing stuck POs caused false re-order recommendations (labels/print:
 * PO 500 on ribbon, stockOnOrder=0, suggested 250 again).
 *
 * Rule: credit ALL open PO quantities toward coverage. Stuck lifecycle is a
 * chase/escalation signal in Purchases — not a reason to place a second PO
 * for the same demand window.
 */
export function coverageStockOnOrder(
    openPOs: Array<{ quantity: number }>,
    enriched?: OpenPOReliable[],
): number {
    const finaleTotal = openPOs.reduce((sum, po) => sum + Math.max(0, po.quantity || 0), 0);
    if (!enriched || enriched.length === 0) return finaleTotal;
    const deliverable = deliverableStockOnOrder(enriched);
    return Math.max(finaleTotal, deliverable);
}

/** True when at least one open PO lacks deliverability evidence (chase needed). */
export function hasStuckOpenPO(pos: OpenPOReliable[]): boolean {
    return pos.some(po => !po.isDeliverable);
}
