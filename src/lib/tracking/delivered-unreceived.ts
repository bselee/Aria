/**
 * @file    src/lib/tracking/delivered-unreceived.ts
 * @purpose Shared thresholds + pure helpers for "carrier delivered, Finale not
 *          received yet" aging. Reception is handled by warehouse/others —
 *          Aria only FLAGS when lag crosses 24h / 48h.
 *
 * Thresholds (Bill 2026-08-05):
 *   < 24h  → watch (recent delivery, no alert noise)
 *   ≥ 24h  → flag (visible on Active Purchases + weekday TG digest)
 *   ≥ 48h  → escalate (stronger UI + TG priority)
 *
 * @author  Hermia
 * @created 2026-08-05
 */

/** Hours after carrier-delivered before we flag unreceived. */
export const DELIVERED_FLAG_HOURS = 24;
/** Hours after carrier-delivered before we escalate the flag. */
export const DELIVERED_ESCALATE_HOURS = 48;

export type ReceiptLagLevel = "ok" | "flag" | "escalate";

/**
 * Pure age calculator from delivered_at ISO → whole hours (floor).
 * Returns null if timestamp missing/invalid.
 */
export function hoursSinceDelivered(
    deliveredAt: string | null | undefined,
    nowMs: number = Date.now(),
): number | null {
    if (!deliveredAt) return null;
    const t = new Date(deliveredAt).getTime();
    if (Number.isNaN(t)) return null;
    return Math.floor((nowMs - t) / 3_600_000);
}

/**
 * Map hours-since-delivery → lag level for UI/alerts.
 * Not received is assumed by the caller.
 */
export function receiptLagLevel(hours: number | null | undefined): ReceiptLagLevel {
    if (hours == null || hours < DELIVERED_FLAG_HOURS) return "ok";
    if (hours < DELIVERED_ESCALATE_HOURS) return "flag";
    return "escalate";
}

/**
 * Earliest delivered_at among confirmed delivered shipments.
 */
export function earliestDeliveredAt(
    shipments: Array<{ status_category?: string | null; delivered_at?: string | null }>,
): string | null {
    const times: number[] = [];
    for (const s of shipments) {
        if ((s.status_category || "").toLowerCase() !== "delivered") continue;
        if (!s.delivered_at) continue;
        const t = new Date(s.delivered_at).getTime();
        if (!Number.isNaN(t)) times.push(t);
    }
    if (times.length === 0) return null;
    return new Date(Math.min(...times)).toISOString();
}

export function formatReceiptLagBadge(hours: number, level: ReceiptLagLevel): string {
    if (level === "ok") return `DELIVERED · need receive`;
    if (level === "flag") return `DELIVERED ${hours}h · need receive`;
    return `DELIVERED ${hours}h · OVERDUE receive`;
}
