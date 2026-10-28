/**
 * @file    src/lib/tracking/accuracy-report.ts
 * @purpose Weekly realized-vs-predicted accuracy for the tracking system so
 *          arrivals confidence stops being a feeling and becomes a number
 *          (Bill, 2026-10-28). Pure computation + a reporter that writes the
 *          summary to the activity log. Silent — no Slack, no Telegram.
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    @/lib/db
 */

import { createClient } from "@/lib/db";

export interface TrackingAccuracySnapshot {
    deliveredLast7d: number;
    deliveredWithEta: number;
    etaSameDay: number;
    etaLate: number;
    etaEarly: number;
    nonDelivered: number;
    nonDeliveredStale24h: number;
    ofdCount: number;
}

export interface TrackingAccuracyReport {
    snapshot: TrackingAccuracySnapshot;
    etaCoveragePct: number;
    onTimePct: number | null;
    stalePct: number;
    summary: string;
}

/** Pure: build the report from raw counts. */
export function buildAccuracyReport(s: TrackingAccuracySnapshot): TrackingAccuracyReport {
    const etaCoveragePct = s.deliveredLast7d > 0 ? Math.round((s.deliveredWithEta / s.deliveredLast7d) * 100) : 0;
    const withEtaRows = s.etaSameDay + s.etaLate + s.etaEarly;
    const onTimePct = withEtaRows > 0 ? Math.round((s.etaSameDay / withEtaRows) * 100) : null;
    const stalePct = s.nonDelivered > 0 ? Math.round((s.nonDeliveredStale24h / s.nonDelivered) * 100) : 0;
    const summary =
        `tracking accuracy: delivered7d=${s.deliveredLast7d} etaCoverage=${etaCoveragePct}% ` +
        `onTime=${onTimePct == null ? "n/a" : `${onTimePct}%`} stale24h=${stalePct}% ofd=${s.ofdCount}`;
    return { snapshot: s, etaCoveragePct, onTimePct, stalePct, summary };
}

/**
 * Measure the live tables and write the summary to `ap_activity_log`
 * (intent TRACKING_ACCURACY_REPORT). Best-effort — never throws.
 */
export async function runTrackingAccuracyReport(): Promise<TrackingAccuracyReport | { error: string }> {
    const db = createClient();
    if (!db) return { error: "DB unavailable" };
    try {
        const { data: deliveredRows } = await db
            .from("shipments")
            .select("estimated_delivery_at, delivered_at")
            .eq("active", true)
            .not("delivered_at", "is", null)
            .gte("delivered_at", new Date(Date.now() - 7 * 86400_000).toISOString())
            .limit(5000);

        const { data: nonDeliveredRows } = await db
            .from("shipments")
            .select("status_category, last_checked_at")
            .eq("active", true)
            .is("delivered_at", null)
            .limit(5000);

        const delivered = (deliveredRows || []) as Array<{ estimated_delivery_at: string | null; delivered_at: string | null }>;
        const nonDelivered = (nonDeliveredRows || []) as Array<{ status_category: string | null; last_checked_at: string | null }>;

        const snap: TrackingAccuracySnapshot = {
            deliveredLast7d: delivered.length,
            deliveredWithEta: delivered.filter((r) => r.estimated_delivery_at != null).length,
            etaSameDay: delivered.filter(
                (r) => r.estimated_delivery_at != null && r.delivered_at?.slice(0, 10) === r.estimated_delivery_at.slice(0, 10),
            ).length,
            etaLate: delivered.filter(
                (r) =>
                    r.estimated_delivery_at != null &&
                    r.delivered_at != null &&
                    r.delivered_at.slice(0, 10) > r.estimated_delivery_at.slice(0, 10),
            ).length,
            etaEarly: delivered.filter(
                (r) =>
                    r.estimated_delivery_at != null &&
                    r.delivered_at != null &&
                    r.delivered_at.slice(0, 10) < r.estimated_delivery_at.slice(0, 10),
            ).length,
            nonDelivered: nonDelivered.length,
            nonDeliveredStale24h: nonDelivered.filter((r) => {
                if (!r.last_checked_at) return true;
                return new Date(r.last_checked_at).getTime() < Date.now() - 86400_000;
            }).length,
            ofdCount: nonDelivered.filter((r) => r.status_category === "out_for_delivery").length,
        };

        const report = buildAccuracyReport(snap);
        await db.from("ap_activity_log").insert({
            intent: "TRACKING_ACCURACY_REPORT",
            created_at: new Date().toISOString(),
            metadata: report,
        });
        console.log(`[tracking-accuracy] ${report.summary}`);
        return report;
    } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
    }
}
