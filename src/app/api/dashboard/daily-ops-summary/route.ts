/**
 * @file    daily-ops-summary/route.ts
 * @purpose API route for the Daily Ops Summary dashboard panel.
 *          Aggregates today's email volume, AP invoices, PO activity,
 *          tracking updates, and vendor acknowledgements.
 * @author  Hermia
 * @created 2026-05-29
 * @deps    @/lib/db
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/db";

export const dynamic = 'force-dynamic';

export const revalidate = 60; // 1-minute cache

export async function GET(req: Request) {
    const db = createClient();
    if (!db) {
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
        db.from("email_inbox_queue").select("id", { count: "exact", head: true }).gte("created_at", today + "T00:00:00"),
        // AP queue activity
        db.from("ap_inbox_queue").select("id, status", { count: "exact" }).gte("created_at", today + "T00:00:00"),
        // AP activity log
        db.from("ap_activity_log").select("action_taken, id").gte("created_at", today + "T00:00:00").limit(500),
        // POs created today
        db.from("purchase_orders").select("po_number", { count: "exact", head: true }).gte("created_at", today + "T00:00:00"),
        // POs sent today
        db.from("purchase_orders").select("po_number", { count: "exact", head: true }).gte("po_sent_verified_at", today + "T00:00:00"),
        // Receivings today
        db.from("shipments").select("id", { count: "exact", head: true }).gte("delivered_at", today + "T00:00:00"),
        // Cron runs today
        db.from("cron_runs").select("task_name, status, id").gte("started_at", today + "T00:00:00").order("started_at", { ascending: false }).limit(100),
    ]);

    // AP activity breakdown
    const activityCounts: Record<string, number> = {};
    for (const row of (apActivity.data || []) as any[]) {
        const action = (row.action || "unknown").toLowerCase();
        activityCounts[action] = (activityCounts[action] || 0) + 1;
    }

    // ── Detect silent query failures ─────────────────────────────────────────
    // PostgREST returns HTTP 4xx in the error field rather than throwing,
    // so erroneous queries produce null data and are indistinguishable from
    // an empty dataset. Surface the degraded state explicitly.
    const degraded: string[] = [];
    const results = { emailInbox, apQueue, apActivity, posCreated, posSent, receivings, cronRuns };
    for (const [label, res] of Object.entries(results)) {
        if (res.error) {
            degraded.push(`${label}: ${res.error.message || res.error.hint || JSON.stringify(res.error)}`);
        }
    }

    // ── Cron run summary ──────────────────────────────────────────────────────
    // Status vocabulary: running, succeeded, failed, cancelled, skipped,
    // plus legacy success/error, plus 'unknown' (fabricated telemetry from
    // an old unfiltered-UPDATE bug — NOT a real failure).
    const cronFails: string[] = [];
    const cronSuccess = new Set<string>();
    let cronUnknown = 0;
    for (const run of (cronRuns.data || []) as any[]) {
        const s = run.status;
        if (s === "failed" || s === "error") {
            cronFails.push(run.task_name);
        } else if (s === "succeeded" || s === "success") {
            cronSuccess.add(run.task_name);
        } else if (s === "unknown") {
            cronUnknown++;
        }
        // running, cancelled, skipped → excluded from totals
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
            unknownRuns: cronUnknown,
        },
        ...(degraded.length > 0 ? { degraded } : {}),
    }, { headers: { "Cache-Control": "public, max-age=60" } });
}
