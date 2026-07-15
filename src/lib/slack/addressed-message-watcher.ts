/**
 * @file    src/lib/slack/addressed-message-watcher.ts
 * @purpose Daily review of Slack messages directly addressed to Bill
 *          (DMs + @Bill mentions) recorded in slack_requests with
 *          addressed_to_bill = true. Generates a short Bill-voice
 *          summary for the daily-slack-review cron.
 *
 *          Part of 2026-06-15 daily Slack review feature.
 *
 * @author  Hermia
 * @created 2026-06-15
 * @deps    @/lib/db
 */

import { createClient } from "../db";

// ── Types ──────────────────────────────────────────────────────────────

export interface AddressedRequest {
    id: number;
    channel_name: string;
    requester_name: string;
    original_text: string;
    items_requested: string[] | null;
    created_at: string;
    status: string;
    is_dm: boolean;
    channel_id: string;
    message_ts: string;
}

export interface AddressedReviewReport {
    /** Requests still pending (no response / not yet handled). */
    unresponded: AddressedRequest[];
    /** Requests that have been responded to (status != 'pending'). */
    responded: AddressedRequest[];
    /** How many hours back the query looked. */
    lookbackHours: number;
    generatedAt: string;
}

// ── Query ──────────────────────────────────────────────────────────────

/**
 * Fetch addressed-to-Bill Slack requests from the last N hours.
 * Groups into unresponded (pending) and responded (anything else).
 */
export async function getAddressedRequests(
    lookbackHours: number = 24,
): Promise<AddressedReviewReport> {
    const db = createClient();
    if (!db) {
        return { unresponded: [], responded: [], lookbackHours, generatedAt: new Date().toISOString() };
    }

    const cutoff = new Date(Date.now() - lookbackHours * 3600000).toISOString();

    const { data, error } = await db
        .from("slack_requests")
        .select(
            "id, channel_name, requester_name, original_text, items_requested, created_at, status, is_dm, channel_id, message_ts",
        )
        .eq("addressed_to_bill", true)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(30);

    if (error || !data) {
        return { unresponded: [], responded: [], lookbackHours, generatedAt: new Date().toISOString() };
    }

    const requests: AddressedRequest[] = (data as any[]).map((row) => ({
        id: row.id,
        channel_name: row.channel_name || "unknown",
        requester_name: row.requester_name || "someone",
        original_text: row.original_text || "",
        items_requested: row.items_requested,
        created_at: row.created_at,
        status: row.status || "pending",
        is_dm: row.is_dm || false,
        channel_id: row.channel_id || "",
        message_ts: row.message_ts || "",
    }));

    return {
        unresponded: requests.filter((r) => r.status === "pending"),
        responded: requests.filter((r) => r.status !== "pending"),
        lookbackHours,
        generatedAt: new Date().toISOString(),
    };
}

// ── Formatting ─────────────────────────────────────────────────────────

/**
 * Format the daily review as a short Bill-voice Telegram message.
 * Returns empty string when there's nothing to report (no news = silence).
 */
export function formatAddressedReview(report: AddressedReviewReport): string {
    const total = report.unresponded.length + report.responded.length;
    if (total === 0) return "";

    const lines: string[] = [];
    lines.push(`Slack addressed (${report.lookbackHours}h):`);

    if (report.unresponded.length > 0) {
        lines.push(`  ${report.unresponded.length} unanswered`);
        for (const r of report.unresponded) {
            const chan = r.is_dm ? "DM" : `#${r.channel_name}`;
            const skus = r.items_requested?.length
                ? ` [${r.items_requested.join(", ")}]`
                : "";
            const link = r.is_dm
                ? ""
                : ` https://buildasoil.slack.com/archives/${r.channel_id}/p${r.message_ts.replace(".", "")}`;
            lines.push(`    ${r.requester_name} in ${chan}${skus}${link}`);
        }
    }

    if (report.responded.length > 0) {
        lines.push(`  ${report.responded.length} handled`);
        for (const r of report.responded) {
            const chan = r.is_dm ? "DM" : `#${r.channel_name}`;
            lines.push(`    ${r.requester_name} in ${chan} (${r.status})`);
        }
    }

    return lines.join("\n");
}
