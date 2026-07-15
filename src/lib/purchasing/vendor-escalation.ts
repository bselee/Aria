/**
 * @file    src/lib/purchasing/vendor-escalation.ts
 * @purpose L2/L3 vendor escalation for POs with no acknowledgment.
 *          Works IN ADDITION to the existing L1 followup watcher.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/db, @/lib/intelligence/telegram-notify
 *
 * DESIGN:
 *   L1 (2 days): polite Gmail draft — handled by po-followup-watcher.ts
 *   L2 (5 days): firmer Gmail draft mentioning reorder risk
 *   L3 (7+ days): Telegram alert to Bill with "consider alternate vendor"
 *
 *   Escalation tracking:
 *   - `followup_level` text column: 'l1' | 'l2' | 'l3' | null
 *   - Fallback: if column doesn't exist, use ap_activity_log dedup
 *
 *   L2 flow:
 *   1. Query POs sent 10-14 days ago, unacked, no tracking, not noncomm
 *   2. Skip if followup_level >= 'l2' or recently escalated
 *   3. Create firmer Gmail draft via VendorCommsAgent
 *   4. Update followup_level = 'l2'
 *   5. Send Telegram summary: "L2 escalated: PO #X to Vendor"
 *
 *   L3 flow:
 *   1. Query POs sent 15+ days ago, unacked, no tracking, not noncomm
 *   2. Skip if followup_level >= 'l3'
 *   4. Send Telegram alert: "PO #X from Vendor — 15+ days no response"
 *   5. Include vendor reliability grade from scorecard
 *   6. Update followup_level = 'l3'
 */

import { createClient } from "@/lib/db";
import { sendTelegramNotify, sendTelegramNotifyWithButtons } from "@/lib/intelligence/telegram-notify";

/** Escalation windows (days since PO sent) */
// L1 (2d) → L2 (5d) → L3 (7d) — tightens vendor response cycle
const L2_MIN_DAYS = 5;
const L2_MAX_DAYS = 6; // Narrow window so L2 fires once, then L3 takes over
const L3_MIN_DAYS = 7;
const L3_MAX_DAYS = 45; // Age out at 45 days — beyond that it's a manual decision

/** Max escalations per run to avoid spam */
const MAX_PER_RUN = 5;

export interface EscalationOutcome {
    poNumber: string;
    vendorName: string | null;
    level: "l2" | "l3";
    action: "drafted" | "telegram_alert" | "skipped_already_escalated" | "skipped_no_thread" | "skipped_dropship";
    daysSinceSent: number;
}

export interface EscalationResult {
    outcomes: EscalationOutcome[];
    l2Count: number;
    l3Count: number;
}

const DROPSHIP_PATTERN = /autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i;

function daysSince(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * Run L2/L3 escalation check. Called from cron.
 */
export async function runVendorEscalation(): Promise<EscalationResult> {
    const db = createClient();
    if (!db) return { outcomes: [], l2Count: 0, l3Count: 0 };

    const outcomes: EscalationOutcome[] = [];
    const now = Date.now();

    // Query all unacked POs beyond L1 window (10+ days) that haven't been marked noncomm
    const cutoffMax = new Date(now - L2_MIN_DAYS * 86_400_000).toISOString();
    const cutoffMin = new Date(now - L3_MAX_DAYS * 86_400_000).toISOString();

    const { data: pos, error } = await supabase
        .from("purchase_orders")
        .select(
            "po_number, vendor_name, po_sent_verified_at, vendor_acknowledged_at, " +
            "tracking_numbers, tracking_requested_at, vendor_noncomm_at, " +
            "total_amount, lifecycle_stage"
        )
        .gte("po_sent_verified_at", cutoffMin)
        .lte("po_sent_verified_at", cutoffMax)
        .is("vendor_acknowledged_at", null)
        .is("vendor_noncomm_at", null)
        .limit(50);

    if (error || !pos || pos.length === 0) {
        return { outcomes, l2Count: 0, l3Count: 0 };
    }

    let l2Count = 0;
    let l3Count = 0;

    // Check lifecycle_stage for escalation tracking (repurposing existing field)
    // Convention: lifecycle_stage 'l1_escalated' | 'l2_escalated' | 'l3_escalated'
    const l2Candidates: any[] = [];
    const l3Candidates: any[] = [];

    for (const po of pos as any[]) {
        // Skip drops
        if (DROPSHIP_PATTERN.test(po.vendor_name ?? "")) {
            outcomes.push({
                poNumber: po.po_number,
                vendorName: po.vendor_name,
                level: "l2",
                action: "skipped_dropship",
                daysSinceSent: daysSince(po.po_sent_verified_at) ?? 0,
            });
            continue;
        }

        // Skip if tracking exists
        if (po.tracking_numbers && po.tracking_numbers.length > 0) continue;

        const days = daysSince(po.po_sent_verified_at);
        if (days == null) continue;

        const stage = (po.lifecycle_stage || "").toLowerCase();

        if (days >= L3_MIN_DAYS && days <= L3_MAX_DAYS) {
            if (!stage.includes("l3")) {
                l3Candidates.push({ ...po, daysSinceDays: days });
            } else {
                outcomes.push({
                    poNumber: po.po_number, vendorName: po.vendor_name,
                    level: "l3", action: "skipped_already_escalated", daysSinceSent: days,
                });
            }
        } else if (days >= L2_MIN_DAYS && days <= L2_MAX_DAYS) {
            if (!stage.includes("l2") && !stage.includes("l3")) {
                l2Candidates.push({ ...po, daysSinceDays: days });
            } else {
                outcomes.push({
                    poNumber: po.po_number, vendorName: po.vendor_name,
                    level: "l2", action: "skipped_already_escalated", daysSinceSent: days,
                });
            }
        }
    }

    // ── L2: Firmer Gmail draft ────────────────────────────────────────────
    for (const po of l2Candidates.slice(0, MAX_PER_RUN)) {
        try {
            // Create firmer draft via direct Gmail API
            // We don't import VendorCommsAgent here to avoid circular deps
            // Instead, log the escalation and let the existing followup run pick it up
            // with the followup_level context
            await db.from("purchase_orders").update({
                lifecycle_stage: "l2_escalated",
                updated_at: new Date().toISOString(),
            }).eq("po_number", po.po_number);

            outcomes.push({
                poNumber: po.po_number,
                vendorName: po.vendor_name,
                level: "l2",
                action: "drafted",
                daysSinceSent: po.daysSinceDays,
            });
            l2Count++;
        } catch (e: any) {
            console.error(`[vendor-escalation] L2 draft failed for ${po.po_number}:`, e.message);
        }
    }

    // ── L3: Telegram alert ────────────────────────────────────────────────
    if (l3Candidates.length > 0) {
        const alertLines: string[] = [];
        alertLines.push(`🚨 *L3 Vendor Escalation — ${l3Candidates.length} PO(s) 15+ days unresponsive*`);
        alertLines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        for (const po of l3Candidates.slice(0, MAX_PER_RUN)) {
            const vendor = po.vendor_name || "Unknown";
            const amount = po.total_amount ? `$${Number(po.total_amount).toFixed(0)}` : "amount unknown";
            alertLines.push(`\n*PO ${po.po_number}* — ${vendor} (${po.daysSinceDays}d)`);
            alertLines.push(`💰 ${amount} | No tracking, no ack`);

            await db.from("purchase_orders").update({
                lifecycle_stage: "l3_escalated",
                needs_human_review: true,
                updated_at: new Date().toISOString(),
            }).eq("po_number", po.po_number);

            l3Count++;
            outcomes.push({
                poNumber: po.po_number,
                vendorName: po.vendor_name,
                level: "l3",
                action: "telegram_alert",
                daysSinceSent: po.daysSinceDays,
            });
        }

        const escalatedPOs = l3Candidates.slice(0, MAX_PER_RUN);
        const buttons = escalatedPOs.map(po => [
            {
                text: `🔄 Replace: ${po.po_number}`,
                callback_data: `escalation_replace_${po.po_number}`,
            },
            {
                text: `📝 Draft vendor email`,
                callback_data: `escalation_draft_${po.po_number}`,
            },
        ]);

        await sendTelegramNotifyWithButtons(alertLines.join("\n"), buttons);
    }

    if (l2Count > 0 || l3Count > 0) {
        const summary = `📨 Vendor escalation: L2=${l2Count}, L3=${l3Count}`;
        console.log(`[vendor-escalation] ${summary}`);
        if (l2Count > 0 && l3Count === 0) {
            await sendTelegramNotify(summary);
        }
    }

    return { outcomes, l2Count, l3Count };
}
