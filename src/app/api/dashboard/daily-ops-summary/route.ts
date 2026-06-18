/**
 * @file    daily-ops-summary/route.ts
 * @purpose API route for the Daily Ops Summary dashboard panel.
 *          Aggregates today's email volume, AP invoices, PO activity,
 *          tracking updates, and vendor acknowledgements.
 * @author  Hermia
 * @created 2026-05-29
 * @deps    @/lib/supabase
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";

export const dynamic = 'force-dynamic';

export const revalidate = 60; // 1-minute cache

export async function GET(req: Request) {
    const supabase = createClient();
    if (!supabase) {
        return NextResponse.json({ error: "Supabase unavailable" }, { status: 503 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const [
        emailInbox,
        apQueue,
        apActivity,
        posCreated,
        posSent,
        receivings,
        cronRuns,
    ] = await Promise.all([
        // Email volume (both inboxes)
        supabase.from("email_inbox_queue").select("id", { count: "exact", head: true }).gte("created_at", today + "T00:00:00"),
        // AP queue activity
        supabase.from("ap_inbox_queue").select("id, status", { count: "exact" }).gte("created_at", today + "T00:00:00"),
        // AP activity log
        supabase.from("ap_activity_log").select("action, id").gte("created_at", today + "T00:00:00").limit(500),
        // POs created today
        supabase.from("purchase_orders").select("po_number", { count: "exact", head: true }).gte("created_at", today + "T00:00:00"),
        // POs sent today
        supabase.from("purchase_orders").select("po_number", { count: "exact", head: true }).gte("po_sent_verified_at", today + "T00:00:00"),
        // Receivings today
        supabase.from("shipments").select("id", { count: "exact", head: true }).gte("delivered_at", today + "T00:00:00"),
        // Cron runs today
        supabase.from("cron_runs").select("job_name, status, id").gte("ran_at", today + "T00:00:00").order("ran_at", { ascending: false }).limit(100),
    ]);

    // AP activity breakdown
    const activityCounts: Record<string, number> = {};
    for (const row of (apActivity.data || []) as any[]) {
        const action = (row.action || "unknown").toLowerCase();
        activityCounts[action] = (activityCounts[action] || 0) + 1;
    }

    // Cron run summary
    const cronFails: string[] = [];
    const cronSuccess = new Set<string>();
    for (const run of (cronRuns.data || []) as any[]) {
        if (run.status === "failed" || run.status === "error") {
            cronFails.push(run.job_name);
        } else {
            cronSuccess.add(run.job_name);
        }
    }

    return NextResponse.json({
        date: today,
        emails: { received: emailInbox.count || 0 },
        ap: {
            queued: apQueue.count || 0,
            forwarded: activityCounts["forwarded"] || activityCounts["queued_for_billcom"] || 0,
            reconciled: activityCounts["reconciled"] || 0,
            rejected: activityCounts["rejected"] || activityCounts["blocked"] || 0,
            duplicate: activityCounts["duplicate"] || activityCounts["duplicate_skipped"] || 0,
        },
        purchasing: {
            posCreated: posCreated.count || 0,
            posSent: posSent.count || 0,
            receivings: receivings.count || 0,
        },
        cron: {
            totalRuns: (cronRuns.data || []).length,
            failedJobs: [...new Set(cronFails)],
            successJobs: cronSuccess.size,
        },
    }, { headers: { "Cache-Control": "public, max-age=60" } });
}
