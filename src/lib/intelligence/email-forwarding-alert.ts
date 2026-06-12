/**
 * @file    email-forwarding-alert.ts
 * @purpose Escalates AP invoices stuck in ERROR_FORWARDING or ERROR_PROCESSING
 *          so Bill isn't blind to a bill that never made it to Bill.com.
 *
 *          Part of the email handling audit (radar items). The AP pipeline
 *          already retries ERROR_PROCESSING via AP-Identifier's self-heal,
 *          but ERROR_FORWARDING (Bill.com send failed) is only logged — never
 *          surfaced to Bill until now.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/supabase, @/lib/intelligence/telegram-notify
 *
 * INBOX CONTEXT:
 *   ap@buildasoil.com → AP pipeline (classify → forward → Bill.com → reconcile)
 *   bill.selee@buildasoil.com → Ack agent (classify → auto-reply or human review)
 *
 *   This module only monitors the AP inbox pipeline. The default inbox
 *   has different failure modes (REQUIRES_HUMAN surfacing, handled separately
 *   in acknowledgement-agent.ts).
 *
 *   ERROR_FORWARDING = invoice was classified and queued, but the actual
 *     MIME send to buildasoilap@bill.com failed. This invoice is now invisible
 *     to Bill.com and will not be processed. Escalate immediately.
 *
 *   ERROR_PROCESSING = AP-Agent processing failed after forward (e.g. PO match
 *     failed, OCR failed). Already retried by AP-Identifier self-heal.
 *     Alert if stuck >24h with no retry success.
 */

import { createClient } from "../supabase";
import { sendTelegramNotify } from "./telegram-notify";

export interface StuckForwardAlert {
    messageId: string;
    from: string;
    subject: string;
    status: string;
    ageHours: number;
    lastError: string;
}

/**
 * Check for AP invoices stuck in ERROR_FORWARDING (never reached Bill.com).
 * Returns alerts — caller decides whether to send Telegram.
 */
export async function getStuckForwardingAlerts(): Promise<StuckForwardAlert[]> {
    const db = createClient();
    if (!db) return [];

    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
    const { data, error } = await db
        .from("ap_inbox_queue")
        .select("message_id, extracted_json, status, created_at, updated_at")
        .in("status", ["ERROR_FORWARDING", "ERROR_PROCESSING"])
        .lt("updated_at", twoHoursAgo)
        .order("created_at", { ascending: false })
        .limit(10);

    if (error || !data) return [];

    // Filter out zombie records — old pipeline debris with empty extracted_json
    // that has no from/vendor_name/subject. These are months-old ERROR_PROCESSING
    // records that should not be reported as "stuck".
    const meaningful = (data as any[]).filter(row => {
        const ej = row.extracted_json;
        if (!ej || typeof ej !== 'object') return false;
        return ej.from || ej.vendor_name || ej.subject;
    });

    return meaningful.map(row => {
        const ej = row.extracted_json || {};
        return {
            messageId: row.message_id || "unknown",
            from: ej.from || ej.vendor_name || "unknown sender",
            subject: ej.subject || "no subject",
            status: row.status,
            ageHours: Math.round((Date.now() - new Date(row.created_at).getTime()) / 3600000),
            lastError: ej.last_error || ej.error_message || row.status,
        };
    });
}

/**
 * Format stuck forwarding alerts for Telegram. Ninja-grade — terse and actionable.
 */
export function formatForwardingAlerts(alerts: StuckForwardAlert[]): string {
    if (alerts.length === 0) return "";

    const lines: string[] = [];
    if (alerts.length === 1) {
        const a = alerts[0];
        lines.push(`🚨 *AP invoice stuck — never reached Bill.com*`);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`📩 *${a.from}*`);
        lines.push(`   ${a.subject}`);
        lines.push(`   ⏰ ${a.ageHours}h ago | ${a.status}`);
    } else {
        lines.push(`🚨 *${alerts.length} AP invoices stuck — never reached Bill.com*`);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        for (const a of alerts.slice(0, 5)) {
            lines.push(`📩 *${a.from}* (${a.ageHours}h)`);
            lines.push(`   ${a.subject.slice(0, 60)}`);
        }
        if (alerts.length > 5) {
            lines.push(`   _...and ${alerts.length - 5} more — check /aphealth_`);
        }
    }

    lines.push(`\n💡 These will NOT appear in Bill.com. Forward manually or fix the pipeline.`);
    return lines.join("\n");
}

/**
 * Run the forwarding escalation check. Called by followup-sop cron.
 * Dedup: only alerts once per 24h per message_id — checks ap_activity_log
 * for recent FORWARDING_ESCALATED entries before sending.
 * Only sends when there are actual stuck items.
 *
 * Uses sendTelegramNotify (gated by business hours) — NOT critical.
 * Stuck invoices are not a crash-loops emergency; they wait for business hours.
 */
export async function runForwardingEscalation(): Promise<void> {
    const alerts = await getStuckForwardingAlerts();
    if (alerts.length === 0) {
        console.log("[forwarding-alert] No stuck AP forwards.");
        return;
    }

    // ── Dedup: Check if we already alerted for these message_ids in the last 24h ──
    const db = createClient();
    if (db) {
        const msgIds = alerts.map(a => a.messageId);
        const yesterday = new Date(Date.now() - 24 * 3600000).toISOString();
        const { data: recentEscalations } = await db
            .from("ap_activity_log")
            .select("email_subject")
            .gte("created_at", yesterday)
            .eq("intent", "FORWARDING_ESCALATED")
            .in("email_subject", msgIds);

        if (recentEscalations && recentEscalations.length > 0) {
            const alreadyAlerted = new Set(recentEscalations.map((r: any) => r.email_subject));
            const newAlerts = alerts.filter(a => !alreadyAlerted.has(a.messageId));
            if (newAlerts.length === 0) {
                console.log(`[forwarding-alert] All ${alerts.length} stuck invoice(s) already alerted in last 24h — skipping.`);
                return;
            }
            if (newAlerts.length < alerts.length) {
                console.log(`[forwarding-alert] ${newAlerts.length} new stuck invoice(s), ${alerts.length - newAlerts.length} already alerted — sending for new only.`);
                // Send only for the new ones
                const formatted = formatForwardingAlerts(newAlerts);
                await sendTelegramNotify(formatted);
                // Log each new alert for future dedup
                for (const a of newAlerts) {
                    await db.from("ap_activity_log").insert({
                        email_from: a.from,
                        email_subject: a.messageId,
                        intent: "FORWARDING_ESCALATED",
                        action_taken: `Escalated: invoice stuck in ${a.status} for ${a.ageHours}h — ${a.from}`,
                        metadata: { message_id: a.messageId, status: a.status, age_hours: a.ageHours },
                    }).catch(() => {});
                }
                console.log(`[forwarding-alert] Alerted Bill: ${newAlerts.length} AP invoice(s) stuck in ERROR_FORWARDING/ERROR_PROCESSING.`);
                return;
            }
        }
    }

    const formatted = formatForwardingAlerts(alerts);
    await sendTelegramNotify(formatted);

    // Log each alert for future dedup
    if (db) {
        for (const a of alerts) {
            await db.from("ap_activity_log").insert({
                email_from: a.from,
                email_subject: a.messageId,
                intent: "FORWARDING_ESCALATED",
                action_taken: `Escalated: invoice stuck in ${a.status} for ${a.ageHours}h — ${a.from}`,
                metadata: { message_id: a.messageId, status: a.status, age_hours: a.ageHours },
            }).catch(() => {});
        }
    }

    console.log(`[forwarding-alert] Alerted Bill: ${alerts.length} AP invoice(s) stuck in ERROR_FORWARDING/ERROR_PROCESSING.`);
}
