/**
 * @file    src/lib/slack/stale-request-watcher.ts
 * @purpose Detects pending slack_requests that have gone unanswered for >24h
 *          and nudges Bill via Telegram. Marks nudged to avoid re-notify spam.
 *
 *          Restored from the deleted followup-sop.ts (2026-05-28 → 2026-06-03
 *          refactor). Lives standalone now so the followup-sop cron handler can
 *          compose it with the AP forwarding alert (email-forwarding-alert.ts)
 *          without resurrecting the full 264-line SOP module.
 *
 * @author  Hermia
 * @created 2026-06-04
 * @deps    @/lib/supabase, @/lib/intelligence/telegram-notify
 */

import { createClient } from "../supabase";
import { sendTelegramNotify } from "../intelligence/telegram-notify";
import { isBusinessHours } from "../intelligence/alert-gate";

// ── Constants ───────────────────────────────────────────────────────────────

/** Slack requests pending for more than this many hours are "stale" */
const SLACK_STALE_HOURS = 24;

/** Only nudge once per request per day to avoid spam */
const NUDGE_COOLDOWN_HOURS = 24;

// ── Types ──────────────────────────────────────────────────────────────────

export interface StaleSlackRequest {
    id: number;
    channel_name: string;
    requester_name: string;
    original_text: string;
    items_requested: string[] | null;
    created_at: string;
    status: string;
    age_hours: number;
}

export interface StaleRequestReport {
    stale: StaleSlackRequest[];
    totalPending: number;
    generatedAt: string;
}

// ── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Fetch pending Slack requests that have gone unanswered.
 */
export async function getStaleSlackRequests(): Promise<StaleSlackRequest[]> {
    const db = createClient();
    if (!db) return [];

    const { data, error } = await db
        .from("slack_requests")
        .select("id, channel_name, requester_name, original_text, items_requested, created_at, status, last_nudge_at")
        .eq("status", "pending")
        .lt("created_at", new Date(Date.now() - SLACK_STALE_HOURS * 3600000).toISOString())
        .or(`last_nudge_at.is.null,last_nudge_at.lt.${new Date(Date.now() - NUDGE_COOLDOWN_HOURS * 3600000).toISOString()}`)
        .order("created_at", { ascending: true })
        .limit(10);

    if (error || !data) return [];

    return (data as any[]).map((row) => ({
        id: row.id,
        channel_name: row.channel_name || "unknown",
        requester_name: row.requester_name || "someone",
        original_text: row.original_text || "",
        items_requested: row.items_requested,
        created_at: row.created_at,
        status: row.status,
        age_hours: Math.round((Date.now() - new Date(row.created_at).getTime()) / 3600000),
    }));
}

/**
 * Mark a Slack request as nudged (update last_nudge_at).
 */
export async function markRequestNudged(requestIds: number[]): Promise<void> {
    if (requestIds.length === 0) return;
    const db = createClient();
    if (!db) return;

    await db
        .from("slack_requests")
        .update({ last_nudge_at: new Date().toISOString() })
        .in("id", requestIds);
}

/**
 * Format the stale request report for Telegram.
 * Ninja-grade — terse and actionable. Returns "" when there's nothing to report.
 */
export function formatStaleRequests(report: StaleRequestReport): string {
    if (report.stale.length === 0) return "";

    const lines: string[] = [];

    if (report.stale.length === 1) {
        const r = report.stale[0];
        const item = r.items_requested?.slice(0, 3).join(", ") || r.original_text.slice(0, 60);
        lines.push(`💬 *Slack request unanswered for ${r.age_hours}h*`);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`*${r.requester_name}* in #${r.channel_name}`);
        lines.push(`_"${item}"_`);
    } else {
        lines.push(`💬 *${report.stale.length} Slack requests unanswered (>${SLACK_STALE_HOURS}h)*`);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        for (const r of report.stale.slice(0, 5)) {
            const item = r.items_requested?.slice(0, 3).join(", ") || r.original_text.slice(0, 60);
            lines.push(`• *${r.requester_name}* in #${r.channel_name} — ${r.age_hours}h`);
            lines.push(`  _"${item}"_`);
        }
        if (report.stale.length > 5) {
            lines.push(`  _...and ${report.stale.length - 5} more_`);
        }
    }

    return lines.join("\n");
}

/**
 * Run the stale request watcher: check for unanswered requests and nudge Bill
 * if any are over SLA. Called from the followup-sop cron.
 */
export async function runStaleRequestWatcher(): Promise<void> {
    // Only check during business hours — stale Slack requests can wait until Monday
    if (!isBusinessHours()) {
        console.log("[stale-request-watcher] Outside business hours — skipping stale request check.");
        return;
    }

    const stale = await getStaleSlackRequests();
    if (stale.length === 0) {
        console.log("[stale-request-watcher] No pending Slack requests over SLA.");
        return;
    }

    const report: StaleRequestReport = {
        stale,
        totalPending: stale.length,
        generatedAt: new Date().toISOString(),
    };

    const formatted = formatStaleRequests(report);
    console.log(formatted);
    await markRequestNudged(stale.map((r) => r.id));

    // Actually notify Bill — not just log to console
    if (formatted) {
        await sendTelegramNotify(formatted).catch(() => {});
    }

    console.log(`[stale-request-watcher] Nudged Bill about ${stale.length} stale Slack request(s).`);
}
