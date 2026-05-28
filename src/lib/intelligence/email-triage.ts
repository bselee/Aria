/**
 * @file    src/lib/intelligence/email-triage.ts
 * @purpose Email triage report for the /email Telegram command.
 *          Surfaces: queue health, stuck emails, pending forwards,
 *          slow vendors, and orphan drafts. Ninja-grade — silent unless
 *          actionable, concise when queried.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/supabase
 *
 * DESIGN:
 *   This replaces the need to check Gmail manually. One command shows:
 *   1. How many emails are in each pipeline stage
 *   2. Any stuck/errored items (actionable)
 *   3. Vendor acknowledgment speed (slow vendor alert)
 *   4. Draft follow-ups waiting for Bill's review
 */

import { createClient } from "../supabase";

// ── Types ───────────────────────────────────────────────────────────────────

export interface EmailTriageReport {
    /** Emails waiting in email_inbox_queue */
    inboxQueue: {
        unprocessed: number;
        stuck: number;             // unprocessed for >6 hours
        bySource: Record<string, number>;
    };

    /** Emails in ap_inbox_queue */
    apQueue: {
        pendingForward: number;
        processing: number;
        forwarded: number;         // last 24h
        errored: number;
        stuck: Array<{
            messageId: string;
            from: string;
            subject: string;
            status: string;
            ageHours: number;
        }>;
    };

    /** Ack acknowledgement pipeline */
    acknowledgements: {
        processedByAck: number;    // last 24h
        pendingUnack: number;      // unprocessed emails in default inbox
    };

    /** Vendor PO recognition metrics (last 30 days) */
    vendorResponse: {
        slowVendors: Array<{
            vendorName: string;
            avgAckDays: number;
            totalPOs: number;
            unackedPOs: number;
        }>;
    };

    /** PO follow-up drafts waiting in Gmail */
    draftFollowUps: {
        count: number;
        items: Array<{
            poNumber: string;
            vendorName: string;
            draftedAt: string;
            ageDays: number;
        }>;
    };

    /** Summary */
    summary: {
        actionableErrors: number;
        totalUnprocessed: number;
        alerts: string[];
    };

    generatedAt: string;
}

// ── Core Logic ──────────────────────────────────────────────────────────────

export async function buildEmailTriageReport(): Promise<EmailTriageReport> {
    const db = createClient();
    const alerts: string[] = [];
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 86400000).toISOString();
    const sixHoursAgo = new Date(now.getTime() - 6 * 3600000).toISOString();

    const report: EmailTriageReport = {
        inboxQueue: { unprocessed: 0, stuck: 0, bySource: {} },
        apQueue: { pendingForward: 0, processing: 0, forwarded: 0, errored: 0, stuck: [] },
        acknowledgements: { processedByAck: 0, pendingUnack: 0 },
        vendorResponse: { slowVendors: [] },
        draftFollowUps: { count: 0, items: [] },
        summary: { actionableErrors: 0, totalUnprocessed: 0, alerts: [] },
        generatedAt: now.toISOString(),
    };

    if (!db) {
        alerts.push("⚠️ Supabase unavailable — cannot query queue status");
        report.summary.alerts = alerts;
        return report;
    }

    // ── 1. Email Inbox Queue ────────────────────────────────────────
    try {
        const { data: inboxStats } = await db
            .from("email_inbox_queue")
            .select("status, source_inbox, created_at")
            .gte("created_at", oneDayAgo);

        if (inboxStats) {
            for (const row of inboxStats as any[]) {
                if (row.status === "unprocessed") {
                    report.inboxQueue.unprocessed++;
                    const source = row.source_inbox || "unknown";
                    report.inboxQueue.bySource[source] = (report.inboxQueue.bySource[source] || 0) + 1;
                    if (row.created_at < sixHoursAgo) {
                        report.inboxQueue.stuck++;
                    }
                }
            }
        }
    } catch (e: any) {
        // email_inbox_queue may not exist yet in some environments
    }

    // ── 2. AP Inbox Queue ───────────────────────────────────────────
    try {
        const { data: apStats } = await db
            .from("ap_inbox_queue")
            .select("status, message_id, extracted_json, created_at")
            .gte("created_at", oneDayAgo);

        if (apStats) {
            for (const row of apStats as any[]) {
                switch (row.status) {
                    case "PENDING_FORWARD":
                        report.apQueue.pendingForward++;
                        break;
                    case "PROCESSING_FORWARD":
                    case "PROCESSING":
                        report.apQueue.processing++;
                        break;
                    case "FORWARDED":
                    case "PROCESSED":
                        report.apQueue.forwarded++;
                        break;
                    case "ERROR_FORWARDING":
                    case "ERROR_PROCESSING":
                    case "ERROR":
                        report.apQueue.errored++;
                        break;
                }

                // Stuck items: in PENDING_FORWARD or PROCESSING for >6h
                if ((row.status === "PENDING_FORWARD" || row.status.startsWith("PROCESSING"))
                    && row.created_at < sixHoursAgo) {
                    const ageHours = Math.round((now.getTime() - new Date(row.created_at).getTime()) / 3600000);
                    const extracted = row.extracted_json || {};
                    report.apQueue.stuck.push({
                        messageId: row.message_id || "unknown",
                        from: extracted.from || extracted.vendor_name || "unknown",
                        subject: extracted.subject || "no subject",
                        status: row.status,
                        ageHours,
                    });
                }
            }
        }
    } catch (e: any) {
        // ap_inbox_queue may not exist
    }

    // ── 3. Acknowledgements ─────────────────────────────────────────
    try {
        const { count: ackCount } = await db
            .from("email_inbox_queue")
            .select("*", { count: "exact", head: true })
            .eq("processed_by_ack", true)
            .gte("created_at", oneDayAgo);
        report.acknowledgements.processedByAck = ackCount || 0;

        const { count: unackCount } = await db
            .from("email_inbox_queue")
            .select("*", { count: "exact", head: true })
            .eq("source_inbox", "default")
            .eq("status", "unprocessed")
            .or("processed_by_ack.is.null,processed_by_ack.eq.false");
        report.acknowledgements.pendingUnack = unackCount || 0;
    } catch (e: any) {
        // graceful — these columns may not exist in all migrations
    }

    // ── 4. Vendor Response Speed ────────────────────────────────────
    try {
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString();
        const { data: vendorPOs } = await db
            .from("purchase_orders")
            .select("vendor_name, po_sent_verified_at, vendor_acknowledged_at, vendor_ack_source")
            .not("po_sent_verified_at", "is", "null")
            .gte("po_sent_verified_at", thirtyDaysAgo);

        if (vendorPOs && vendorPOs.length > 0) {
            const vendorBuckets = new Map<string, { acked: number[]; total: number; unacked: number }>();

            for (const po of vendorPOs as any[]) {
                const name = po.vendor_name || "Unknown";
                if (!vendorBuckets.has(name)) {
                    vendorBuckets.set(name, { acked: [], total: 0, unacked: 0 });
                }
                const bucket = vendorBuckets.get(name)!;
                bucket.total++;
                if (po.vendor_acknowledged_at && po.po_sent_verified_at) {
                    const ackDays = (new Date(po.vendor_acknowledged_at).getTime()
                        - new Date(po.po_sent_verified_at).getTime()) / 86400000;
                    if (ackDays >= 0 && ackDays < 60) bucket.acked.push(ackDays);
                } else {
                    bucket.unacked++;
                }
            }

            const slow: EmailTriageReport["vendorResponse"]["slowVendors"] = [];
            for (const [name, b] of Array.from(vendorBuckets.entries())) {
                if (b.acked.length === 0 && b.total < 2) continue; // skip noise
                const avg = b.acked.length > 0
                    ? b.acked.reduce((s, n) => s + n, 0) / b.acked.length
                    : b.unacked > 0 ? 99 : 0; // 99 = never responded
                if (avg > 3 || b.unacked > 1) {
                    slow.push({
                        vendorName: name,
                        avgAckDays: Math.round(avg * 10) / 10,
                        totalPOs: b.total,
                        unackedPOs: b.unacked,
                    });
                }
            }
            slow.sort((a, b) => b.avgAckDays - a.avgAckDays);
            report.vendorResponse.slowVendors = slow.slice(0, 5);
        }
    } catch (e: any) {
        // purchase_orders table may differ
    }

    // ── 5. Draft Follow-ups ─────────────────────────────────────────
    try {
        const { data: drafts } = await db
            .from("purchase_orders")
            .select("po_number, vendor_name, tracking_requested_at")
            .not("tracking_requested_at", "is", "null")
            .is("vendor_acknowledged_at", null)
            .is("vendor_noncomm_at", null)
            .order("tracking_requested_at", { ascending: false })
            .limit(5);

        if (drafts) {
            report.draftFollowUps.count = drafts.length;
            for (const d of drafts as any[]) {
                const ageDays = Math.round(
                    (now.getTime() - new Date(d.tracking_requested_at).getTime()) / 86400000
                );
                report.draftFollowUps.items.push({
                    poNumber: d.po_number,
                    vendorName: d.vendor_name || "Unknown",
                    draftedAt: d.tracking_requested_at,
                    ageDays,
                });
            }
        }
    } catch (e: any) { /* graceful */ }

    // ── 6. Summary ──────────────────────────────────────────────────
    report.summary.actionableErrors = report.apQueue.errored + report.inboxQueue.stuck;
    report.summary.totalUnprocessed = report.inboxQueue.unprocessed + report.apQueue.pendingForward;

    if (report.apQueue.errored > 0) {
        alerts.push(`🔴 ${report.apQueue.errored} email(s) stuck in ERROR status`);
    }
    if (report.inboxQueue.stuck > 0) {
        alerts.push(`⚠️ ${report.inboxQueue.stuck} inbox email(s) unprocessed >6h`);
    }
    if (report.apQueue.stuck.length > 0) {
        alerts.push(`⏰ ${report.apQueue.stuck.length} AP item(s) stuck in pipeline >6h`);
    }
    if (report.draftFollowUps.count > 0) {
        const oldest = report.draftFollowUps.items[0];
        if (oldest && oldest.ageDays > 2) {
            alerts.push(`📝 ${report.draftFollowUps.count} draft follow-up(s) waiting — oldest ${oldest.ageDays}d`);
        }
    }
    if (report.vendorResponse.slowVendors.length > 0) {
        const worst = report.vendorResponse.slowVendors[0];
        if (worst && worst.avgAckDays > 7) {
            alerts.push(`🐌 ${worst.vendorName} avg ${worst.avgAckDays}d to ack POs`);
        }
    }

    report.summary.alerts = alerts;
    return report;
}

/**
 * Format the triage report for Telegram. Clean, actionable, no noise.
 */
export function formatEmailTriageReport(report: EmailTriageReport): string {
    const lines: string[] = [];
    lines.push(`✉️ *Email Pipeline — ${new Date(report.generatedAt).toLocaleTimeString()}*`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // Alerts first — this is what matters
    if (report.summary.alerts.length > 0) {
        lines.push("");
        for (const a of report.summary.alerts) {
            lines.push(a);
        }
    }

    // Queue health
    lines.push("");
    lines.push(`📥 *Inbox Queue*`);
    const sources = Object.entries(report.inboxQueue.bySource);
    if (sources.length > 0) {
        for (const [src, count] of sources) {
            lines.push(`   ${src}: ${count} pending`);
        }
    } else {
        lines.push(`   None pending`);
    }

    // AP pipeline
    lines.push(`📦 *AP Pipeline*`);
    lines.push(`   Forwarded (24h): ${report.apQueue.forwarded}`);
    lines.push(`   Pending: ${report.apQueue.pendingForward} | Processing: ${report.apQueue.processing}`);
    if (report.apQueue.errored > 0) {
        lines.push(`   🔴 Errors: ${report.apQueue.errored}`);
    }

    // Ack pipeline
    lines.push(`💬 *Acknowledgements*`);
    lines.push(`   Auto-replied (24h): ${report.acknowledgements.processedByAck}`);
    if (report.acknowledgements.pendingUnack > 3) {
        lines.push(`   Pending triage: ${report.acknowledgements.pendingUnack}`);
    }

    // Stuck items
    if (report.apQueue.stuck.length > 0) {
        lines.push(`\n⏰ *Stuck AP Items*`);
        for (const item of report.apQueue.stuck.slice(0, 3)) {
            lines.push(`   • ${item.from} — ${item.subject.slice(0, 40)} (${item.ageHours}h)`);
        }
    }

    // Slow vendors
    if (report.vendorResponse.slowVendors.length > 0) {
        lines.push(`\n🐌 *Slowest Vendor Acks (30d)*`);
        for (const v of report.vendorResponse.slowVendors.slice(0, 3)) {
            const ack = v.avgAckDays >= 99 ? "no ack" : `${v.avgAckDays}d`;
            lines.push(`   • ${v.vendorName}: ${ack} (${v.totalPOs} POs, ${v.unackedPOs} unacked)`);
        }
    }

    // Draft follow-ups
    if (report.draftFollowUps.count > 0) {
        lines.push(`\n📝 *Draft Follow-ups*`);
        for (const item of report.draftFollowUps.items.slice(0, 3)) {
            lines.push(`   • PO ${item.poNumber} → ${item.vendorName} (${item.ageDays}d old)`);
        }
    }

    if (report.summary.alerts.length === 0) {
        lines.push(`\n✅ Pipeline healthy.`);
    }

    return lines.join("\n");
}
