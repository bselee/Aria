/**
 * @file    src/lib/slack/followup-sop.ts
 * @purpose Follow-up SOP for Slack requests. Detects pending slack_requests
 *          that have gone unanswered for >24 hours and nudges Bill via Telegram.
 *
 *          Also surfaces vendor email follow-ups: PO confirmation emails
 *          that need a reply but haven't received one within the SLA window.
 *
 *          Part of core-04: Slack/Email responder — auto-ack + follow-up SOP.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    supabase, intelligence/telegram-helper
 */

import { createClient } from "../supabase";
import { sendTelegramNotify } from "../intelligence/telegram-notify";

// ── Types ───────────────────────────────────────────────────────────────────

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

export interface VendorFollowUp {
    po_number: string;
    vendor_name: string;
    vendor_email: string;
    last_contact_at: string | null;
    age_hours: number;
    reason: string;  // 'no_confirmation' | 'no_ack_received'
}

export interface FollowUpReport {
    staleSlackRequests: StaleSlackRequest[];
    vendorFollowUps: VendorFollowUp[];
    summary: {
        totalPending: number;
        totalStale: number;
        totalVendor: number;
    };
    generatedAt: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Slack requests pending for more than this many hours are "stale" */
const SLACK_STALE_HOURS = 24;

/** Vendor POs sent but no confirmation received within this many hours */
const VENDOR_STALE_HOURS = 48;

/** Only nudge once per request per day to avoid spam */
const NUDGE_COOLDOWN_HOURS = 24;

// ── Core Logic ──────────────────────────────────────────────────────────────

/**
 * Fetch pending Slack requests that have gone unanswered.
 */
export async function getStaleSlackRequests(): Promise<StaleSlackRequest[]> {
    const db = createClient();
    if (!db) return [];

    const { data, error } = await db
        .from('slack_requests')
        .select('id, channel_name, requester_name, original_text, items_requested, created_at, status, last_nudge_at')
        .eq('status', 'pending')
        .lt('created_at', new Date(Date.now() - SLACK_STALE_HOURS * 3600000).toISOString())
        .or(`last_nudge_at.is.null,last_nudge_at.lt.${new Date(Date.now() - NUDGE_COOLDOWN_HOURS * 3600000).toISOString()}`)
        .order('created_at', { ascending: true })
        .limit(10);

    if (error || !data) return [];

    return data.map((row: any) => ({
        id: row.id,
        channel_name: row.channel_name || 'unknown',
        requester_name: row.requester_name || 'someone',
        original_text: row.original_text || '',
        items_requested: row.items_requested,
        created_at: row.created_at,
        status: row.status,
        age_hours: Math.round((Date.now() - new Date(row.created_at).getTime()) / 3600000),
    }));
}

/**
 * Fetch vendor POs where we sent an order but haven't received confirmation.
 */
export async function getVendorFollowUps(): Promise<VendorFollowUp[]> {
    const db = createClient();
    if (!db) return [];

    // Look for POs in 'sent' lifecycle stage that are >48h old
    // with no confirmation evidence in purchase_orders table
    const { data: pos, error } = await db
        .from('purchase_orders')
        .select('po_number, vendor_name, po_sent_at, updated_at')
        .eq('lifecycle_stage', 'sent')
        .lt('po_sent_at', new Date(Date.now() - VENDOR_STALE_HOURS * 3600000).toISOString())
        .order('po_sent_at', { ascending: true })
        .limit(10);

    if (error || !pos) return [];

    // Enrich with vendor email
    const enriched: VendorFollowUp[] = [];
    for (const po of pos as any[]) {
        const ageHours = Math.round((Date.now() - new Date(po.po_sent_at).getTime()) / 3600000);

        // Check if we have a vendor email
        let vendorEmail = '';
        try {
            const vp = await db
                .from('vendor_profiles')
                .select('orders_email')
                .ilike('vendor_name', `%${(po.vendor_name || '').split(' ')[0]}%`)
                .maybeSingle();
            vendorEmail = vp?.data?.orders_email || '';
        } catch { /* ignore */ }

        enriched.push({
            po_number: po.po_number,
            vendor_name: po.vendor_name || 'Unknown',
            vendor_email: vendorEmail,
            last_contact_at: po.po_sent_at,
            age_hours: ageHours,
            reason: 'no_confirmation',
        });
    }

    return enriched;
}

/**
 * Mark a Slack request as nudged (update last_nudge_at).
 */
export async function markRequestNudged(requestIds: number[]): Promise<void> {
    if (requestIds.length === 0) return;
    const db = createClient();
    if (!db) return;

    await db
        .from('slack_requests')
        .update({ last_nudge_at: new Date().toISOString() })
        .in('id', requestIds);
}

/**
 * Build the full follow-up report.
 */
export async function buildFollowUpReport(): Promise<FollowUpReport> {
    const [staleRequests, vendorFollowUps] = await Promise.all([
        getStaleSlackRequests(),
        getVendorFollowUps(),
    ]);

    return {
        staleSlackRequests: staleRequests,
        vendorFollowUps,
        summary: {
            totalPending: staleRequests.length + vendorFollowUps.length,
            totalStale: staleRequests.length,
            totalVendor: vendorFollowUps.length,
        },
        generatedAt: new Date().toISOString(),
    };
}

/**
 * Format the follow-up report for Telegram.
 */
export function formatFollowUpReport(report: FollowUpReport): string {
    if (report.summary.totalPending === 0) {
        return "✅ *No follow-ups pending.* All Slack requests answered, all vendor POs confirmed.";
    }

    const lines: string[] = [];
    lines.push(`📋 *Follow-Up SOP — ${report.summary.totalPending} items need attention*`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // Stale Slack requests
    if (report.staleSlackRequests.length > 0) {
        lines.push(`\n💬 *${report.staleSlackRequests.length} UNANSWERED SLACK REQUESTS*\n`);

        for (const req of report.staleSlackRequests.slice(0, 5)) {
            const text = req.original_text.slice(0, 60);
            const items = req.items_requested?.slice(0, 3).join(", ") || text;
            lines.push(`• *${req.requester_name}* in #${req.channel_name} — ${req.age_hours}h ago`);
            lines.push(`  _"${items}"_`);
            lines.push("");
        }

        if (report.staleSlackRequests.length > 5) {
            lines.push(`  _...and ${report.staleSlackRequests.length - 5} more_\n`);
        }
    }

    // Vendor POs without confirmation
    if (report.vendorFollowUps.length > 0) {
        lines.push(`📦 *${report.vendorFollowUps.length} VENDOR POs WITHOUT CONFIRMATION*\n`);

        for (const vf of report.vendorFollowUps.slice(0, 5)) {
            lines.push(`• PO #${vf.po_number} → *${vf.vendor_name}* — ${vf.age_hours}h ago`);
            if (vf.vendor_email) {
                lines.push(`  📧 ${vf.vendor_email}`);
            }
            lines.push("");
        }

        if (report.vendorFollowUps.length > 5) {
            lines.push(`  _...and ${report.vendorFollowUps.length - 5} more_\n`);
        }
    }

    lines.push(`\n🕐 _Generated ${new Date(report.generatedAt).toLocaleTimeString()}_`);
    return lines.join("\n");
}

/**
 * Run the follow-up SOP: check for stale items and nudge Bill if needed.
 * Called from the cron job.
 */
export async function runFollowUpSOP(): Promise<void> {
    const report = await buildFollowUpReport();

    if (report.summary.totalPending === 0) {
        console.log('[followup-sop] No pending follow-ups.');
        return;
    }

    // Send Telegram nudge
    const formatted = formatFollowUpReport(report);
    await sendTelegramNotify(formatted);

    // Mark Slack requests as nudged to avoid re-nudging
    const nudgeIds = report.staleSlackRequests.map(r => r.id);
    await markRequestNudged(nudgeIds);

    console.log(`[followup-sop] Nudged for ${report.summary.totalPending} items (${report.summary.totalStale} slack, ${report.summary.totalVendor} vendor).`);
}
