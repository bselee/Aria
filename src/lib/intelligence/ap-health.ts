/**
 * @file    src/lib/intelligence/ap-health.ts
 * @purpose AP pipeline health monitoring — stuck email detection, daily
 *          stats, and Telegram-ready summary. Catches emails that have
 *          been retried beyond a sane threshold and flags them for review.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/db
 *
 * QUERIES (Supabase):
 *   email_inbox_queue — emails awaiting processing
 *   ap_activity_log   — processed email audit trail
 *   documents          — gmail_message_id dedup registry
 *   agent_task         — control-plane tasks (dropship, exceptions)
 */

import { createClient } from "@/lib/db";

// ── Stuck Email Detection ───────────────────────────────────────────────────

const STUCK_THRESHOLD_HOURS = 6;
const STUCK_RETRY_COUNT = 5;

export interface StuckEmail {
    gmailMessageId: string;
    subject: string;
    fromEmail: string;
    queuedAt: string;
    retryCount: number;
    lastError: string;
}

/**
 * Find emails stuck in the inbox queue that have been retried too many times
 * or have been sitting unprocessed for too long. These need human review.
 */
export async function detectStuckEmails(): Promise<StuckEmail[]> {
    const db = createClient();
    if (!db) return [];

    const stuck: StuckEmail[] = [];
    const cutoffTime = new Date(Date.now() - STUCK_THRESHOLD_HOURS * 3600000).toISOString();

    try {
        // Emails queued > 6 hours ago that are still pending
        const { data: staleEmails } = await supabase
            .from("email_inbox_queue")
            .select("gmail_message_id, subject, from_email, queued_at, retry_count, last_error")
            .eq("status", "pending")
            .lt("queued_at", cutoffTime)
            .order("queued_at", { ascending: true })
            .limit(50);

        if (staleEmails) {
            for (const e of staleEmails as any[]) {
                const retryCount = Number(e.retry_count) || 0;
                if (retryCount >= STUCK_RETRY_COUNT || !e.last_error) {
                    stuck.push({
                        gmailMessageId: e.gmail_message_id,
                        subject: e.subject || "No Subject",
                        fromEmail: e.from_email || "Unknown",
                        queuedAt: e.queued_at,
                        retryCount,
                        lastError: e.last_error || "Unknown (stale — no error recorded)",
                    });
                }
            }
        }

        // Also check ap_activity_log for emails that have been retried >5 times
        // regardless of queue status — these may have been "processed" but keep failing
        const { data: retriedLogs } = await supabase
            .from("ap_activity_log")
            .select("gmail_message_id, subject, from_email, action, error, created_at")
            .eq("action", "retry")
            .gte("created_at", cutoffTime)
            .order("created_at", { ascending: false })
            .limit(100);

        if (retriedLogs) {
            const retryCountByEmail = new Map<string, { count: number; lastError: string }>();
            for (const r of retriedLogs as any[]) {
                const mid = r.gmail_message_id;
                if (!mid) continue;
                const existing = retryCountByEmail.get(mid) || { count: 0, lastError: "" };
                existing.count++;
                if (r.error) existing.lastError = r.error;
                retryCountByEmail.set(mid, existing);
            }

            for (const [mid, info] of retryCountByEmail) {
                if (info.count >= STUCK_RETRY_COUNT && !stuck.some(s => s.gmailMessageId === mid)) {
                    // Find subject/from in the logs
                    const detail = retriedLogs.find((r: any) => r.gmail_message_id === mid);
                    stuck.push({
                        gmailMessageId: mid,
                        subject: detail?.subject || "Unknown",
                        fromEmail: detail?.from_email || "Unknown",
                        queuedAt: detail?.created_at || "",
                        retryCount: info.count,
                        lastError: info.lastError,
                    });
                }
            }
        }
    } catch (err: any) {
        console.warn(`[APHealth] Stuck email detection failed: ${err.message}`);
    }

    return stuck;
}

// ── Daily Stats ─────────────────────────────────────────────────────────────

export interface APDailyStats {
    date: string;
    totalProcessed: number;
    invoicesFound: number;
    statementsFound: number;
    advertisementsFiltered: number;
    autopaySkipped: number;
    dropshipForwarded: number;
    reconciled: number;
    needsApproval: number;
    stuckEmails: number;
    errors: number;
}

/**
 * Get today's AP pipeline statistics.
 */
export async function getAPDailyStats(): Promise<APDailyStats> {
    const db = createClient();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const stats: APDailyStats = {
        date: today,
        totalProcessed: 0,
        invoicesFound: 0,
        statementsFound: 0,
        advertisementsFiltered: 0,
        autopaySkipped: 0,
        dropshipForwarded: 0,
        reconciled: 0,
        needsApproval: 0,
        stuckEmails: 0,
        errors: 0,
    };

    if (!db) return stats;

    try {
        const { data } = await supabase
            .from("ap_activity_log")
            .select("action, created_at")
            .gte("created_at", `${today}T00:00:00Z`);

        if (data) {
            for (const row of data as any[]) {
                stats.totalProcessed++;
                switch (row.action) {
                    case "invoice_found": stats.invoicesFound++; break;
                    case "statement_found": stats.statementsFound++; break;
                    case "ad_filtered": stats.advertisementsFiltered++; break;
                    case "autopay_skip": stats.autopaySkipped++; break;
                    case "dropship_forwarded": stats.dropshipForwarded++; break;
                    case "reconciled": stats.reconciled++; break;
                    case "needs_approval": stats.needsApproval++; break;
                    case "error": case "retry": stats.errors++; break;
                }
            }
        }

        // Stuck email count
        const stuck = await detectStuckEmails();
        stats.stuckEmails = stuck.length;
    } catch (err: any) {
        console.warn(`[APHealth] Daily stats failed: ${err.message}`);
    }

    return stats;
}

/**
 * Format AP health for Telegram display.
 */
export function formatAPHealth(stats: APDailyStats, stuck: StuckEmail[]): string {
    const lines = [
        `📊 *AP Pipeline Health — ${stats.date}*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `📨 Processed: ${stats.totalProcessed}`,
        `   🧾 Invoices: ${stats.invoicesFound}`,
        `   📋 Statements: ${stats.statementsFound}`,
        `   📢 Ads filtered: ${stats.advertisementsFiltered}`,
        `   💳 Autopay skipped: ${stats.autopaySkipped}`,
        `   📦 Dropship: ${stats.dropshipForwarded}`,
        ``,
        `🔧 Reconciliation:`,
        `   ✅ Auto-applied: ${stats.reconciled}`,
        `   ⚠️ Needs approval: ${stats.needsApproval}`,
        `   ❌ Errors: ${stats.errors}`,
    ];

    if (stuck.length > 0) {
        lines.push("");
        lines.push(`🚨 *${stuck.length} STUCK EMAIL(S)*`);
        for (const s of stuck.slice(0, 3)) {
            lines.push(`   • ${s.subject.slice(0, 40)}`);
            lines.push(`     From: ${s.fromEmail} | ${s.retryCount} retries`);
            lines.push(`     Last error: ${s.lastError.slice(0, 60)}`);
        }
        if (stuck.length > 3) {
            lines.push(`   …and ${stuck.length - 3} more. Use /apstuck to see all.`);
        }
    }

    return lines.join("\n");
}
