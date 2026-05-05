/**
 * @file    calibration.ts
 * @purpose Cross-cutting Supabase access for the canonical reorder pipeline.
 *          Loads everything the recommender needs that lives outside Finale —
 *          calibration stats, draft reservations, vendor MOQs — and writes
 *          back the recommendation snapshots + reservations.
 *
 *          Each function is best-effort: a Supabase outage degrades the
 *          pipeline to "phase 1" behavior (no calibration, no MOQ, no
 *          reservation discount) rather than blocking recommendations.
 */

import { createClient } from "../supabase";

// ──────────────────────────────────────────────────
// CALIBRATION STATS — vendor -> safety multiplier
// ──────────────────────────────────────────────────

export interface VendorCalibration {
    vendorPartyId: string;
    sampleCount: number;
    medianErrorPct: number | null;
    biasPct: number | null;
    safetyMultiplier: number;
}

export async function loadCalibrationStats(
    vendorPartyIds: string[]
): Promise<Map<string, VendorCalibration>> {
    const map = new Map<string, VendorCalibration>();
    if (vendorPartyIds.length === 0) return map;
    const db = createClient();
    if (!db) return map;

    try {
        const { data } = await db
            .from("vendor_calibration_stats")
            .select("vendor_party_id, sample_count, median_error_pct, bias_pct, safety_multiplier")
            .in("vendor_party_id", vendorPartyIds);

        for (const row of data ?? []) {
            map.set(row.vendor_party_id, {
                vendorPartyId: row.vendor_party_id,
                sampleCount: row.sample_count ?? 0,
                medianErrorPct: row.median_error_pct,
                biasPct: row.bias_pct,
                safetyMultiplier: row.safety_multiplier ?? 1,
            });
        }
    } catch (err: any) {
        console.warn(`[calibration] loadCalibrationStats failed: ${err.message}`);
    }
    return map;
}

// ──────────────────────────────────────────────────
// DRAFT PO RESERVATION (Phase 3a)
// ──────────────────────────────────────────────────

export interface ActiveReservation {
    productId: string;
    qty: number;
    draftPONumbers: string[];
}

/** Returns a map of `productId -> total reserved qty` across all unreleased rows. */
export async function loadActiveReservations(
    productIds: string[]
): Promise<Map<string, ActiveReservation>> {
    const map = new Map<string, ActiveReservation>();
    if (productIds.length === 0) return map;
    const db = createClient();
    if (!db) return map;

    try {
        const nowIso = new Date().toISOString();
        const { data } = await db
            .from("qty_reservations")
            .select("product_id, qty, draft_po_number")
            .is("released_at", null)
            .gt("expires_at", nowIso)
            .in("product_id", productIds);

        for (const row of data ?? []) {
            const existing = map.get(row.product_id);
            if (existing) {
                existing.qty += Number(row.qty) || 0;
                if (!existing.draftPONumbers.includes(row.draft_po_number)) {
                    existing.draftPONumbers.push(row.draft_po_number);
                }
            } else {
                map.set(row.product_id, {
                    productId: row.product_id,
                    qty: Number(row.qty) || 0,
                    draftPONumbers: [row.draft_po_number],
                });
            }
        }
    } catch (err: any) {
        console.warn(`[calibration] loadActiveReservations failed: ${err.message}`);
    }
    return map;
}

export async function recordReservations(
    draftPONumber: string,
    vendorPartyId: string | null,
    items: Array<{ productId: string; qty: number }>
): Promise<number> {
    if (items.length === 0) return 0;
    const db = createClient();
    if (!db) return 0;

    try {
        const rows = items
            .filter(i => i.qty > 0)
            .map(i => ({
                product_id: i.productId,
                vendor_party_id: vendorPartyId,
                qty: i.qty,
                draft_po_number: draftPONumber,
            }));
        if (rows.length === 0) return 0;
        const { error } = await db.from("qty_reservations").insert(rows);
        if (error) {
            console.warn(`[calibration] recordReservations failed: ${error.message}`);
            return 0;
        }
        return rows.length;
    } catch (err: any) {
        console.warn(`[calibration] recordReservations exception: ${err.message}`);
        return 0;
    }
}

export async function releaseReservations(
    draftPONumber: string,
    reason: "committed" | "cancelled" | "expired" | "manual"
): Promise<number> {
    const db = createClient();
    if (!db) return 0;
    try {
        const { data, error } = await db
            .from("qty_reservations")
            .update({ released_at: new Date().toISOString(), release_reason: reason })
            .eq("draft_po_number", draftPONumber)
            .is("released_at", null)
            .select("id");
        if (error) {
            console.warn(`[calibration] releaseReservations failed: ${error.message}`);
            return 0;
        }
        return data?.length ?? 0;
    } catch (err: any) {
        console.warn(`[calibration] releaseReservations exception: ${err.message}`);
        return 0;
    }
}

export async function cleanupExpiredReservations(): Promise<number> {
    const db = createClient();
    if (!db) return 0;
    try {
        const { data, error } = await db
            .from("qty_reservations")
            .update({ released_at: new Date().toISOString(), release_reason: "expired" })
            .is("released_at", null)
            .lt("expires_at", new Date().toISOString())
            .select("id");
        if (error) {
            console.warn(`[calibration] cleanupExpiredReservations failed: ${error.message}`);
            return 0;
        }
        return data?.length ?? 0;
    } catch (err: any) {
        console.warn(`[calibration] cleanupExpiredReservations exception: ${err.message}`);
        return 0;
    }
}

// ──────────────────────────────────────────────────
// VENDOR MOQ
// ──────────────────────────────────────────────────

export interface VendorMOQ {
    vendorPartyId: string;
    minimumOrderDollars: number | null;
    minimumOrderEaches: number | null;
}

export async function loadVendorMOQs(
    vendorPartyIds: string[]
): Promise<Map<string, VendorMOQ>> {
    const map = new Map<string, VendorMOQ>();
    if (vendorPartyIds.length === 0) return map;
    const db = createClient();
    if (!db) return map;
    try {
        const { data } = await db
            .from("vendor_minimum_orders")
            .select("vendor_party_id, minimum_order_dollars, minimum_order_eaches")
            .in("vendor_party_id", vendorPartyIds);
        for (const row of data ?? []) {
            map.set(row.vendor_party_id, {
                vendorPartyId: row.vendor_party_id,
                minimumOrderDollars: row.minimum_order_dollars,
                minimumOrderEaches: row.minimum_order_eaches,
            });
        }
    } catch (err: any) {
        console.warn(`[calibration] loadVendorMOQs failed: ${err.message}`);
    }
    return map;
}

// ──────────────────────────────────────────────────
// RECOMMENDATION SNAPSHOT
// ──────────────────────────────────────────────────

export interface RecommendationSnapshot {
    productId: string;
    vendorPartyId: string | null;
    vendorName: string | null;
    formulaVersion: string;
    recommendedQty: number;
    finaleReorderQty: number | null;
    inputs: Record<string, any>;
    provenance: Array<Record<string, any>>;
}

/**
 * Best-effort batch insert of recommendation snapshots. We don't need durability
 * — a missed snapshot just means one fewer calibration sample later. Errors are
 * logged once per batch, not per row.
 */
export async function recordRecommendationSnapshots(
    snapshots: RecommendationSnapshot[]
): Promise<number> {
    if (snapshots.length === 0) return 0;
    const db = createClient();
    if (!db) return 0;
    try {
        const rows = snapshots.map(s => ({
            product_id: s.productId,
            vendor_party_id: s.vendorPartyId,
            vendor_name: s.vendorName,
            formula_version: s.formulaVersion,
            recommended_qty: s.recommendedQty,
            finale_reorder_qty: s.finaleReorderQty,
            inputs_jsonb: s.inputs,
            provenance_jsonb: s.provenance,
        }));
        const { error } = await db.from("qty_recommendations").insert(rows);
        if (error) {
            console.warn(`[calibration] recordRecommendationSnapshots failed: ${error.message}`);
            return 0;
        }
        return rows.length;
    } catch (err: any) {
        console.warn(`[calibration] recordRecommendationSnapshots exception: ${err.message}`);
        return 0;
    }
}
