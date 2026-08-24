/**
 * @file    src/lib/purchasing/basauto-recon-live.ts
 * @purpose Recompute the basauto↔Aria verdict for one Ordering row against the
 *          row's LIVE Aria state instead of trusting the 07:00 crawl snapshot.
 *
 *          The recon report is written once a day, but Ordering rows carry
 *          live SWR numbers. A PO drafted at 10 AM can invalidate the morning
 *          verdict by noon (e.g. QTY_MISMATCH becomes OVERBUY_RISK once Aria
 *          counts the new committed supply, or both systems go calm and the
 *          badge should disappear). This module reruns the same pure assessor
 *          the crawl used (`assessBasautoItem`) with the basauto side still
 *          from the crawl and the Aria side from the live row.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    basauto-recon.ts (assessBasautoItem), basauto-recon-lookup.ts (types)
 * @env     none
 */

import {
    assessBasautoItem,
    type AriaItemLite,
    type BasautoRecord,
} from "./basauto-recon";
import type { ReconBadge } from "./basauto-recon-lookup";

/** Live Aria numbers for one row, as the purchasing route has them post-assessment. */
export interface LiveRowAria {
    productId: string;
    urgency: string | null;
    stockOnHand: number | null;
    stockOnOrder: number | null;
    dailyRate: number | null;
    dailyRateSource: string | null;
    leadTimeDays: number | null;
    effectiveLeadTimeDays: number | null;
    adjustedRunwayDays: number | null;
    runwayDays: number | null;
    openPOs: Array<{ orderId: string; quantity: number; orderDate?: string | null }>;
    suggestedQty: number | null;
}

/**
 * Re-run the reconciliation verdict with the Aria side replaced by live row
 * state. The basauto side necessarily stays the crawl snapshot (that is when
 * basauto was read), so the badge keeps its crawl timestamp for honesty.
 *
 * @param badge     Snapshot badge from data/basauto-recon.json.
 * @param liveAria  The row's current Aria numbers (post coverage/hold logic).
 * @param crawledAt Crawl timestamp to stamp on the recomputed badge.
 * @returns         The badge with a live verdict, or null when both systems
 *                  are calm against live numbers (nothing to show on the row).
 */
export function recomputeBasautoBadge(
    badge: ReconBadge,
    liveAria: LiveRowAria,
    crawledAt: string | null,
): ReconBadge | null {
    const bas = badge.basauto;
    if (!bas) return badge; // no basauto side to assess against — keep snapshot

    const basRecord: BasautoRecord = {
        productId: liveAria.productId,
        description: null,
        supplier: null,
        urgency: bas.urgency ?? "OK",
        stockDaysLeft: bas.stockDaysLeft,
        reorderQty: bas.reorderQty,
        reorderDate: bas.reorderDate,
        onOrder: bas.onOrder,
        quantityInDrafts: null,
        supplierLeadDays: null,
        velocity: bas.velocity,
        lastReceived: null,
        quantity: null,
    };

    const ariaLite: AriaItemLite = {
        productId: liveAria.productId,
        urgency: liveAria.urgency,
        stockOnHand: liveAria.stockOnHand,
        stockOnOrder: liveAria.stockOnOrder,
        dailyRate: liveAria.dailyRate,
        dailyRateSource: liveAria.dailyRateSource,
        leadTimeDays: liveAria.leadTimeDays,
        effectiveLeadTimeDays: liveAria.effectiveLeadTimeDays,
        adjustedRunwayDays: liveAria.adjustedRunwayDays,
        runwayDays: liveAria.runwayDays,
        openPOs: liveAria.openPOs,
        suggestedQty: liveAria.suggestedQty,
        assessmentRecommendedQty: null,
    };

    const item = assessBasautoItem(basRecord, ariaLite);
    if (!item) return null; // both calm now — the third opinion adds nothing

    return {
        ...badge,
        verdict: item.verdict,
        severity: item.severity,
        reason: item.reason,
        crawledAt,
        live: true,
    };
}
