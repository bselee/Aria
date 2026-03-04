/**
 * @file    vendor-insights/route.ts
 * @purpose Provides vendor approval history and auto-approve suggestion data.
 *          Queries ap_activity_log to compute "Based on N past approvals..." suggestions.
 * @author  Will
 * @created 2026-03-04
 * @updated 2026-03-04
 * @deps    supabase
 * @env     SUPABASE_SERVICE_ROLE_KEY
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";

type LogEntry = {
    reviewed_action: string | null;
    dismiss_reason: string | null;
    metadata: Record<string, any> | null; // any: ap_activity_log.metadata JSONB — shape varies by intent
    created_at: string;
};

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const vendor = searchParams.get("vendor");

        if (!vendor) {
            return NextResponse.json({ error: "vendor parameter required" }, { status: 400 });
        }

        const supabase = createClient();
        if (!supabase) {
            return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
        }

        // Query all reconciliation entries for this vendor
        const { data } = await supabase
            .from("ap_activity_log")
            .select("reviewed_action, dismiss_reason, metadata, created_at")
            .eq("intent", "RECONCILIATION")
            .ilike("email_from", `%${vendor}%`)
            .order("created_at", { ascending: false })
            .limit(50);

        const logs = (data || []) as LogEntry[];

        // Also fetch vendor profile for Phase 3 threshold data
        const { data: vendorProfile } = await supabase
            .from("vendor_profiles")
            .select("auto_approve_threshold, default_dismiss_action, reconciliation_count, approval_count")
            .ilike("vendor_name", `%${vendor}%`)
            .single();

        const threshold = vendorProfile?.auto_approve_threshold ?? null;

        if (!logs || logs.length === 0) {
            return NextResponse.json({
                vendor,
                totalReconciliations: 0,
                approvedCount: 0,
                dismissedCount: 0,
                pausedCount: 0,
                unreviewedCount: 0,
                approvalRate: 0,
                suggestion: null,
                recentActions: [],
            });
        }

        const approved = logs.filter(l => l.reviewed_action === "approved");
        const dismissed = logs.filter(l => l.reviewed_action === "dismissed");
        const paused = logs.filter(l => l.reviewed_action === "paused");
        const unreviewed = logs.filter(l => !l.reviewed_action || l.reviewed_action === "paused");

        const approvalRate = logs.length > 0
            ? Math.round((approved.length / logs.length) * 100)
            : 0;

        // Build suggestion based on approval patterns
        let suggestion: {
            type: "auto_approve" | "caution" | "info";
            message: string;
            confidence: number;
        } | null = null;

        // DECISION(2026-03-04): Suggest auto-approve if vendor has 5+ reconciliations
        // and 80%+ approval rate with zero rejections/dismissed items.
        if (approved.length >= 5 && approvalRate >= 80) {
            const thresholdNote = threshold !== null
                ? ` Auto-approve active at ≤${threshold}% variance.`
                : " Auto-approve threshold will be set on next approval.";
            suggestion = {
                type: "auto_approve",
                message: `${approved.length} of ${logs.length} reconciliations approved for this vendor.${thresholdNote}`,
                confidence: Math.min(approvalRate, 95), // never say 100%
            };
        } else if (dismissed.length >= 2) {
            // Check for pattern — same dismiss reason repeatedly
            const dismissReasons = dismissed.map(d => d.dismiss_reason).filter(Boolean);
            const reasonCounts: Record<string, number> = {};
            dismissReasons.forEach(r => { reasonCounts[r!] = (reasonCounts[r!] || 0) + 1; });
            const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];

            if (topReason && topReason[1] >= 2) {
                suggestion = {
                    type: "caution",
                    message: `${topReason[1]} invoices from this vendor dismissed as "${topReason[0]}". Consider auto-routing.`,
                    confidence: Math.round((topReason[1] / logs.length) * 100),
                };
            }
        } else if (logs.length >= 3 && logs.length < 5) {
            suggestion = {
                type: "info",
                message: `${logs.length} reconciliations so far. ${5 - logs.length} more needed for auto-approve suggestion.`,
                confidence: approvalRate,
            };
        }

        // Compute average dollar impact of approved reconciliations
        const avgImpact = approved.length > 0
            ? approved.reduce((sum: number, l: LogEntry) => sum + (l.metadata?.totalDollarImpact || 0), 0) / approved.length
            : 0;

        return NextResponse.json({
            vendor,
            totalReconciliations: logs.length,
            approvedCount: approved.length,
            dismissedCount: dismissed.length,
            pausedCount: paused.length,
            unreviewedCount: unreviewed.length,
            approvalRate,
            avgImpact: Math.round(avgImpact * 100) / 100,
            suggestion,
            autoApproveThreshold: threshold,
            defaultDismissAction: vendorProfile?.default_dismiss_action ?? null,
            recentActions: logs.slice(0, 5).map((l: LogEntry) => ({
                action: l.reviewed_action || "pending",
                reason: l.dismiss_reason,
                date: l.created_at,
                invoice: l.metadata?.invoiceNumber,
                po: l.metadata?.orderId,
            })),
        });

    } catch (err: any) {
        console.error("Vendor insights error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
