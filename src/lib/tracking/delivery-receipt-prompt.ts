/**
 * @file    src/lib/tracking/delivery-receipt-prompt.ts
 * @purpose Flag POs that are carrier-delivered but not Finale-received past 24h,
 *          escalate past 48h. Reception is owned by warehouse/others — Aria does
 *          NOT auto-receive; we only notify so the lag is visible.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @updated 2026-08-05 — fix shipments table, 24/48h thresholds, no fake "confirm receive" ownership
 * @deps    @/lib/db, @/lib/intelligence/telegram-notify, delivered-unreceived
 *
 * DESIGN:
 *   Cron delivery-receipt-prompt (4x/day weekdays).
 *   Queries shipments where status_category=delivered and delivered_at ≥ 24h ago.
 *   Skips POs already received (purchase_orders status/lifecycle).
 *   Telegram digest: flag (24–47h) + escalate (≥48h). Dedup via ap_activity_log.
 */

import { createClient } from "@/lib/db";
import { sendTelegramNotify } from "@/lib/intelligence/telegram-notify";
import {
    DELIVERED_ESCALATE_HOURS,
    DELIVERED_FLAG_HOURS,
    hoursSinceDelivered,
    receiptLagLevel,
} from "@/lib/tracking/delivered-unreceived";

/** Look back this far for delivered shipments still open. */
const LOOKBACK_HOURS = 14 * 24; // 14 days

/** In-memory dedup: PO numbers already prompted this process lifetime */
const promptedThisSession = new Set<string>();

/** Don't re-alert the same PO more often than this. */
const DEDUP_HOURS = 12;

export interface DeliveryReceiptCandidate {
    poNumber: string;
    vendorName: string | null;
    trackingNumber: string;
    carrierName: string | null;
    deliveredAt: string;
    hoursSinceDelivery: number;
    lag: "flag" | "escalate";
}

export interface ReceiptPromptResult {
    prompted: number;
    skippedAlreadyPrompted: number;
    skippedNoCandidates: boolean;
    candidates: DeliveryReceiptCandidate[];
}

/**
 * Find delivered-but-unreceived shipments past 24h and send a Telegram flag digest.
 * Called from delivery-receipt-prompt cron.
 */
export async function promptDeliveredReceipts(): Promise<ReceiptPromptResult> {
    const db = createClient();
    if (!db) {
        return { prompted: 0, skippedAlreadyPrompted: 0, skippedNoCandidates: true, candidates: [] };
    }

    const now = new Date();
    const lookbackCutoff = new Date(now.getTime() - LOOKBACK_HOURS * 3600000).toISOString();
    const flagCutoff = new Date(now.getTime() - DELIVERED_FLAG_HOURS * 3600000).toISOString();

    // Real table is `shipments` (shipment_intelligence was wrong and returned nothing)
    const { data: shipments, error } = await db
        .from("shipments")
        .select("tracking_number, po_numbers, vendor_names, carrier_name, delivered_at, status_category, active")
        .eq("status_category", "delivered")
        .eq("active", true)
        .not("delivered_at", "is", null)
        .lte("delivered_at", flagCutoff)
        .gte("delivered_at", lookbackCutoff)
        .limit(100);

    if (error || !shipments || shipments.length === 0) {
        if (error) console.warn(`[receipt-prompt] shipments query: ${error.message}`);
        return { prompted: 0, skippedAlreadyPrompted: 0, skippedNoCandidates: true, candidates: [] };
    }

    const allPoNumbers = [...new Set(shipments.flatMap((s: any) => (s.po_numbers || []) as string[]))];
    if (allPoNumbers.length === 0) {
        return { prompted: 0, skippedAlreadyPrompted: 0, skippedNoCandidates: true, candidates: [] };
    }

    // Treat lifecycle_stage RECEIVED or completion complete as already handled
    const { data: poRows } = await db
        .from("purchase_orders")
        .select("po_number, lifecycle_stage, completion_state")
        .in("po_number", allPoNumbers);

    const receivedSet = new Set<string>();
    for (const row of poRows || []) {
        const stage = String((row as any).lifecycle_stage || "").toLowerCase();
        const completion = String((row as any).completion_state || "").toLowerCase();
        if (
            stage === "received"
            || completion === "complete"
            || completion === "finale-received"
            || completion.startsWith("received_")
        ) {
            receivedSet.add((row as any).po_number);
        }
    }

    const dedupCutoff = new Date(now.getTime() - DEDUP_HOURS * 3600000).toISOString();
    const { data: recentPrompts } = await db
        .from("ap_activity_log")
        .select("metadata")
        .eq("intent", "RECEIPT_LAG_FLAG")
        .gte("created_at", dedupCutoff)
        .limit(300);

    const dbPromptedPOs = new Set<string>();
    for (const row of (recentPrompts || []) as any[]) {
        const po = row?.metadata?.poNumber;
        if (po) dbPromptedPOs.add(po);
    }

    const candidates: DeliveryReceiptCandidate[] = [];
    let skippedAlready = 0;
    const seenPo = new Set<string>();

    for (const s of shipments as any[]) {
        const poNumbers: string[] = s.po_numbers || [];
        for (const poNumber of poNumbers) {
            if (seenPo.has(poNumber)) continue;
            if (receivedSet.has(poNumber)) continue;

            if (promptedThisSession.has(poNumber) || dbPromptedPOs.has(poNumber)) {
                skippedAlready++;
                continue;
            }

            const hours = hoursSinceDelivered(s.delivered_at, now.getTime());
            if (hours == null || hours < DELIVERED_FLAG_HOURS) continue;
            const lag = receiptLagLevel(hours);
            if (lag === "ok") continue;

            seenPo.add(poNumber);
            candidates.push({
                poNumber,
                vendorName: (s.vendor_names || [])[0] || null,
                trackingNumber: s.tracking_number,
                carrierName: s.carrier_name,
                deliveredAt: s.delivered_at,
                hoursSinceDelivery: hours,
                lag: lag === "escalate" ? "escalate" : "flag",
            });
        }
    }

    // Escalate first, then flag; cap digest size
    candidates.sort((a, b) => {
        if (a.lag !== b.lag) return a.lag === "escalate" ? -1 : 1;
        return b.hoursSinceDelivery - a.hoursSinceDelivery;
    });
    const toPrompt = candidates.slice(0, 12);

    if (toPrompt.length > 0) {
        const escalate = toPrompt.filter((c) => c.lag === "escalate");
        const flag = toPrompt.filter((c) => c.lag === "flag");

        const lines: string[] = [];
        lines.push(`Delivered · not received (warehouse)`);
        lines.push(`Thresholds: flag ≥${DELIVERED_FLAG_HOURS}h · escalate ≥${DELIVERED_ESCALATE_HOURS}h`);
        lines.push(`—`);

        if (escalate.length > 0) {
            lines.push(`OVERDUE (≥${DELIVERED_ESCALATE_HOURS}h):`);
            for (const c of escalate) {
                lines.push(
                    `PO ${c.poNumber} · ${c.vendorName || "?"} · ${c.hoursSinceDelivery}h · ${c.carrierName || "carrier"} ${c.trackingNumber}`,
                );
            }
        }
        if (flag.length > 0) {
            lines.push(`Flag (≥${DELIVERED_FLAG_HOURS}h):`);
            for (const c of flag) {
                lines.push(
                    `PO ${c.poNumber} · ${c.vendorName || "?"} · ${c.hoursSinceDelivery}h · ${c.carrierName || "carrier"} ${c.trackingNumber}`,
                );
            }
        }
        lines.push(`—`);
        lines.push(`Aria does not receive in Finale — flag for receiving team.`);

        await sendTelegramNotify(lines.join("\n"));

        for (const c of toPrompt) {
            promptedThisSession.add(c.poNumber);
            try {
                await db.from("ap_activity_log").insert({
                    email_from: c.vendorName || "unknown",
                    email_subject: `Receipt lag ${c.lag}: PO ${c.poNumber}`,
                    intent: "RECEIPT_LAG_FLAG",
                    action_taken: `Flagged delivered-unreceived PO (${c.hoursSinceDelivery}h, ${c.lag})`,
                    metadata: {
                        poNumber: c.poNumber,
                        vendorName: c.vendorName,
                        trackingNumber: c.trackingNumber,
                        deliveredAt: c.deliveredAt,
                        hoursSinceDelivery: c.hoursSinceDelivery,
                        lag: c.lag,
                        promptedAt: now.toISOString(),
                    },
                });
            } catch { /* non-blocking */ }
        }

        console.log(`[receipt-prompt] Flagged ${toPrompt.length} PO(s) (escalate=${escalate.length}, flag=${flag.length})`);
    }

    return {
        prompted: toPrompt.length,
        skippedAlreadyPrompted: skippedAlready,
        skippedNoCandidates: false,
        candidates,
    };
}
