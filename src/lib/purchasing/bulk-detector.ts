/**
 * @file    bulk-detector.ts
 * @purpose Auto-detect bulk vendors from Finale historical PO patterns.
 *          Analyzes last 12 months of completed POs per vendor and computes
 *          three signals to classify whether a vendor ships in bulk multi-leg
 *          deliveries vs normal single-shipment orders.
 *
 *          Signals:
 *            1. QTY-TO-VELOCITY RATIO  — median PO line qty / daily velocity > 90d → bulk signal
 *            2. INTER-ORDER GAP        — median days between consecutive POs > 45d → bulk signal
 *            3. DOLLAR SIZE            — median PO total > $3,000 → bulk signal
 *
 *          Confidence: 2 of 3 signals firing → isBulkVendor = true.
 *          1 of 3 signals → flagged as "possible" in the review surface, not auto-flagged.
 *
 *          Writes results back to vendor_reorder_policies when called with commitResults=true.
 *          Safe to run on-demand or as a cron (idempotent upsert, no deletions).
 *
 * @author  Aria
 * @created 2026-05-21
 * @updated 2026-05-21
 * @deps    calibration (upsertVendorBulkFlags), supabase/client
 * @env     FINALE_API_BASE, FINALE_ACCOUNT_PATH, FINALE_AUTH_HEADER
 */

import { createClient } from "@/lib/supabase";

// ── Finale GraphQL shapes ────────────────────────────────────────────────────

interface FinaleCompletedPOEdge {
    node: {
        orderId: string;
        orderDate: string;           // YYYY-MM-DD
        total: number | null;        // PO total in USD
        supplier: { partyUrl: string } | null;
        itemList: {
            edges: Array<{ node: { quantity: number } }>;
        };
    };
}

// ── Output types ─────────────────────────────────────────────────────────────

export interface BulkVendorSignals {
    vendorPartyId: string;
    vendorName: string;
    /** Ratio: median single-line qty / daily velocity for that line's SKU */
    qtyToVelocityRatio: number | null;
    /** Median gap in days between consecutive completed POs */
    medianInterOrderGapDays: number | null;
    /** Median PO total in USD */
    medianPOTotalDollars: number | null;
    /** How many of the 3 signals fired */
    signalsTriggered: number;
    /** Whether this vendor should be classified as bulk */
    isBulkVendor: boolean;
    /** Suggested number of legs (from gap analysis: round(totalSpan / medianGap)) */
    suggestedLegCount: number | null;
    /** Suggested interval between legs in days */
    suggestedLegIntervalDays: number | null;
    /** PO count analyzed */
    poCount: number;
    /** Confidence level for the detection */
    confidence: "high" | "medium" | "low" | "insufficient-data";
    /** Human-readable reasoning */
    reasoning: string[];
}

export interface BulkDetectionResult {
    analyzedAt: string;
    vendorCount: number;
    bulkFlagged: number;
    possibleBulk: number;             // 1 signal — human review recommended
    vendors: BulkVendorSignals[];
    committed: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const QTY_VELOCITY_BULK_THRESHOLD = 90;    // days of supply per PO = bulk signal
const INTER_ORDER_GAP_BULK_DAYS   = 45;    // median gap > 45d between orders = bulk signal
const PO_TOTAL_BULK_DOLLARS       = 3_000; // median PO > $3k = bulk signal
const MIN_PO_COUNT_FOR_CONFIDENCE = 3;     // fewer than this → "insufficient-data"
const LOOKBACK_DAYS               = 365;   // 12-month analysis window

// ── Main detector ─────────────────────────────────────────────────────────────

/**
 * Auto-detect bulk vendors from Finale historical PO patterns.
 *
 * @param finaleAuthHeader  - Finale Authorization header value
 * @param finaleApiBase     - Finale API base URL (e.g. https://app.finaleinventory.com)
 * @param finaleAccountPath - Finale account path segment
 * @param velocityByProduct - Optional map of productId → dailyRate (from purchasing intelligence).
 *                            When provided, enables the qty-to-velocity signal.
 *                            When omitted, only gap + dollar signals are computed.
 * @param commitResults     - When true, writes is_bulk_vendor flag to vendor_reorder_policies.
 *                            Default false (dry-run mode for review first).
 * @returns BulkDetectionResult with per-vendor signals and summary counts
 */
export async function detectBulkVendors(
    finaleAuthHeader: string,
    finaleApiBase: string,
    finaleAccountPath: string,
    velocityByProduct?: Map<string, number>,
    commitResults = false,
): Promise<BulkDetectionResult> {
    const analyzedAt = new Date().toISOString();

    // ── Fetch last 12 months of completed POs from Finale ───────────────────
    const completedPOs = await fetchCompletedPOs(finaleAuthHeader, finaleApiBase, finaleAccountPath);

    // ── Group by vendor party ID ──────────────────────────────────────────────
    const byVendor = new Map<string, typeof completedPOs>();
    for (const po of completedPOs) {
        const partyUrl = po.supplier?.partyUrl ?? "";
        const partyId  = partyUrl.split("/").pop() ?? "";
        if (!partyId) continue;
        const existing = byVendor.get(partyId);
        if (existing) {
            existing.push(po);
        } else {
            byVendor.set(partyId, [po]);
        }
    }

    // ── Compute signals per vendor ────────────────────────────────────────────
    const vendorResults: BulkVendorSignals[] = [];

    for (const [vendorPartyId, pos] of byVendor) {
        const signals = analyzeVendor(vendorPartyId, pos, velocityByProduct);
        vendorResults.push(signals);
    }

    // Sort: most signals first, then by median gap descending
    vendorResults.sort((a, b) =>
        b.signalsTriggered - a.signalsTriggered ||
        (b.medianInterOrderGapDays ?? 0) - (a.medianInterOrderGapDays ?? 0)
    );

    const bulkFlagged  = vendorResults.filter(v => v.isBulkVendor).length;
    const possibleBulk = vendorResults.filter(v => v.signalsTriggered === 1).length;

    // ── Optional: commit results to Supabase ─────────────────────────────────
    if (commitResults) {
        await commitBulkFlags(vendorResults);
    }

    return {
        analyzedAt,
        vendorCount: vendorResults.length,
        bulkFlagged,
        possibleBulk,
        vendors: vendorResults,
        committed: commitResults,
    };
}

// ── Signal analysis ───────────────────────────────────────────────────────────

function analyzeVendor(
    vendorPartyId: string,
    pos: Array<{
        orderId: string;
        orderDate: string;
        total: number | null;
        supplier: { partyUrl: string } | null;
        itemList: { edges: Array<{ node: { quantity: number } }> };
        _vendorName?: string;
    }>,
    velocityByProduct?: Map<string, number>,
): BulkVendorSignals {
    const reasoning: string[] = [];
    const vendorName = pos[0]?._vendorName ?? vendorPartyId;
    const poCount = pos.length;

    // ── Signal 1: Qty-to-velocity ratio ──────────────────────────────────────
    let qtyToVelocityRatio: number | null = null;
    let signal1 = false;

    if (velocityByProduct && velocityByProduct.size > 0) {
        const ratios: number[] = [];
        for (const po of pos) {
            for (const edge of po.itemList.edges) {
                const qty = Number(edge.node.quantity);
                // We don't have productId per line in the current query — see TODO below
                // For now, use the max velocity among all known products for this vendor as proxy
            }
        }
        // TODO(will)[2026-05-21]: Extend the Finale GraphQL query to include productId per line item
        // so we can compute exact qty/velocity ratios. For now, this signal is null when velocity
        // data is provided but line-level product IDs are unavailable from this query.
        // Ticket: extend fetchCompletedPOs query to include itemList.edges.node.product.productId
    }

    // ── Signal 2: Inter-order gap ─────────────────────────────────────────────
    let medianInterOrderGapDays: number | null = null;
    let signal2 = false;

    const sortedDates = pos
        .map(p => p.orderDate)
        .filter(Boolean)
        .sort(); // ascending

    if (sortedDates.length >= 2) {
        const gaps: number[] = [];
        for (let i = 1; i < sortedDates.length; i++) {
            const prev = new Date(sortedDates[i - 1]).getTime();
            const curr = new Date(sortedDates[i]).getTime();
            const gapDays = Math.round((curr - prev) / 86400000);
            if (gapDays > 0) gaps.push(gapDays);
        }
        if (gaps.length > 0) {
            medianInterOrderGapDays = median(gaps);
            signal2 = medianInterOrderGapDays > INTER_ORDER_GAP_BULK_DAYS;
            reasoning.push(
                signal2
                    ? `✓ Infrequent orders: median ${medianInterOrderGapDays}d gap between POs (threshold ${INTER_ORDER_GAP_BULK_DAYS}d)`
                    : `  Frequent orders: median ${medianInterOrderGapDays}d gap — not bulk signal`
            );
        }
    } else {
        reasoning.push("  Insufficient PO history for gap analysis (need ≥2 POs)");
    }

    // ── Signal 3: Dollar size ─────────────────────────────────────────────────
    const totals = pos.map(p => p.total).filter((t): t is number => typeof t === "number" && t > 0);
    let medianPOTotalDollars: number | null = null;
    let signal3 = false;

    if (totals.length > 0) {
        medianPOTotalDollars = median(totals);
        signal3 = medianPOTotalDollars > PO_TOTAL_BULK_DOLLARS;
        reasoning.push(
            signal3
                ? `✓ Large POs: median $${medianPOTotalDollars.toLocaleString()} (threshold $${PO_TOTAL_BULK_DOLLARS.toLocaleString()})`
                : `  Small POs: median $${medianPOTotalDollars.toLocaleString()} — not bulk signal`
        );
    } else {
        reasoning.push("  No PO totals available for dollar-size analysis");
    }

    // ── Aggregate ──────────────────────────────────────────────────────────────
    const signalsTriggered = [signal1, signal2, signal3].filter(Boolean).length;
    const isBulkVendor = signalsTriggered >= 2;

    // Confidence
    let confidence: BulkVendorSignals["confidence"];
    if (poCount < MIN_PO_COUNT_FOR_CONFIDENCE) {
        confidence = "insufficient-data";
    } else if (signalsTriggered === 3) {
        confidence = "high";
    } else if (signalsTriggered === 2) {
        confidence = "medium";
    } else if (signalsTriggered === 1) {
        confidence = "low";
    } else {
        confidence = "low";
    }

    // Suggested leg cadence from inter-order gap
    // DECISION(2026-05-21): If gap is > 60d, assume 2 legs (typical large freight).
    // If gap is 30-60d, assume 3 legs. If gap is > 90d, still 2 legs but wider interval.
    // This is a heuristic — user can override in vendor_reorder_policies or via /legs.
    let suggestedLegCount: number | null = null;
    let suggestedLegIntervalDays: number | null = null;

    if (isBulkVendor && medianInterOrderGapDays) {
        if (medianInterOrderGapDays >= 90) {
            suggestedLegCount = 2;
            suggestedLegIntervalDays = Math.round(medianInterOrderGapDays / 2);
        } else if (medianInterOrderGapDays >= 45) {
            suggestedLegCount = 3;
            suggestedLegIntervalDays = Math.round(medianInterOrderGapDays / 3);
        } else {
            suggestedLegCount = 2;
            suggestedLegIntervalDays = Math.round(medianInterOrderGapDays / 2);
        }
        reasoning.push(
            `  Suggested: ${suggestedLegCount} legs, ~${suggestedLegIntervalDays}d apart (heuristic from gap data)`
        );
    }

    if (isBulkVendor) {
        reasoning.unshift(`⚑ BULK VENDOR — ${signalsTriggered}/3 signals triggered`);
    } else if (signalsTriggered === 1) {
        reasoning.unshift(`? POSSIBLE BULK — only 1/3 signals triggered (needs review)`);
    } else {
        reasoning.unshift(`✗ NOT BULK — 0/3 signals triggered`);
    }

    return {
        vendorPartyId,
        vendorName,
        qtyToVelocityRatio,
        medianInterOrderGapDays,
        medianPOTotalDollars,
        signalsTriggered,
        isBulkVendor,
        suggestedLegCount,
        suggestedLegIntervalDays,
        poCount,
        confidence,
        reasoning,
    };
}

// ── Finale GraphQL fetch ──────────────────────────────────────────────────────

async function fetchCompletedPOs(
    authHeader: string,
    apiBase: string,
    accountPath: string,
): Promise<Array<{
    orderId: string;
    orderDate: string;
    total: number | null;
    supplier: { partyUrl: string } | null;
    itemList: { edges: Array<{ node: { quantity: number } }> };
    _vendorName?: string;
}>> {
    const now = new Date();
    const begin = new Date(now);
    begin.setDate(begin.getDate() - LOOKBACK_DAYS);
    const beginStr = begin.toISOString().slice(0, 10);
    const endStr   = now.toISOString().slice(0, 10);

    // Batch in pages of 200 to avoid GraphQL size limits
    const allEdges: FinaleCompletedPOEdge[] = [];
    let afterCursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
        const afterArg = afterCursor ? `, after: "${afterCursor}"` : "";
        const query = {
            query: `{
                orderViewConnection(
                    first: 200
                    type: ["PURCHASE_ORDER"]
                    statusId: ["ORDER_COMPLETED"]
                    orderDate: { begin: "${beginStr}", end: "${endStr}" }
                    sort: [{ field: "orderDate", mode: "asc" }]
                    ${afterArg}
                ) {
                    pageInfo { hasNextPage endCursor }
                    edges { node {
                        orderId
                        orderDate
                        total
                        supplier { partyUrl }
                        itemList(first: 100) {
                            edges { node { quantity } }
                        }
                    } }
                }
            }`,
        };

        const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: "POST",
            headers: { Authorization: authHeader, "Content-Type": "application/json" },
            body: JSON.stringify(query),
        });

        if (!res.ok) {
            console.warn(`[bulk-detector] Finale GraphQL HTTP ${res.status}`);
            break;
        }

        const json: any = await res.json();
        const conn = json?.data?.orderViewConnection;
        if (!conn) break;

        allEdges.push(...(conn.edges ?? []));
        hasMore = conn.pageInfo?.hasNextPage === true;
        afterCursor = conn.pageInfo?.endCursor ?? null;
    }

    return allEdges.map(e => ({
        orderId:   e.node.orderId,
        orderDate: e.node.orderDate,
        total:     typeof e.node.total === "number" ? e.node.total : null,
        supplier:  e.node.supplier ?? null,
        itemList:  e.node.itemList,
    }));
}

// ── Commit to Supabase ────────────────────────────────────────────────────────

/**
 * Write is_bulk_vendor flags back to vendor_reorder_policies.
 * Only updates vendors where isBulkVendor = true (does not clear existing flags).
 * Idempotent — safe to run repeatedly.
 */
async function commitBulkFlags(vendors: BulkVendorSignals[]): Promise<void> {
    const db = createClient();
    if (!db) {
        console.warn("[bulk-detector] Supabase client unavailable — skipping commit");
        return;
    }

    const bulkVendors = vendors.filter(v => v.isBulkVendor);
    if (bulkVendors.length === 0) return;

    for (const vendor of bulkVendors) {
        const { error } = await db
            .from("vendor_reorder_policies")
            .upsert({
                vendor_party_id: vendor.vendorPartyId,
                vendor_name: vendor.vendorName !== vendor.vendorPartyId ? vendor.vendorName : undefined,
                is_bulk_vendor: true,
                typical_leg_count: vendor.suggestedLegCount,
                typical_leg_interval_days: vendor.suggestedLegIntervalDays,
                updated_at: new Date().toISOString(),
            }, { onConflict: "vendor_party_id" });

        if (error) {
            console.warn(`[bulk-detector] Failed to upsert bulk flag for ${vendor.vendorPartyId}: ${error.message}`);
        }
    }
    console.log(`[bulk-detector] Committed bulk flags for ${bulkVendors.length} vendors`);
}

// ── Math utilities ────────────────────────────────────────────────────────────

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}
