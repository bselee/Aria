/**
 * @file    src/lib/intelligence/ap-summary.ts
 * @purpose Autonomous AP flow summary. Shows how many invoices were
 *          auto-approved, need review, or failed in the last 24h.
 *          Gives Bill confidence the autonomous flow is working.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/db
 *
 * DESIGN:
 *   Queries ap_activity_log for the last 24 hours:
 *   - Auto-approved: intent=RECONCILIATION + verdict=auto_approve
 *   - Needs review:  intent=RECONCILIATION + verdict=needs_approval
 *   - Failed:        intent=RECONCILIATION + verdict=rejected/short_shipment_hold
 *   - No match:      intent=RECONCILIATION + verdict=no_match
 *   - Forwards:      intent contains "Forwarded" in action_taken
 *
 *   Also shows vendor breakdown for auto-approved invoices so Bill can
 *   see which vendors are behaving.
 */

import { createClient } from "../db";

export interface APSummaryReport {
    periodHours: number;
    forwarded: number;
    autoApproved: number;
    needsReview: number;
    failed: number;
    noMatch: number;
    totalProcessed: number;
    autoApprovalRate: number | null;  // 0..1 or null if no reconciliations
    topVendors: Array<{
        vendor: string;
        count: number;
        avgDollarImpact: number | null;
    }>;
    recentNeedsReview: Array<{
        vendor: string;
        invoice: string;
        reason: string;
        dollarImpact: number;
    }>;
    generatedAt: string;
}

export async function buildAPSummary(periodHours: number = 24): Promise<APSummaryReport> {
    const db = createClient();
    if (!db) {
        return {
            periodHours,
            forwarded: 0, autoApproved: 0, needsReview: 0,
            failed: 0, noMatch: 0, totalProcessed: 0,
            autoApprovalRate: null, topVendors: [], recentNeedsReview: [],
            generatedAt: new Date().toISOString(),
        };
    }

    const since = new Date(Date.now() - periodHours * 3600000).toISOString();

    // Count forwards
    let forwarded = 0;
    try {
        const { count } = await db.from("ap_activity_log")
            .select("*", { count: "exact", head: true })
            .ilike("action_taken", "%Forwarded%")
            .gte("created_at", since);
        forwarded = count || 0;
    } catch { /* table may differ */ }

    // Get all reconciliation entries in the period
    const { data: reconciliations } = await db.from("ap_activity_log")
        .select("action_taken, metadata, reconciliation_report, created_at")
        .eq("intent", "RECONCILIATION")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(200);

    if (!reconciliations || reconciliations.length === 0) {
        return {
            periodHours, forwarded,
            autoApproved: 0, needsReview: 0, failed: 0, noMatch: 0,
            totalProcessed: 0, autoApprovalRate: null,
            topVendors: [], recentNeedsReview: [],
            generatedAt: new Date().toISOString(),
        };
    }

    let autoApproved = 0, needsReview = 0, failed = 0, noMatch = 0;
    const vendorCounts = new Map<string, { count: number; dollarImpacts: number[] }>();
    const needsReviewList: APSummaryReport["recentNeedsReview"] = [];

    for (const row of reconciliations as any[]) {
        const meta = row.metadata || {};
        const verdict = meta.verdict || meta.disposition ||
            (row.reconciliation_report?.overallVerdict) ||
            (row.action_taken || "").toLowerCase();

        const vendor = meta.vendor || meta.vendorName || row.email_from || "unknown";
        const invoice = meta.invoice || meta.invoiceNumber || "?";
        const action = (row.action_taken || "").toLowerCase();

        if (verdict === "auto_approve" || action.includes("auto") || action.includes("applied")) {
            autoApproved++;
            const existing = vendorCounts.get(vendor) || { count: 0, dollarImpacts: [] };
            existing.count++;
            if (meta.dollarImpact != null) existing.dollarImpacts.push(Number(meta.dollarImpact));
            vendorCounts.set(vendor, existing);
        } else if (verdict === "needs_approval" || action.includes("pending") || action.includes("approval")) {
            needsReview++;
            if (needsReviewList.length < 5) {
                needsReviewList.push({
                    vendor,
                    invoice,
                    reason: meta.reason || meta.blockReason || "price change exceeded threshold",
                    dollarImpact: Number(meta.dollarImpact || meta.totalDollarImpact || 0),
                });
            }
        } else if (verdict === "rejected" || verdict === "short_shipment_hold" || action.includes("error") || action.includes("failed")) {
            failed++;
        } else if (verdict === "no_match" || action.includes("no match") || action.includes("unmatched")) {
            noMatch++;
        } else if (verdict === "no_change") {
            autoApproved++; // no_change counts as auto-handled
            const existing = vendorCounts.get(vendor) || { count: 0, dollarImpacts: [] };
            existing.count++;
            vendorCounts.set(vendor, existing);
        }
    }

    const totalProcessed = autoApproved + needsReview + failed + noMatch;
    const autoApprovalRate = totalProcessed > 0 ? autoApproved / totalProcessed : null;

    const topVendors = Array.from(vendorCounts.entries())
        .map(([vendor, data]) => ({
            vendor,
            count: data.count,
            avgDollarImpact: data.dollarImpacts.length > 0
                ? data.dollarImpacts.reduce((a, b) => a + b, 0) / data.dollarImpacts.length
                : null,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

    return {
        periodHours,
        forwarded,
        autoApproved,
        needsReview,
        failed,
        noMatch,
        totalProcessed,
        autoApprovalRate,
        topVendors,
        recentNeedsReview: needsReviewList,
        generatedAt: new Date().toISOString(),
    };
}

/**
 * Format AP summary for Telegram.
 */
export function formatAPSummary(report: APSummaryReport): string {
    const lines: string[] = [];
    const rate = report.autoApprovalRate != null ? `${Math.round(report.autoApprovalRate * 100)}%` : "N/A";

    lines.push(`🏭 *AP Summary — Last ${report.periodHours}h*`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    if (report.totalProcessed === 0 && report.forwarded === 0) {
        lines.push(`No AP activity in the last ${report.periodHours}h.`);
        return lines.join("\n");
    }

    lines.push(`📨 Forwarded to Bill.com: ${report.forwarded}`);
    lines.push(`✅ Auto-approved: ${report.autoApproved}`);
    lines.push(`⏳ Needs review: ${report.needsReview}`);
    if (report.noMatch > 0) lines.push(`❓ No match: ${report.noMatch}`);
    if (report.failed > 0) lines.push(`❌ Failed: ${report.failed}`);
    lines.push(`📊 Auto-approval rate: ${rate}`);

    if (report.topVendors.length > 0) {
        lines.push(`\n🏆 *Top Vendors (auto-approved)*`);
        for (const v of report.topVendors) {
            const impact = v.avgDollarImpact != null ? ` ($${v.avgDollarImpact.toFixed(2)} avg)` : "";
            lines.push(`  • ${v.vendor}: ${v.count} invoice${v.count !== 1 ? "s" : ""}${impact}`);
        }
    }

    if (report.recentNeedsReview.length > 0) {
        lines.push(`\n⚠️ *Needs Review*`);
        for (const r of report.recentNeedsReview) {
            const impact = r.dollarImpact ? ` $${r.dollarImpact.toFixed(2)}` : "";
            lines.push(`  • ${r.vendor} inv#${r.invoice}${impact}`);
            lines.push(`    _${r.reason.slice(0, 80)}_`);
        }
    }

    return lines.join("\n");
}
