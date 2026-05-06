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
// VENDOR RECENT LINE QTYS (cognitive rounding history signal)
// ──────────────────────────────────────────────────

/**
 * v2.2 — pull the last N completed PO line quantities for a vendor across
 * all SKUs (vendors tend to use consistent batch sizes for related products).
 * Used by cognitive rounding to detect favorite-batch clusters (e.g.
 * Colorful Packaging always orders in 500s and 1000s).
 *
 * Reaches into the Finale GraphQL directly — uses the same auth pattern as
 * other client.ts queries but inline so calibration.ts stays decoupled
 * from the FinaleClient class.
 *
 * Best-effort: a Finale outage returns an empty array and the recommender
 * falls back to the cognitive ladder.
 */
export async function loadVendorRecentLineQtys(
    finaleAuthHeader: string,
    finaleApiBase: string,
    finaleAccountPath: string,
    vendorPartyId: string,
    limit: number = 8,
): Promise<number[]> {
    if (!vendorPartyId) return [];
    try {
        // 6-month window — long enough to see vendor patterns, short enough
        // that the data reflects current pricing/case-size assumptions.
        const now = new Date();
        const begin = new Date(now);
        begin.setDate(begin.getDate() - 180);
        const beginStr = begin.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
        const endStr = new Date(now.getTime() + 86400000).toLocaleDateString("en-CA", { timeZone: "America/Denver" });

        const query = {
            query: `{
                orderViewConnection(
                    first: ${Math.max(limit * 2, 16)}
                    type: ["PURCHASE_ORDER"]
                    statusId: ["ORDER_COMPLETED"]
                    orderDate: { begin: "${beginStr}", end: "${endStr}" }
                    sort: [{ field: "orderDate", mode: "desc" }]
                ) {
                    edges { node {
                        orderId
                        supplier { partyUrl }
                        itemList(first: 200) {
                            edges { node { quantity } }
                        }
                    } }
                }
            }`,
        };

        const res = await fetch(`${finaleApiBase}/${finaleAccountPath}/api/graphql`, {
            method: "POST",
            headers: { Authorization: finaleAuthHeader, "Content-Type": "application/json" },
            body: JSON.stringify(query),
        });
        const json: any = await res.json();
        const edges: any[] = json?.data?.orderViewConnection?.edges ?? [];

        const qtys: number[] = [];
        for (const e of edges) {
            const po = e.node;
            const partyUrl: string = po.supplier?.partyUrl ?? "";
            const partyId = partyUrl.split("/").pop();
            if (partyId !== vendorPartyId) continue;
            for (const ie of (po.itemList?.edges ?? [])) {
                const q = Number(ie.node?.quantity);
                if (Number.isFinite(q) && q > 0) qtys.push(q);
            }
            if (qtys.length >= limit) break;
        }
        return qtys.slice(0, limit);
    } catch (err: any) {
        console.warn(`[calibration] loadVendorRecentLineQtys failed for ${vendorPartyId}: ${err.message}`);
        return [];
    }
}

// ──────────────────────────────────────────────────
// VENDOR REORDER POLICY (planning preferences)
// ──────────────────────────────────────────────────

export type VendorMoqMode = "enforce" | "warn" | "ignore";

export interface VendorReorderPolicy {
    vendorPartyId: string;
    vendorName: string | null;
    leadTimeOverrideDays: number | null;
    targetCoverDays: number | null;
    moqMode: VendorMoqMode;
    overbuyReviewPct: number;
    overbuyReviewDollars: number;
    notes: string | null;
    /**
     * v2.2 — explicit favorite batch sizes for cognitive rounding
     * (vendor_reorder_policies.favorite_batches). NULL when not set;
     * recommender then learns from PO history or falls back to the
     * cognitive ladder.
     */
    favoriteBatches: number[] | null;
}

/**
 * Load vendor-level reorder planning policies. Separate from MOQ facts:
 * MOQ rows are *what the vendor said*, policy rows are *how we choose to
 * handle it* (enforce / warn / ignore) plus cover-window and lead-time
 * overrides.
 *
 * Best-effort: a Supabase outage returns an empty map and the recommender
 * falls back to system defaults — the default-unchanged invariant.
 */
export async function loadVendorReorderPolicies(
    vendorPartyIds: string[],
): Promise<Map<string, VendorReorderPolicy>> {
    const map = new Map<string, VendorReorderPolicy>();
    if (vendorPartyIds.length === 0) return map;
    const db = createClient();
    if (!db) return map;
    try {
        const { data } = await db
            .from("vendor_reorder_policies")
            .select("vendor_party_id, vendor_name, lead_time_override_days, target_cover_days, moq_mode, overbuy_review_pct, overbuy_review_dollars, notes, favorite_batches")
            .in("vendor_party_id", vendorPartyIds);
        for (const row of data ?? []) {
            map.set(row.vendor_party_id, {
                vendorPartyId: row.vendor_party_id,
                vendorName: row.vendor_name ?? null,
                leadTimeOverrideDays: row.lead_time_override_days,
                targetCoverDays: row.target_cover_days,
                moqMode: (row.moq_mode ?? "enforce") as VendorMoqMode,
                overbuyReviewPct: Number(row.overbuy_review_pct ?? 50),
                overbuyReviewDollars: Number(row.overbuy_review_dollars ?? 1000),
                notes: row.notes ?? null,
                favoriteBatches: Array.isArray(row.favorite_batches) && row.favorite_batches.length > 0
                    ? row.favorite_batches.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
                    : null,
            });
        }
    } catch (err: any) {
        console.warn(`[calibration] loadVendorReorderPolicies failed: ${err.message}`);
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

// ──────────────────────────────────────────────────
// REC → DRAFT PO BACKREF (Phase C)
// ──────────────────────────────────────────────────

export interface DraftedPOLink {
    productId: string;
    vendorPartyId: string | null;
    draftedQty: number;
}

/**
 * Stamp the most recent uncalibrated, unlinked recommendation per (vendor, SKU)
 * with the draft PO number that consumed it. Best-effort.
 *
 * Logic per item: take the most recent qty_recommendations row matching
 * (vendor_party_id, product_id) that has no resulting_po_number set yet — that
 * is the recommendation Will saw on the dashboard right before clicking Draft PO.
 * Stamp the orderId, drafted timestamp, and the actual qty drafted (which may
 * differ from recommended_qty if Will edited it).
 *
 * Multiple SKUs per PO → one stamp per SKU. If a SKU has no recent rec
 * (e.g. manual add, or older than the lookup window), it's silently skipped —
 * no harm, just no backref for that line.
 */
export async function stampRecommendationsWithDraftPO(
    draftPONumber: string,
    items: DraftedPOLink[],
): Promise<number> {
    if (items.length === 0) return 0;
    const db = createClient();
    if (!db) return 0;

    let stamped = 0;
    const draftedAt = new Date().toISOString();
    // Lookback window: 30d. Recs older than this almost certainly weren't the
    // one Will acted on. Tighter than the 60d calibration window because the
    // draft action is a real-time event.
    const sinceIso = new Date(Date.now() - 30 * 86400_000).toISOString();

    for (const item of items) {
        try {
            // Find the most recent unstamped rec for this (vendor, SKU).
            const query = db
                .from("qty_recommendations")
                .select("id")
                .eq("product_id", item.productId)
                .is("resulting_po_number", null)
                .gte("recommended_at", sinceIso)
                .order("recommended_at", { ascending: false })
                .limit(1);
            // vendor_party_id may be null on either side; only filter when known.
            if (item.vendorPartyId) query.eq("vendor_party_id", item.vendorPartyId);

            const { data: candidates, error: selErr } = await query;
            if (selErr) {
                console.warn(`[calibration] stamp lookup failed for ${item.productId}: ${selErr.message}`);
                continue;
            }
            if (!candidates || candidates.length === 0) continue;

            const { error: updErr } = await db
                .from("qty_recommendations")
                .update({
                    resulting_po_number: draftPONumber,
                    resulting_po_drafted_at: draftedAt,
                    resulting_po_drafted_qty: item.draftedQty,
                })
                .eq("id", candidates[0].id);
            if (updErr) {
                console.warn(`[calibration] stamp update failed for ${item.productId}: ${updErr.message}`);
                continue;
            }
            stamped++;
        } catch (err: any) {
            console.warn(`[calibration] stampRecommendationsWithDraftPO exception for ${item.productId}: ${err.message}`);
        }
    }
    return stamped;
}

// ──────────────────────────────────────────────────
// REC SUMMARY READ (for dashboard ribbon)
// ──────────────────────────────────────────────────

export interface DraftedPORecSummary {
    poNumber: string;
    productId: string;
    recommendedQty: number;
    draftedQty: number;
    recommendedAt: string;
    draftedAt: string;
}

/** Read back the rec → PO link rows for a list of PO numbers. */
export async function loadDraftedPORecSummaries(
    poNumbers: string[],
): Promise<Map<string, DraftedPORecSummary[]>> {
    const map = new Map<string, DraftedPORecSummary[]>();
    if (poNumbers.length === 0) return map;
    const db = createClient();
    if (!db) return map;
    try {
        const { data } = await db
            .from("qty_recommendations")
            .select("resulting_po_number, product_id, recommended_qty, resulting_po_drafted_qty, recommended_at, resulting_po_drafted_at")
            .in("resulting_po_number", poNumbers);
        for (const row of data ?? []) {
            const po = row.resulting_po_number;
            if (!po) continue;
            if (!map.has(po)) map.set(po, []);
            map.get(po)!.push({
                poNumber: po,
                productId: row.product_id,
                recommendedQty: Number(row.recommended_qty ?? 0),
                draftedQty: Number(row.resulting_po_drafted_qty ?? 0),
                recommendedAt: row.recommended_at,
                draftedAt: row.resulting_po_drafted_at,
            });
        }
    } catch (err: any) {
        console.warn(`[calibration] loadDraftedPORecSummaries failed: ${err.message}`);
    }
    return map;
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
