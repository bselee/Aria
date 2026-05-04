/**
 * @file    recon-status.ts
 * @purpose Read-side companion to reconciliation-outcomes.ts.
 *          Queries reconciliation_outcomes rows and formats the /recon-status
 *          Telegram message. No writes — pure read + format.
 *
 * Phase 1a Task 4 — /recon-status Telegram command.
 */

import { createClient } from "@/lib/supabase";
import type { ReconciliationOutcome } from "./reconciliation-outcomes";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OutcomeRow {
    outcome: ReconciliationOutcome;
    vendor_name: string | null;
    po_id: string | null;
    created_at: string;
    resolved_at: string | null;
}

/** Outcome counts for a single time window, keyed by outcome string. */
export type OutcomeCounts = Partial<Record<ReconciliationOutcome, number>>;

export interface WindowStats {
    /** Total row count in this window. */
    total: number;
    /** Per-outcome counts (only non-zero outcomes are present). */
    counts: OutcomeCounts;
    /** How many pending_approval rows are unresolved AND older than 24h. */
    stalePendingCount: number;
}

export interface MatchFailedVendor {
    vendorName: string;  // "Unknown vendor" if null
    count: number;
}

export interface PendingApprovalRow {
    poId: string | null;
    vendorName: string | null;
    createdAt: string;
}

export interface ReconStatus {
    h24: WindowStats;
    d7: WindowStats;
    d30: WindowStats;
    /** Top 5 vendors with match_failed in last 30d (empty if none). */
    topMatchFailedVendors: MatchFailedVendor[];
    /** Open pending_approval rows (resolved_at IS NULL), oldest first, max 10. */
    openPendingApprovals: PendingApprovalRow[];
    /** ISO timestamp when this snapshot was taken. */
    asOf: string;
}

// ── Emoji map ────────────────────────────────────────────────────────────────

const OUTCOME_EMOJI: Record<ReconciliationOutcome, string> = {
    auto_applied:       "✅",
    approved_by_user:   "✅",
    pending_approval:   "⏸",
    match_failed:       "❌",
    rejected_by_user:   "❌",
    rejected_10x:       "🛑",
    rejected_invariant: "🛑",
    expired:            "⏰",
};

// ── Query ─────────────────────────────────────────────────────────────────────

/**
 * Fetch rows from reconciliation_outcomes for the last `daysBack` days.
 * Returns an empty array if Supabase is unavailable — never throws.
 */
async function fetchRows(cutoff: Date): Promise<OutcomeRow[]> {
    try {
        const supabase = createClient();
        if (!supabase) return [];

        const { data, error } = await supabase
            .from("reconciliation_outcomes")
            .select("outcome, vendor_name, po_id, created_at, resolved_at")
            .gte("created_at", cutoff.toISOString())
            .order("created_at", { ascending: false });

        if (error) {
            console.warn(`[recon-status] fetch failed: ${error.message}`);
            return [];
        }
        return (data as OutcomeRow[]) ?? [];
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[recon-status] unexpected error: ${msg}`);
        return [];
    }
}

/** Fetch open pending_approval rows (resolved_at IS NULL), oldest first. */
async function fetchOpenPending(): Promise<PendingApprovalRow[]> {
    try {
        const supabase = createClient();
        if (!supabase) return [];

        const { data, error } = await supabase
            .from("reconciliation_outcomes")
            .select("po_id, vendor_name, created_at")
            .eq("outcome", "pending_approval")
            .is("resolved_at", null)
            .order("created_at", { ascending: true })
            .limit(10);

        if (error) {
            console.warn(`[recon-status] open pending fetch failed: ${error.message}`);
            return [];
        }
        return (data ?? []).map((r: { po_id: string | null; vendor_name: string | null; created_at: string }) => ({
            poId: r.po_id,
            vendorName: r.vendor_name,
            createdAt: r.created_at,
        }));
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[recon-status] unexpected error (pending): ${msg}`);
        return [];
    }
}

// ── Aggregation helpers ───────────────────────────────────────────────────────

function buildWindowStats(rows: OutcomeRow[], now: Date): WindowStats {
    const counts: OutcomeCounts = {};
    let stalePendingCount = 0;
    const staleThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    for (const row of rows) {
        const outcome = row.outcome as ReconciliationOutcome;
        counts[outcome] = (counts[outcome] ?? 0) + 1;

        if (
            outcome === "pending_approval" &&
            row.resolved_at === null &&
            new Date(row.created_at) < staleThreshold
        ) {
            stalePendingCount++;
        }
    }

    return { total: rows.length, counts, stalePendingCount };
}

function topMatchFailedVendors(rows: OutcomeRow[], limit = 5): MatchFailedVendor[] {
    const vendorCounts = new Map<string, number>();
    for (const row of rows) {
        if (row.outcome !== "match_failed") continue;
        const name = row.vendor_name ?? "Unknown vendor";
        vendorCounts.set(name, (vendorCounts.get(name) ?? 0) + 1);
    }
    return [...vendorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([vendorName, count]) => ({ vendorName, count }));
}

// ── Main query ────────────────────────────────────────────────────────────────

/**
 * Pull all data needed to render the /recon-status message.
 * NEVER throws — returns zeroed stats if Supabase is unavailable.
 */
export async function getReconStatus(): Promise<ReconStatus> {
    const now = new Date();
    const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const cutoff7d  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000);
    const cutoff24h = new Date(now.getTime() -      24 * 60 * 60 * 1000);

    // Single fetch for 30d — slice for 7d and 24h windows in JS
    const [rows30d, openPending] = await Promise.all([
        fetchRows(cutoff30d),
        fetchOpenPending(),
    ]);

    const rows7d  = rows30d.filter(r => new Date(r.created_at) >= cutoff7d);
    const rows24h = rows30d.filter(r => new Date(r.created_at) >= cutoff24h);

    return {
        h24:  buildWindowStats(rows24h, now),
        d7:   buildWindowStats(rows7d,  now),
        d30:  buildWindowStats(rows30d, now),
        topMatchFailedVendors: topMatchFailedVendors(rows30d),
        openPendingApprovals: openPending,
        asOf: now.toISOString(),
    };
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/** Format a duration (ms) as e.g. "3d 4h" or "2h 15m". */
function formatAge(createdAtIso: string, now: Date): string {
    const ms = now.getTime() - new Date(createdAtIso).getTime();
    const totalMins = Math.floor(ms / 60_000);
    const days  = Math.floor(totalMins / 1440);
    const hours = Math.floor((totalMins % 1440) / 60);
    const mins  = totalMins % 60;

    if (days > 0)   return `${days}d ${hours}h`;
    if (hours > 0)  return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function renderWindow(label: string, stats: WindowStats): string {
    const header = `*${label}:* ${stats.total} outcome${stats.total !== 1 ? "s" : ""}`;

    // Sort non-zero outcomes by count desc
    const sorted = (Object.entries(stats.counts) as [ReconciliationOutcome, number][])
        .filter(([, cnt]) => cnt > 0)
        .sort(([, a], [, b]) => b - a);

    if (sorted.length === 0) {
        return `${header}\n  (none)`;
    }

    const lines = sorted.map(([outcome, cnt]) => {
        const emoji = OUTCOME_EMOJI[outcome] ?? "•";
        let line = `  ${emoji} ${outcome}: ${cnt}`;
        if (outcome === "pending_approval" && stats.stalePendingCount > 0) {
            line += ` (${stats.stalePendingCount} stale >24h)`;
        }
        return line;
    });

    return `${header}\n${lines.join("\n")}`;
}

/**
 * Render the full /recon-status Markdown message from a ReconStatus snapshot.
 * Pure function — no I/O. Testable without a DB.
 */
export function formatReconStatus(status: ReconStatus): string {
    const now = new Date(status.asOf);
    const parts: string[] = [];

    parts.push("*📊 AP Reconciliation Status*\n");

    parts.push(renderWindow("Last 24h", status.h24));
    parts.push("");
    parts.push(renderWindow("Last 7d",  status.d7));
    parts.push("");
    parts.push(renderWindow("Last 30d", status.d30));

    // Top match-failed vendors (30d)
    if (status.topMatchFailedVendors.length > 0) {
        parts.push("");
        parts.push("*Top match\\-failed vendors (30d):*");
        for (const { vendorName, count } of status.topMatchFailedVendors) {
            parts.push(`  • ${vendorName} — ${count}`);
        }
    }

    // Open pending approvals
    if (status.openPendingApprovals.length > 0) {
        parts.push("");
        parts.push("*Pending approvals (open now):*");
        for (const row of status.openPendingApprovals) {
            const po     = row.poId ?? "unknown PO";
            const vendor = row.vendorName ?? "unknown vendor";
            const age    = formatAge(row.createdAt, now);
            parts.push(`  • PO ${po} — ${vendor} — ${age} old`);
        }
    }

    return parts.join("\n");
}
