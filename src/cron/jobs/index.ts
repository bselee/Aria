/**
 * @file    src/cron/jobs/index.ts
 * @purpose One defineJob() entry per scheduled job migrated out of
 *          src/lib/intelligence/ops-manager.ts. Importing this file is
 *          a side-effect: every job below is registered with the typed
 *          registry. start-bot.ts imports this BEFORE calling
 *          startCronRunner().
 *
 * Handlers reach the live OpsManager via the static singleton field
 * (set in the constructor). If singleton is unset, handlers no-op —
 * this keeps Vitest imports of the registry safe even when no
 * OpsManager has booted.
 *
 * KAIZEN edits applied in this migration:
 *   #4: po-sync 30m -> 4h (vendor PO emails rarely change <6h).
 *   #6: missing-reconciliation-watchdog Mon-Fri only (was firing
 *       false alarms on weekends when no reconciliations are scheduled).
 *   #7 (2026-06-12): Business hours enforcement — all Telegram-sending
 *       crons shifted into 8 AM–5 PM window. Early-morning jobs moved
 *       to 8:00+ and critical: true flags removed from non-emergency paths.
 */

import { defineJob } from "../registry";
import { generateAndSendMondayBriefing } from "@/lib/intelligence/monday-briefing";
import { OpsManager } from "../../lib/intelligence/ops-manager";

const ops = () => OpsManager.singleton;

defineJob({
    name: "ap-polling",
    schedule: "0 8,12,17 * * *",
    onFail: "telegram-will",
    description: "Poll ap@buildasoil.com for new invoices, then PO-sweep post-pass.",
    handler: async () => {
        // HERMIA(2026-06-18): Local-first forwarding — scans Gmail directly, forwards
        // invoice PDFs to Bill.com, tracks dedup in local SQLite. Zero Supabase
        // dependency for the critical path. Runs FIRST so invoices always forward
        // even when Supabase is down (PGRST002 / free-tier exhaustion).
        try {
            const { runLocalApForward } = await import("@/lib/intelligence/workers/ap-local-forwarder");
            await runLocalApForward();
        } catch (err: any) {
            console.error("[ap-polling] Local forwarder error:", err?.message ?? err);
        }

        // The Supabase-based pipeline (identifier + forwarder + PO reconciliation)
        // still runs for dashboard visibility and PO matching, but is no longer
        // the critical path — the local forwarder handles Gmail -> Bill.com.
        const o = ops();
        if (!o) return;
        await o.pollAPInbox();
        // KAIZEN #5: po-sweep folded into ap-polling. Was its own */4h cron;
        // now runs as a post-pass on every ap-polling tick to share the inbox
        // walk with classification + forwarding. The ~3-4x more frequent run
        // is fine — po-sweep is mostly a no-op when there's nothing to match.
        try { await o.runPOSweep(); } catch (err: any) {
            console.warn(`[ap-polling] post-pass po-sweep failed: ${err?.message ?? err}`);
            throw err;
        }
    },
    budget: { durationMs: 180_000 },  // bumped from default to cover the post-pass
});

defineJob({
    name: "build-risk",
    schedule: "0 8 * * 1-5",  // KAIZEN #7: 7:30 → 8:00 (business hours start)
    onFail: "telegram-will",
    description: "Daily build risk analysis (Mon-Fri 8:00 AM).",
    handler: async () => { await ops()?.runDailyBuildRisk(); },
});

defineJob({
    name: "jit-forward-projection",
        schedule: "0 8 * * 1-5",
        onFail: "telegram-will",
    description: "8:00 AM (Mon-Fri): reads the latest build_risk_snapshot and fires a Telegram alert for any component whose order-trigger date is today or within the next 7 days. Replaces the previous daily build-risk summary with JIT-only alerts only — no news is good news.",
    handler: async () => {
        const { createClient } = await import("@/lib/supabase");

        // Bill's rule: don't ping daily. Only alert when an orderTriggerDate is
        // imminent (≤7 days away). If every component is far in the future,
        // stay silent — "no news is good news".
        const ALERT_BUFFER_DAYS = 7;

        const db = createClient();
        if (!db) {
            console.log("[jit-forward-projection] Supabase unavailable — skipping.");
            return;
        }

        // Latest snapshot that has components JSON with orderTriggerDate fields
        // (written by the build-risk job that already fired at 8:00).
        const { data, error } = await db
            .from("build_risk_snapshots")
            .select("generated_at,components")
            .order("generated_at", { ascending: false })
            .limit(1);

        if (error || !data || !data[0]) {
            console.log("[jit-forward-projection] No snapshot available. Will surface at 8:00 run.");
            return;
        }
        const snap = data[0] as any;
        const comps = (snap.components ?? {}) as Record<string, any>;
        const snapshotDate = new Date(snap.generated_at);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayISO = today.toISOString().slice(0, 10);
        const bufferEnd = new Date(today.getTime() + ALERT_BUFFER_DAYS * 86_400_000);
        const bufferISO = bufferEnd.toISOString().slice(0, 10);

        // Collect components whose orderTriggerDate is in [today, today+7]
        const triggers: Array<{
            sku: string;
            riskLevel: string;
            triggerDate: string;
            coverageDays?: number | null;
            vendorName?: string | null;
            stockoutDays?: number | null;
            onHand?: number | null;
            usedIn: string[];
        }> = [];

        for (const [sku, c] of Object.entries(comps)) {
            if (!c || !c.orderTriggerDate) continue;
            const d = c.orderTriggerDate;
            if (d < todayISO) continue;          // already past — no alert
            if (d > bufferISO) continue;         // not within the window yet
            triggers.push({
                sku,
                riskLevel: c.riskLevel,
                triggerDate: d,
                coverageDays: c.coverageDays,
                vendorName: c.vendorName,
                stockoutDays: c.stockoutDays,
                onHand: c.onHand,
                usedIn: Array.isArray(c.usedIn) ? c.usedIn : Object.keys(c.usedIn ?? {}),
            });
        }

        if (triggers.length === 0) {
            console.log("[jit-forward-projection] No JIT triggers in the next 7d — silent.");
            return;
        }

        // Task-first: one agent_task per trigger, then a single summary view.
        triggers.sort((a, b) => a.triggerDate.localeCompare(b.triggerDate));
        const { notifyViaTask } = await import("@/lib/intelligence/notify-via-task");
        for (const t of triggers) {
            await notifyViaTask({
                sourceId: `jit:${t.sku}:${t.triggerDate}`,
                type: "jit_order_trigger",
                goal: `Order ${t.sku} by ${t.triggerDate} — ${t.riskLevel}`,
                inputs: { sku: t.sku, triggerDate: t.triggerDate, vendor: t.vendorName, onHand: t.onHand, usedIn: t.usedIn },
                priority: t.riskLevel === "CRITICAL" ? 0 : 2,
                // KAIZEN #7: removed critical: true — JIT triggers wait for business hours
                summaryLabel: "JIT Forward Projection",
            });
        }
        console.log(`[jit-forward-projection] Routed ${triggers.length} triggers through agent_task hub.`);
    },
    // Budget: reads Supabase once, sends one Telegram — generous default is fine.
    budget: { durationMs: 60_000 },
});

defineJob({
    name: "ap-health-report",
    schedule: "30 8 * * 1-5",
    onFail: "telegram-will",
    description: "Morning AP pipeline health report (Mon-Fri 8:30 AM).",
    handler: async () => {
            const { generateAPHealthReport } = await import("@/lib/intelligence/ap-health-report");
            const { notifyViaTask } = await import("@/lib/intelligence/notify-via-task");
            const report = await generateAPHealthReport();
            const day = new Date().toISOString().slice(0, 10);
            await notifyViaTask({
                sourceId: `ap-health:${day}`,
                type: "cron_summary",
                goal: report,
                inputs: { report, day },
                summaryLabel: "AP Health Report",
            });
            console.log("[ap-health-report] Routed morning report through agent_task hub.");
    },
});

// HERMIA(2026-06-10): Post-run follow-up — quick pipeline check at noon and 4 PM.
// Only sends if there's actual activity or unresolved issues. Keeps Bill in the
// loop without burning tokens on empty reports.
defineJob({
    name: "ap-follow-up",
    schedule: "0 12,16 * * 1-5",
    onFail: "log",
    description: "Midday/afternoon AP pipeline follow-up (Mon-Fri 12 PM & 4 PM).",
    handler: async () => {
        const { createClient } = await import("@/lib/supabase");

        const db = createClient();
        if (!db) return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayIso = today.toISOString();

        // Count today's activity
        const { data: rows } = await db
            .from("ap_activity_log")
            .select("intent, metadata")
            .gte("created_at", todayIso);

        if (!rows || rows.length === 0) {
            console.log("[ap-follow-up] No AP activity today — skipping.");
            return;
        }

        let matched = 0;
        let total = 0;
        const counts: Record<string, number> = {};
        for (const r of rows as any[]) {
            const intent = r.intent || "UNKNOWN";
            counts[intent] = (counts[intent] || 0) + 1;
            if (intent === "BILL_FORWARD" || intent === "INVOICE") {
                total++;
                if (r.metadata?.matched === true || r.metadata?.matched === "true") matched++;
            }
        }

        // Check stuck count
        const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
        const { data: stuckRows } = await db
            .from("ap_inbox_queue")
            .select("message_id, extracted_json")
            .in("status", ["ERROR_FORWARDING", "ERROR_PROCESSING"])
            .lt("updated_at", twoHoursAgo)
            .limit(20);

        let stuck = 0;
        for (const r of (stuckRows || []) as any[]) {
            const ej = r.extracted_json;
            if (ej && typeof ej === "object" && (ej.from || ej.subject || ej.vendor_name)) stuck++;
        }

        const pct = total > 0 ? Math.round((matched / total) * 100) : 100;
        const status = stuck === 0 ? "✅" : stuck < 5 ? "⚠️" : "🔴";

        const lines: string[] = [];
        lines.push(`${status} *AP Check-in*`);
        lines.push(`${total} invoices processed, ${matched} matched (${pct}%)`);
        if (stuck > 0) lines.push(`${stuck} stuck >2h`);

        // Show top intents
        const topIntents = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
        if (topIntents.length > 0) {
            lines.push(topIntents.map(([k, v]) => `${k}: ${v}`).join(" · "));
        }

        const { notifyViaTask } = await import("@/lib/intelligence/notify-via-task");
        const slot = new Date().getHours() < 14 ? "noon" : "afternoon";
        await notifyViaTask({
            sourceId: `ap-follow-up:${todayIso.slice(0, 10)}:${slot}`,
            type: "cron_summary",
            goal: lines.join("\n"),
            inputs: { total, matched, stuck, pct, counts, slot },
            summaryLabel: "AP Check-in",
        });
        console.log(`[ap-follow-up] Routed through agent_task hub: ${total} processed, ${stuck} stuck.`);
    },
});

defineJob({
    name: "daily-summary",
    schedule: "0 8 * * 1-5",
    onFail: "telegram-will",
    description: "Daily PO/invoice/email summary (Mon-Fri 8:00 AM).",
    handler: async () => { await ops()?.sendDailySummary(); },
});

defineJob({
    name: "weekly-summary",
    schedule: "1 8 * * 5",
    onFail: "log",
    description: "Friday weekly Aria-vs-Finale retro.",
    handler: async () => { await ops()?.sendWeeklySummary(); },
});

defineJob({
    name: "nightshift-enqueue",
    schedule: "0 18 * * *",
    onFail: "log",
    description: "6 PM daily: enqueue overnight email classification work. 7-day so Mon mornings aren't cold (weekend ads piled up unfiltered on Mon-Fri schedule).",
    handler: async () => { await ops()?.enqueueNightshiftWork(); },
});

defineJob({
    name: "housekeeping",
    schedule: "0 21 * * *",
    onFail: "log",
    description: "Nightly housekeeping at 9:00 PM.",
    handler: async () => { await ops()?.runHousekeeping(); },
});

// HERMIA(2026-05-28): Hourly → every 6h. pinecone.ts is already a Supabase shim
// writing to email_context_log — this is an audit log, not a real-time index.
// Saves ~120 invocations/day.
defineJob({
    name: "stat-indexing",
    schedule: "5 */6 * * *",
    onFail: "log",
    description: "Every 6h: audit-log operational context to email_context_log.",
    handler: async () => { await ops()?.indexOperationsContext(); },
});

// KAIZEN #4: 30m -> 4h. Vendor PO emails rarely change inside a 6h window;
// the prior 30-min cadence burned Gmail/Supabase quota with no signal gain.
defineJob({
    name: "po-sync",
    schedule: "0 */4 * * *",
    onFail: "log",
    description: "Sync PO conversations with Gmail threads (every 4h).",
    handler: async () => { await ops()?.syncPOConversations(); },
});

defineJob({
    name: "qty-calibration",
    schedule: "30 8 * * *",
    onFail: "escalate-to-supervisor",
    description: "Daily 8:30 AM calibration of recommendations vs received POs.",
    handler: async () => { await ops()?.runQtyCalibration(); },
});

// Politely follow up with vendors who haven't acknowledged a sent PO.
// L1 at sent+2d → L2 at sent+5d → L3 at sent+7d. Dropships excluded.
defineJob({
    name: "po-followup-watcher",
        schedule: "15 8 * * 1-5",  // KAIZEN #7: 7:45 → 8:15 (after business hours start)
        onFail: "telegram-will",
    description: "8:15 AM Mon-Fri: draft polite vendor nudges for quiet POs.",
    handler: async () => {
        const { runPOFollowupWatcher } = await import("@/lib/purchasing/po-followup-watcher");
        const outcomes = await runPOFollowupWatcher();
        const counts = outcomes.reduce<Record<string, number>>((acc, o) => {
            acc[o.action] = (acc[o.action] ?? 0) + 1;
            return acc;
        }, {});
        if (Object.keys(counts).length > 0) {
            console.log(`[po-followup-watcher] outcomes:`, counts);
        }
    },
});

// Detect POs stalled at any pipeline stage. Reads existing tables, no writes.
// Surfaces via /api/dashboard/po-stuck + Telegram digest on cron run.
defineJob({
    name: "po-stuck-detector",
        schedule: "20 8 * * 1-5",  // KAIZEN #7: 7:50 → 8:20 (after business hours start)
        onFail: "telegram-will",
    description: "8:20 AM Mon-Fri: find POs stalled at any stage (acked-no-tracking, delivered-no-receipt, etc). Also drafts vendor follow-up emails for overdue POs (po-overdue-followup).",
    handler: async () => {
        const { detectStuckPOs, summariseStuck } = await import("@/lib/purchasing/po-stuck-detector");
        const rows = await detectStuckPOs();
        const summary = summariseStuck(rows);
        if (summary.total > 0) {
            console.log(`[po-stuck-detector] ${summary.total} stuck:`, summary.byStage);
        }

        // HERMIA(2026-06-09): After detection, run the proactive vendor follow-up.
        // Finds POs past expected receive date with 0 items received, searches
        // Gmail for vendor replies, and drafts polite "where's my stuff?" emails.
        // Telegram summary sent to Bill with status per PO.
        const { runOverdueFollowup } = await import("@/lib/purchasing/po-overdue-followup");
        try {
            await runOverdueFollowup();
        } catch (err: any) {
            console.warn(`[po-stuck-detector] overdue follow-up failed: ${err.message}`);
            throw err;
        }
    },
});

// Scan Gmail for vendor shipping confirmations — extract tracking + POs → shipments table.
// HERMIA(2026-06-09): Closes the "manual tracking insert" gap. Vendor emails a tracking
// number, system auto-detects carrier (including LTL like AAA Cooper), builds tracking URL,
// and writes to shipments table so carrier-poll picks it up for status refresh.
defineJob({
    name: "email-tracking-ingest",
        schedule: "15 */2 * * *",
        onFail: "telegram-will",
    description: "Scan Gmail for vendor shipping confirmations → extract tracking → upsert shipments.",
    handler: async () => {
        const { runEmailTrackingIngest } = await import("@/lib/tracking/email-tracking-ingest");
        await runEmailTrackingIngest();
    },
});

// Refresh carrier status for every active shipment.
defineJob({
    name: "carrier-poll",
    schedule: "0 6,14 * * *", // 6am + 2pm daily — catches afternoon deliveries
    onFail: "telegram-will",
    description: "Refresh live carrier status for active shipments (2x/day).",
    handler: async () => {
        const { pollActiveShipments } = await import("@/lib/purchasing/carrier-poll");
        const outcomes = await pollActiveShipments();
        const counts = outcomes.reduce<Record<string, number>>((acc, o) => {
            acc[o.action] = (acc[o.action] ?? 0) + 1;
            return acc;
        }, {});
        if (Object.keys(counts).length > 0) {
            console.log(`[carrier-poll] outcomes:`, counts);
        }
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// PO Sync — keeps purchase_orders in sync with Finale. Runs every 2h.
// Without this, purchase_orders only has POs sent through Aria's pipeline.
// Invoice→PO matching depends on a complete PO mirror.
// ─────────────────────────────────────────────────────────────────────────────
defineJob({
    name: "po-purchase-sync",
    schedule: "0 */2 * * *",
    onFail: "telegram-will",
    description: "Sync purchase_orders from Finale (every 2h) — foundation for invoice→PO matching.",
    handler: async () => {
        const { syncPurchaseOrders } = await import("@/lib/purchasing/po-sync");
        await syncPurchaseOrders(90);
    },
    budget: { durationMs: 300_000 },
});

// po-sweep removed — KAIZEN #5: folded into ap-polling as a post-pass.
// runPOSweep() remains on OpsManager and is invoked on every ap-polling tick.

// KAIZEN(2026-05-29): Dead reconciler cron entries removed.
// vendor-axiom, vendor-fedex, vendor-teraganix, vendor-uline reconcilers
// have been disabled since 2026-05-28. Bill.com now handles invoice reconciliation
// natively. Manual CLI scripts remain at src/cli/reconcile-{axiom,fedex,teraganix,uline}.ts
// if needed for ad-hoc verification. No automated cron necessary.

defineJob({
    name: "build-completion-watcher",
    schedule: "*/30 8-17 * * 1-5", // every 30m, 8am–5pm weekdays — build team hours only
    onFail: "log",
    description: "Poll Finale for completed production builds (every 30m during business hours).",
    handler: async () => { await ops()?.pollBuildCompletions(); },
});

defineJob({
    name: "po-receiving-watcher",
    schedule: "*/30 8-17 * * 1-5", // every 30m, 8am–5pm weekdays — warehouse hours only
    onFail: "telegram-will",
    description: "Poll Finale for received POs (every 30m during business hours).",
    handler: async () => { await ops()?.pollPOReceivings(); },
});

// KAIZEN(2026-06-01): Post-reconciliation receiving check. When goods arrive
// after an invoice was reconciled, re-checks quantities and alerts if short.
defineJob({
    name: "po-receipt-recheck",
    schedule: "*/30 * * * *",
    onFail: "telegram-will",
    description: "Re-check reconciled invoices against newly received goods (every 30m).",
    handler: async () => {
        const { recheckReconciledInvoices } = await import("@/lib/purchasing/po-receipt-recheck");
        await recheckReconciledInvoices();
    },
});

// HERMIA(2026-05-28): L2/L3 vendor escalation. L2=10-14d (firmer draft),
// L3=15+d (Telegram alert with replace/draft buttons).
defineJob({
    name: "vendor-escalation",
        schedule: "40 8 * * 1-5",
        onFail: "telegram-will",
    description: "L2/L3 escalation for unresponsive vendors (2x/day weekdays).",
    handler: async () => {
        const { runVendorEscalation } = await import("@/lib/purchasing/vendor-escalation");
        const result = await runVendorEscalation();
        if (result.l2Count > 0 || result.l3Count > 0) {
            console.log();
        }
    },
});

// HERMIA(2026-05-28): Delivery exception auto-escalation.
// Finds shipments with exception status, drafts vendor email, alerts Bill.
defineJob({
    name: "delivery-exception-escalator",
    schedule: "0 */4 * * 1-5",
    onFail: "telegram-will",
    description: "Auto-escalate delivery exceptions — draft vendor email + Telegram alert (every 4h weekdays).",
    handler: async () => {
        const { escalateDeliveryExceptions } = await import("@/lib/tracking/delivery-exception-escalator");
        const result = await escalateDeliveryExceptions();
        if (result.escalated.length > 0) {
            console.log(`[delivery-exception-escalator] Escalated ${result.escalated.length} exception(s)`);
        }
    },
});
// HERMIA(2026-05-28): Prompt Bill to confirm receipt of delivered POs.
// Runs 4x/day during business hours. Finds delivered 24-72h ago, not yet
// received in Finale. Sends Telegram with inline buttons.
defineJob({
    name: "delivery-receipt-prompt",
    schedule: "0 9,12,15,17 * * 1-5",  // KAIZEN #7: 18 → 17 (no 6 PM messages)
    onFail: "log",
    description: "Prompt Bill to confirm receipt of delivered POs (4x/day weekdays).",
    handler: async () => {
        const { promptDeliveredReceipts } = await import("@/lib/tracking/delivery-receipt-prompt");
        const result = await promptDeliveredReceipts();
        if (result.prompted > 0) {
            console.log(`[delivery-receipt-prompt] Prompted ${result.prompted} PO(s), ${result.skippedAlreadyPrompted} skipped`);
        }
    },
});

defineJob({
    name: "purchasing-calendar-sync",
    schedule: "0 */4 * * *",
    onFail: "log",
    description: "Sync PO lifecycle to Google Calendar (every 4h).",
    handler: async () => { await ops()?.runPurchasingCalendarSync(); },
});

// KAIZEN #6: Mon-Fri only. Vendor reconciliations don't fire on weekends,
// so this watchdog produced false-alarm Telegram messages every Sat/Sun.
defineJob({
    name: "missing-reconciliation-watchdog",
    schedule: "0 9 * * 1-5",
    onFail: "telegram-will",
    description: "9 AM Mon-Fri: alert if any vendor missed a 24h reconciliation.",
    handler: async () => { await ops()?.checkMissingReconciliationRuns(); },
});

// HERMIA(2026-06-24): 15m → 30m. Task closure is hygiene, not urgent.
// Saves ~96 invocations/day. Supabase free-tier friendliness.
defineJob({
    name: "close-finished-tasks",
    schedule: "*/30 * * * *",
    onFail: "log",
    description: "Hygiene: close completed agent_task rows (every 15m).",
    handler: async () => { await ops()?.runCloseFinishedTasks(); },
});

// HERMIA(2026-05-28): 30m → hourly. Migrations don't drift that fast.
// Saves ~24 invocations/day.
defineJob({
    name: "migration-tripwire",
    schedule: "0 * * * *",
    onFail: "log",
    description: "Self-heal Layer A: tripwire checks (hourly).",
    handler: async () => { await ops()?.runMigrationTripwire(); },
});

// HERMIA(2026-05-28): 10m → 30m. Playbook dispatch rarely has queued work.
// Saves ~96 invocations/day.
defineJob({
    name: "task-self-healer",
    schedule: "*/30 * * * *",
    onFail: "log",
    description: "Self-heal Layer C: dispatch queued playbooks (every 30m).",
    handler: async () => { await ops()?.runTaskSelfHealer(); },
});

// HERMIA(2026-06-24): 15m → 30m. Issue projection rarely finds new work per cycle.
// Saves ~96 invocations/day. Supabase free-tier friendliness.
defineJob({
    name: "issue-projection",
    schedule: "*/30 * * * *",
    onFail: "log",
    description: "Phase 1 issue ledger projection (every 15m).",
    handler: async () => { await ops()?.runIssueProjection(); },
});

// Auto-complete POs that satisfy all eligibility gates AND have settled
// for ≥48h. Default OFF behind PO_AUTO_COMPLETE_ENABLED — dry-runs log
// candidates without writing. Runs every 4h: dwell is 48h, so 4h
// granularity is plenty.
defineJob({
    name: "po-auto-complete-watcher",
    schedule: "0 */4 * * *",
    onFail: "telegram-will",
    description: "Auto-complete eligible POs (every 4h; default OFF via PO_AUTO_COMPLETE_ENABLED).",
    handler: async () => { await ops()?.runPOAutoCompleteWatcher(); },
    budget: { durationMs: 300_000 }, // 5min — fetches getOrderDetails per candidate
});

// Detect open POs at risk of arriving after stockout and surface them as
// PO_ARRIVAL_AT_RISK rows in ap_activity_log. Builds panel + Activity feed
// render them; "Compose ETA draft" and other next-step actions are
// triggered from the Activity row, not pushed via Slack/Gmail.
// Every 2h: arrival ETAs and runway both change slowly, no need for tighter.
defineJob({
    name: "po-arrival-risk-check",
    schedule: "0 */2 * * *",
    onFail: "telegram-will",
    description: "Detect PO arrivals that will land after stockout (every 2h).",
    handler: async () => { await ops()?.runPOArrivalRiskCheck(); },
    budget: { durationMs: 180_000 },
});

// Phase 1 backend agentic flow substrate. Drains flow_events, spawns and
// advances flow_runs. Side-effect imports the flow registry on first tick.
// Gated by FLOWS_ENABLED so a misbehaving runner can be disabled in one env.
// KAIZEN(2026-05-29): 1m → 5m. Flow events rarely need sub-minute latency.
// Saves ~1,152 invocations/day. Gated by FLOWS_ENABLED.
defineJob({
    name: "flows-tick",
    schedule: "*/5 * * * *",
    enabled: (process.env.FLOWS_ENABLED ?? "true").toLowerCase() !== "false",
    onFail: "log",
    description: "Flow runner: drain flow_events, spawn/advance flow_runs (every 5m).",
    handler: async () => {
        const [{ tick }] = await Promise.all([
            import("@/flows/runner"),
            import("@/flows"),
        ]);
        const r = await tick();
        if (r.eventsProcessed > 0 || r.spawned > 0 || r.retried > 0 || r.escalated > 0) {
            console.log(
                `[flows-tick] events=${r.eventsProcessed} spawned=${r.spawned} advanced=${r.advanced} retried=${r.retried} failed=${r.failed} escalated=${r.escalated}`,
            );
        }
    },
});

// HERMIA(2026-06-24): 15m → 30m. Cognitive round rarely needs sub-30-min latency.
// Saves ~96 invocations/day. Supabase free-tier friendliness.
defineJob({
    name: "cognitive-round",
        schedule: "*/30 * * * *",
        onFail: "log",
        description: "Cognitive Round: survey state, decide priorities, log decisions (every 15m).",
        handler: async () => {
            const { runCognitiveRound } = await import("@/lib/intelligence/cognitive-round");
            const decision = await runCognitiveRound();
            // KAIZEN(2026-05-29): Decisions now wired — cron/runner.ts checks
            // isJobSuppressed() before each tick. Suppressed jobs return
            // "cognitive-suppressed" status in run history.
            if (decision.suppress.length > 0 || decision.boost.length > 0) {
                console.log(`[cognitive-round] suppress: ${decision.suppress.join(", ")} | boost: ${decision.boost.join(", ")}`);
            }
            // KAIZEN(2026-06-02): Surface critical decisions via Telegram.
            // KAIZEN #7 (2026-06-12): Downgraded from critical: true to gated.
            // Cognitive decisions are important but not crash-loop emergencies.
            if (decision.priority === "critical") {
                try {
                    const { notifyViaTask } = await import("@/lib/intelligence/notify-via-task");
                    await notifyViaTask({
                        sourceId: `cognitive:${decision.action}`,
                        type: "cognitive_critical",
                        goal: `🚨 Cognitive Round CRITICAL\n${decision.action}\n\n${decision.summary}`,
                        inputs: { action: decision.action, summary: decision.summary },
                        priority: 0,
                        // critical: true removed — waits for business hours
                        summaryLabel: "Cognitive Round CRITICAL",
                    });
                    console.log(`[cognitive-round] Routed critical decision through agent_task hub`);
                } catch (err: any) {
                    console.warn(`[cognitive-round] Hub notify failed (non-fatal): ${err.message}`);
                }
            }
        },
});

// HERMIA(2026-07-15): Log local memory vector stats.
// SQLite is the sole store — no cloud sync needed.
defineJob({
    name: "memory-sync",
    schedule: "0 */6 * * *",
    onFail: "log",
    description: "Log memory vector counts from local SQLite (every 6h).",
    handler: async () => {
        const { logMemoryStats } = await import("@/lib/storage/memory-sync");
        const stats = logMemoryStats();
        console.log(`[memory-sync] ${stats.length} namespaces in SQLite`, stats.map(s => `${s.namespace}: ${s.count}`).join(", "));
    },
});

// HERMIA(2026-07-15): Refresh stale tracking records from carrier APIs.
// Writes to local SQLite cache (tracking-cache.ts) which is the primary store.
// Every 30min for active shipments; stale check at 60min.
defineJob({
    name: "tracking-refresh",
    schedule: "*/30 * * * *",
    onFail: "log",
    description: "Refresh stale tracking numbers from carrier APIs into local cache.",
    handler: async () => {
        const { refreshStaleTrackings, countActiveTrackings } = await import("@/lib/storage/tracking-cache");
        const active = countActiveTrackings();
        console.log(`[tracking-refresh] ${active} active tracking records in cache`);
        const refreshed = await refreshStaleTrackings(60);
        if (refreshed > 0) {
            console.log(`[tracking-refresh] Refreshed ${refreshed} tracking records`);
        }
    },
});

// HERMIA(2026-07-15): Process the unified sync queue (SQLite → PostgREST).
// Runs every 60s. Syncs up to 20 records per tick with exponential backoff.
defineJob({
    name: "sync-queue",
    schedule: "* * * * *",
    onFail: "log",
    description: "Process sync queue: SQLite → PostgREST (every 60s).",
    handler: async () => {
        const { processSyncQueue, getQueueDepth, cleanFailedSyncs } = await import("@/lib/storage/sync-queue");
        const depth = getQueueDepth();
        if (depth > 0) {
            const result = await processSyncQueue(20);
            if (result.processed > 0) {
                console.log(`[sync-queue] Processed ${result.processed} (${result.succeeded} ok, ${result.failed} failed). Queue depth: ${depth}`);
            }
        }
        // Daily cleanup of permanently failed tasks
        const cleaned = cleanFailedSyncs();
        if (cleaned > 0) {
            console.log(`[sync-queue] Cleaned ${cleaned} permanently failed tasks`);
        }
    },
});

// HERMIA(2026-07-15): Sync Finale PO data into local SQLite cache.
// Runs every 15min. Writes to po_cache (SQLite) for sub-ms dashboard queries.
defineJob({
    name: "po-finale-sync",
    schedule: "*/15 * * * *",
    onFail: "log",
    description: "Sync Finale PO data into local SQLite cache (every 15min).",
    handler: async () => {
        const { default: PQueue } = await import("p-queue");
        const { upsertPOCache, getPurchasingCacheStats } = await import("@/lib/storage/purchasing-cache");
        const { FinaleClient } = await import("@/lib/finale/client");
        const { enqueueSync } = await import("@/lib/storage/sync-queue");

        const finale = new FinaleClient();
        const queue = new PQueue({ concurrency: 3 });

        // Fetch recent POs from Finale (last 90 days)
        const recentPOs = await finale.getRecentPurchaseOrders(90, 200);

        if (!recentPOs || recentPOs.length === 0) {
            console.log("[po-finale-sync] No recent POs from Finale");
            return;
        }

        let synced = 0;
        for (const po of recentPOs) {
            queue.add(async () => {
                try {
                    upsertPOCache({
                        po_number: po.orderId || po.po_number,
                        vendor_name: po.supplier || po.vendor_name || "",
                        status: po.status,
                        total_amount: po.total_amount || 0,
                        line_items: JSON.stringify(po.items || po.lineItems || []),
                        lifecycle_state: po.lifecycle_state || null,
                        estimated_eta: po.estimated_delivery_date || po.estimated_eta || null,
                        created_at: po.created_at || po.createdAt || null,
                        updated_at: po.updated_at || po.updatedAt || null,
                    });

                    // Also enqueue for async PostgREST sync
                    await enqueueSync("purchase_orders", po.orderId || po.po_number, "upsert");
                    synced++;
                } catch (err: any) {
                    console.warn(`[po-finale-sync] Failed to sync PO ${po.orderId}: ${err.message}`);
                }
            });
        }

        await queue.onIdle();
        console.log(`[po-finale-sync] Synced ${synced}/${recentPOs.length} POs to local cache`);
    },
});

// HERMIA(2026-06-04): Expire stale AP pending approvals.
// Marks any ap_pending_approvals row still status='pending' past its 24h
// expires_at as 'expired'. Without this the boot loader only skips them
// in-memory — the DB row lingers forever (a 2026-03 Uline approval sat
// 'pending' 2+ months). Daily is plenty; expiry is non-urgent housekeeping.
defineJob({
    name: "expire-stale-approvals",
    schedule: "0 6 * * *",
    onFail: "log",
    description: "Expire AP pending approvals past their 24h window (daily 6 AM).",
    handler: async () => {
        const { expireStaleApprovals } = await import("@/lib/finale/reconciler");
        const expired = await expireStaleApprovals();
        if (expired > 0) {
            console.log(`[expire-stale-approvals] Expired ${expired} stale approval(s)`);
        }
    },
});

// HERMIA(2026-07-15): SQLite housekeeping — prune stale records, vacuum.
// Runs daily at 3AM. Reclaims space from old session archives, task history,
// cognitive rounds, and expired cache entries.
defineJob({
    name: "sqlite-housekeeping",
    schedule: "0 3 * * *",
    onFail: "log",
    description: "Prune stale SQLite records and VACUUM (daily 3 AM).",
    handler: async () => {
        const { pruneStaleRecords, vacuumDb, getDbFileSize } = await import("@/lib/storage/housekeeping");
        const beforeSize = getDbFileSize();
        const result = pruneStaleRecords();
        const totalRows = result.memory_vectors + result.task_history + result.cognitive_rounds
            + result.sync_queue + result.po_cache + result.invoice_cache;

        if (totalRows > 0) {
            const freed = vacuumDb();
            const afterSize = getDbFileSize();
            console.log(`[sqlite-housekeeping] Pruned ${totalRows} rows across 6 tables`);
            console.log(`[sqlite-housekeeping] Before: ${beforeSize.sizeMb} | After: ${afterSize.sizeMb} | Freed: ${freed.freedPages} pages`);
            console.log(`[sqlite-housekeeping] Detail:`, JSON.stringify(result));
        } else {
            console.log(`[sqlite-housekeeping] Nothing to prune. DB size: ${beforeSize.sizeMb}`);
        }
    },
});

// HERMIA(2026-07-15): Daily SQLite backup.
// Runs daily at 4AM. Keeps 7 days of backups.
defineJob({
    name: "sqlite-backup",
    schedule: "0 4 * * *",
    onFail: "log",
    description: "Backup aria-local.db and prune old backups (daily 4 AM).",
    handler: async () => {
        const { createLocalBackup, pruneBackups } = await import("@/lib/storage/housekeeping");
        const backupPath = createLocalBackup();
        const deleted = pruneBackups(7);
        console.log(`[sqlite-backup] Created: ${backupPath} | Removed ${deleted} old backup(s)`);
    },
});

// Gated cron — preserved env flag from inline registration.
// HERMIA(2026-05-28): 5m → 15m. Already gated on ISSUE_ORCHESTRATOR_ENABLED.
// When enabled, 15m is plenty for orchestrating issue remediation cycles.
defineJob({
    name: "issue-orchestrator",
    schedule: "*/15 * * * *",
    enabled: (process.env.ISSUE_ORCHESTRATOR_ENABLED ?? "false").toLowerCase() === "true",
    onFail: "log",
    description: "Issue orchestrator (every 5m, gated by ISSUE_ORCHESTRATOR_ENABLED).",
    handler: async () => { await ops()?.runIssueOrchestrator(); },
});

// ── DRAFTER AGENT: Autonomous PO draft creation ──────────────────────
// HERMIA(2026-06-09): Creates draft POs in Finale for vetted vendors whose
// shortages align with lead times and all commit guards pass. Runs BEFORE
// the autonomy-scan (which picks up the created drafts and sends Telegram
// review notifications). Conservative trust gates: vendor must be on the
// TRUSTED_VENDOR_ALIASES whitelist AND have autonomy_level >= 1 in
// vendor_profiles (human-vetted). Drafts only — never auto-sends.
defineJob({
    name: "drafter-scan",
    schedule: "0 8 * * 1-5", // KAIZEN #7: 7 AM → 8 AM (business hours start)
    onFail: "log",
    description: "Morning PO draft creation for vetted vendors. Runs once daily before arrival to present actionable drafts for review.",
    handler: async () => {
        const { runDrafterAgent, formatDrafterTelegramSummary } = await import("../../lib/purchasing/drafter-agent");
        const result = await runDrafterAgent();

        // Notify on Telegram if any drafts were created (or errors occurred)
        if (result.created > 0 || result.errors > 0) {
            const o = ops();
            if (o?.bot) {
                const chatId = process.env.TELEGRAM_CHAT_ID;
                if (chatId) {
                    try {
                        // The handler inside drafter-agent already gates the send
                        await o.bot.telegram.sendMessage(
                            chatId,
                            formatDrafterTelegramSummary(result),
                        );
                    } catch (err: any) {
                        console.warn(`[drafter-scan] Telegram notification failed: ${err.message}`);
                    }
                }
            }
        }
    },
    budget: { durationMs: 120_000 }, // 2min — Finale intelligence fetch is slow
});

defineJob({
    name: "autonomy-scan",
    schedule: "30 8,13 * * 1-5", // KAIZEN #7: 7:30am → 8:30am + 1:30pm weekdays
    onFail: "log",
    description: "Process draft POs for Level 1 & 2 autonomy (2x/day weekdays).",
    handler: async () => {
        const o = ops();
        if (!o || !o.bot) return;
        const { autoProcessAutonomyDrafts } = await import("../../lib/purchasing/autonomy-engine");
        await autoProcessAutonomyDrafts(o.bot);
    },
});

// ── CORE-04: Follow-up SOP ───────────────────────────────────────────────
// HERMIA(2026-06-04): The legacy followup-sop logic (lib/slack/followup-sop.ts)
// was deleted in the 2026-05 refactor. Its five responsibilities split:
//
//   • PO acknowledgements + reorder nudges  → po-followup-watcher cron
//   • L2/L3 vendor escalation                → vendor-escalation cron
//   • Delivery exception escalation          → delivery-exception-escalator cron
//   • Stale Slack requests >24h unanswered   → stale-request-watcher (this handler)
//   • AP invoices stuck in ERROR_FORWARDING  → email-forwarding-alert (this handler)
//
// The three PO-side crons run on weekday business hours. The two alerts that
// need 24/7 coverage (Slack requests + AP forwarding) run on this cron's
// 2-hour schedule via this handler. Both modules early-return + log when
// there's nothing to surface, so a quiet hour is silent.
//
// The autonomy engine (purchasing-followup worker + comms-master master)
// tracks heartbeat status for this cron via notifyCronOutcome (wired in
// ops-manager.safeRun).
defineJob({
    name: "followup-sop",
    schedule: "0 */2 * * *", // every 2 hours, 24/7
    onFail: "log",
    description: "Follow-up SOP fan-out: stale Slack requests (stale-request-watcher) + AP forwarding alerts (email-forwarding-alert). PO-side work lives in three dedicated crons.",
    handler: async () => {
        // HERMIA(2026-06-04): fan out to the two missing modules. Both
        // early-return + log when there's nothing to report.
        const [{ runStaleRequestWatcher }, { runForwardingEscalation }] = await Promise.all([
            import("@/lib/slack/stale-request-watcher"),
            import("@/lib/intelligence/email-forwarding-alert"),
        ]);
        await Promise.all([runStaleRequestWatcher(), runForwardingEscalation()]);
    },
});

// HERMIA(2026-06-11): Drop-detector — weekly "what got flagged but nothing happened".
// Finds open tasks >24h with no recent activity. Surfaces a single summary report
// via notifyViaTask (drop_detect_report type). One row per week, dedup by date.
defineJob({
    name: "drop-detector",
    schedule: "0 9 * * 5",  // Friday 9 AM — end-of-week surfacing
    onFail: "log",
    description: "Friday 9 AM: surface open tasks flagged >24h with no action (weekly ball-dropped report).",
    handler: async () => {
        const { surfaceDropReport } = await import("@/lib/intelligence/drop-detector");
        await surfaceDropReport();
    },
    budget: { durationMs: 60_000 },
});

// HERMIA(2026-06-11): Pattern miner — weekly closed-loop metrics.
// Aggregates SUCCEEDED/EXPIRED/FAILED tasks from past 7 days, computes
// per-type drop-rate and median time-to-close. Surfaces via notifyViaTask.
defineJob({
    name: "pattern-miner",
    schedule: "0 8 * * 1",  // Monday 8 AM — start-of-week retrospective
    onFail: "log",
    description: "Monday 8 AM: weekly closed-loop task metrics (drop-rate + median time-to-close per type).",
    handler: async () => {
        const { surfacePatternInsight } = await import("@/lib/intelligence/pattern-miner");
        await surfacePatternInsight();
    },
    budget: { durationMs: 120_000 },
});

// HERMIA(2026-06-11): Daily proactive morning brief — synthesized action list
// from across all Aria subsystems (JIT triggers, overdue POs, pending approvals,
// vendor escalations, consumption spikes). If nothing actionable, stays silent.
defineJob({
    name: "proactive-brief",
    schedule: "0 8 * * 1-5",  // KAIZEN #7: 7 AM → 8 AM
    onFail: "telegram-will",
    description: "8 AM Mon-Fri: daily proactive brief — what needs action in the next 48h.",
    handler: async () => {
        const { generateProactiveBrief } = await import("@/lib/intelligence/proactive-brief");
        await generateProactiveBrief();
    },
    budget: { durationMs: 90_000 },
});

// HERMIA(2026-06-15): Daily Slack review — queries recent messages directly
// addressed to Bill (DMs + @Bill mentions) and sends a short summary via TG.
// Only fires if there are open items to review. No news = silence.
defineJob({
    name: "daily-slack-review",
    schedule: "30 7 * * 1-5", // 7:30 AM weekdays
    onFail: "log",
    description: "7:30 AM Mon-Fri: daily Slack review of addressed messages (DM/@Bill) — unresponded count + SKUs.",
    handler: async () => {
        const { getAddressedRequests, formatAddressedReview } =
            await import("@/lib/slack/addressed-message-watcher");
        const { sendTelegramNotify } = await import(
            "@/lib/intelligence/telegram-notify"
        );
        const report = await getAddressedRequests(24);
        const msg = formatAddressedReview(report);
        if (msg) {
            await sendTelegramNotify(msg);
        } else {
            console.log(
                "[daily-slack-review] No addressed messages in last 24h — silent.",
            );
        }
    },
    budget: { durationMs: 30_000 },
});

//HERMIA(2026-06-11): Stockout driver — proactive countdown that creates drafts
// and presents one-tap-send. Runs 3x/day during business hours.
defineJob({
    name: "stockout-driver",
    schedule: "0 8,11,15 * * 1-5",  // KAIZEN #7: 7am → 8am, 11am, 3pm weekdays
    onFail: "telegram-will",
    description: "3x/day: compute margin-to-zero per SKU, create draft POs, present actionable countdown.",
    handler: async () => {
        const { runStockoutDriver } = await import("@/lib/purchasing/stockout-driver");
        const result = await runStockoutDriver();
        if (result.candidates > 0) {
            console.log(`[stockout-driver] ${result.candidates} candidates, ${result.draftsCreated} drafts created, ${result.draftsExisting} existing.`);
        }
    },
    budget: { durationMs: 120_000 },
});

// HERMIA(2026-07-13): Slack detector retired — token_revoked / non-functional.
// Job kept registered as a silent no-op so existing schedules/history don't
// look "missing"; no Telegram noise, no DB probes.
defineJob({
    name: "slack-detector-heartbeat",
    schedule: "0 0 1 1 *", // effectively never (Jan 1 midnight)
    onFail: "log",
    description: "RETIRED 2026-07-13 — Slack request detector disabled (token_revoked).",
    handler: async () => {
        // no-op
    },
    budget: { durationMs: 5_000 },
});

// HERMIA(2026-06-11): System heartbeat — proactive liveness probes for every
// critical Aria dependency, process, and scheduled job. Runs every 10 min and
// sends a single consolidated Telegram alert only when something is newly
// unhealthy (rate-limited 30 min per probe). All-healthy ticks stay silent.
defineJob({
    name: "system-heartbeat",
    schedule: "*/10 * * * *",
    onFail: "log",  // Don't escalate cron framework failures for the heartbeat itself
    description: "Proactive liveness probes for all critical Aria systems (every 10 min).",
    budget: { durationMs: 30_000 },  // 30s total — probes should complete well under this
    handler: async () => {
        const { runSystemHeartbeat } = await import("@/lib/ops/heartbeat");
        await runSystemHeartbeat();
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Monday Briefing Cron (new 2026-06-15)
// Runs only on Mondays at 8:00 AM MDT. Sends formatted email to Bill.
// ─────────────────────────────────────────────────────────────────────────────
defineJob({
    name: "monday-briefing",
    schedule: "0 8 * * 1",  // Monday 8:00 AM
    onFail: "telegram-will",
    description: "Monday morning status overview: last-week purchases, upcoming needs, Slack SKU status, industry pulse. Emails bill.selee@buildasoil.com.",
    handler: async () => {
        const { generateAndSendMondayBriefing } = await import(
            "@/lib/intelligence/monday-briefing"
        );
        await generateAndSendMondayBriefing();
    },
    budget: { durationMs: 120_000 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Scans Watcher — CR/CRMIN & Benny scan processing (added 2026-06-16)
// CR_ / CRMIN_ → DM Parker the PDF with PU100 stock-on-order info.
// Benny_ → Email PDF to buildasoilap@bill.com.
// Runs every 6 hours during business hours (M-F 7AM-6PM MT).
// ─────────────────────────────────────────────────────────────────────────────
defineJob({
    name: "scans-watcher",
    schedule: "0 */6 * * 1-5", // M-F only — no weekends
    onFail: "log",
    description: "Check _FREIGHT/Documents/Scans/ for new CR Minerals Pumice invoices (DM Parker with PDF + stock info) or Benny invoices (email to Bill.com).",
    handler: async () => {
        // Business hours gate: skip if outside 7AM-6PM MT
        const now = new Date();
        const hourMT = new Date(
            now.toLocaleString("en-US", { timeZone: "America/Denver" })
        ).getHours();
        if (hourMT < 7 || hourMT >= 18) {
            console.log(`[scans-watcher] Outside business hours (${hourMT} MT) — skipping.`);
            return;
        }

        const { runScansWatch } = await import("@/lib/scans-watcher");
        const result = await runScansWatch();
        if (result.scanned > 0 || result.errors > 0) {
            console.log(`[scans-watcher] ${result.scanned} scanned, ${result.processed} processed, ${result.slackNotifications} Slack, ${result.emailForwards} email, ${result.errors} errors`);
            for (const d of result.details) console.log(`  ${d}`);
        }
    },
    budget: { durationMs: 60_000 },
});

// ─────────────────────────────────────────────────────────────────────────────
// PO Reply Watcher — checks Gmail threads for vendor replies to sent POs.
// Runs every 30 min during business hours. When a vendor replies, updates
// purchase_orders (vendor_acknowledged_at, human_reply_detected_at) and
// transitions lifecycle to ACKNOWLEDGED. No LLM calls, Gmail API only.
// ─────────────────────────────────────────────────────────────────────────────
defineJob({
    name: "po-reply-watcher",
    schedule: "*/30 7-18 * * 1-5",
    onFail: "log",
    description: "Watch Gmail threads for vendor replies to sent POs (30min, M-F 7AM-6PM MT).",
    handler: async () => {
        const { runPOReplyWatcher } = await import("@/lib/purchasing/po-reply-watcher");
        const detections = await runPOReplyWatcher();
        if (detections.length > 0) {
            console.log(
                `[po-reply-watcher] ${detections.length} vendor reply(s) detected: ` +
                detections.map(d => `${d.poNumber} (${d.vendorName})`).join(", ")
            );
        }
    },
    budget: { durationMs: 90_000 },
    });

// HERMIA(2026-07-01): Post acknowledged POs with tracking numbers to Slack.
// Runs after po-reply-watcher has had a chance to detect vendor replies (which
// runs at :00 and :30). Posts ETA to #purchase-orders in Bill's format:
// *Ordered <link|PO-####> ETA mm/dd*
defineJob({
    name: "post-eta-to-slack",
    schedule: "45 8-18 * * 1-5",  // :45 past each hour, Mon-Fri 8AM-6PM
    onFail: "log",
    description: "Post acknowledged POs with tracking numbers to #purchase-orders with ETA (45min past hour, M-F 8AM-6PM MT).",
    handler: async () => {
        const { postETAtoSlack } = await import("@/cli/post-eta-to-slack");
        const { posted, results } = await postETAtoSlack();
        const errors = results.filter(r => r.action === "error").length;
        if (posted > 0 || errors > 0) {
            console.log(`[post-eta-to-slack] ${posted} posted, ${results.filter(r => r.action === "skipped_no_eta").length} skipped (no ETA), ${errors} errors`);
        }
    },
    budget: { durationMs: 60_000 },
});

    // ─────────────────────────────────────────────────────────────────────────────
    // Reconciliation Auto-Apply Watcher — automatically applies auto_approve/
    // no_change reconciliation results to Finale POs. Gated by the same
    // PO_AUTO_COMPLETE_ENABLED env var as po-auto-complete (dry-runs when disabled).
    // Runs once per hour at :15 — reconciliation events aren't that frequent.
    // ─────────────────────────────────────────────────────────────────────────────
    defineJob({
        name: "reconciliation-auto-apply",
        schedule: "15 * * * *",
        onFail: "telegram-will",
        description: "Auto-apply auto_approve/no_change reconciliation results to Finale POs (hourly at :15).",
        handler: async () => {
            const { runReconciliationAutoApply } = await import(
                "@/lib/purchasing/reconciliation-auto-apply"
            );
            const stats = await runReconciliationAutoApply();
            if (stats.scanned > 0 || stats.applied > 0 || stats.errors > 0) {
                console.log(
                    `[reconciliation-auto-apply] scanned=${stats.scanned}, ` +
                        `applied=${stats.applied}, alreadyApplied=${stats.alreadyApplied}, ` +
                        `errors=${stats.errors}, dryRun=${stats.dryRun}`,
                );
            }
        },
        budget: { durationMs: 60_000 },
            });

            // ─────────────────────────────────────────────────────────────────────────────
            // Vendor Qty Discrepancy Handler — auto-email vendors when reconciliation
            // detects a short shipment qty discrepancy, monitor for reply, escalate after 7d.
            // ─────────────────────────────────────────────────────────────────────────────
            defineJob({
                name: "vendor-qty-discrepancy",
                schedule: "*/30 8-17 * * 1-5",  // every 30 min during business hours
                onFail: "telegram-will",
                description:
                    "Handle qty discrepancies between invoice and received qty — email vendor, detect replies, escalate after 7d.",
                handler: async () => {
                    const { runVendorQtyDiscrepancyHandler } = await import(
                        "@/lib/purchasing/vendor-qty-discrepancy"
                    );
                    const stats = await runVendorQtyDiscrepancyHandler();
                    if (
                        stats.scanned > 0 ||
                        stats.emailed > 0 ||
                        stats.resolved > 0
                    ) {
                        console.log(
                            `[vendor-qty-discrepancy] scanned=${stats.scanned}, emailed=${stats.emailed}, resolved=${stats.resolved}, errors=${stats.errors}`,
                        );
                    }
                },
                budget: { durationMs: 90_000 },
            });

            // ─────────────────────────────────────────────────────────────────────────────
            // Vendor Lead Time Tracker — nightly 10 PM
            // 4-layer pipeline: persist observed P50/P90, detect drift alerts,
            // auto-update policy overrides (opt-in), cross-validate BAS Auto data.
            // Only sends consolidated Telegram report when there's something to say.
            // ─────────────────────────────────────────────────────────────────────────────
            defineJob({
                name: "vendor-lead-time-tracker",
                schedule: "0 22 * * *",
                onFail: "telegram-will",
                description: "Nightly vendor lead-time tracking (4 layers): persist stats, drift alerts, auto-update overrides, BAS cross-validation. 10 PM.",
                handler: async () => {
                    const { runLeadTimeTracker } = await import("@/lib/purchasing/lead-time-tracker");
                    const result = await runLeadTimeTracker();
                    console.log(
                        `[vendor-lead-time-tracker] persisted=${result.statsPersisted}, ` +
                        `drifts=${result.driftAlerts.length}, autoUpdates=${result.autoUpdates.length}, ` +
                        `basMismatches=${result.basCrossValidations.length}, errors=${result.errors.length}`
                    );
                },
                budget: { durationMs: 120_000 },
            });

            // ─────────────────────────────────────────────────────────────────────────────
            // AP Email Watcher — DISABLED 2026-06-18 (Hermia review)
    // This job ran `run-ap-pipeline.ts` (a MANUAL diagnostic script) every 15 min.
// That script has NO dedup: it finds the most-recent invoice PDF in Gmail and
// forwards it to buildasoilap@bill.com on EVERY run — re-forwarding the same
// invoice repeatedly (the "Fwd: Fwd: Fwd: Fwd:" chains in the Sent folder).
// It also competed with the production `ap-polling` cron (which has 3 dedup
// layers in ap-identifier.ts: message_id, cross-inbox, PDF content hash).
//
// ─────────────────────────────────────────────────────────────────────────────

// HERMIA(2026-07-01): Weekly bill.com reference data refresh.
// Step 1: Download AllBillsPage.csv from bill.com (via Playwright + running Chrome
// or saved cookie profile). If Chrome is unavailable (e.g. weekend server), logs
// a warning and re-imports the last downloaded CSV instead.
// Step 2: Import the CSV into SQLite billcom_bills_ref table.
// Runs Sunday 7 AM — before business hours but after any weekend batch.
defineJob({
    name: "billcom-ref-import",
    schedule: "0 7 * * 0",  // Sunday 7 AM
    onFail: "log",
    description: "Sunday 7 AM: download bill.com CSV then import into SQLite billcom_bills_ref.",
    handler: async () => {
        try {
            // Step 1: Download CSV from bill.com (--cron = non-fatal if Chrome unavailable)
            const { main: downloadBillComRef } = await import("@/cli/download-billcom-ref");
            await downloadBillComRef();
        } catch (err: any) {
            console.warn(`[billcom-ref-import] Download step warning: ${err?.message ?? err}`);
            console.warn("[billcom-ref-import] Proceeding with import of existing CSV...");
        }

        try {
            // Step 2: Import existing CSV into SQLite
            const { main: importBillComRef } = await import("@/cli/import-billcom-ref");
            await importBillComRef();
        } catch (err: any) {
            console.error(`[billcom-ref-import] Import step failed: ${err?.message ?? err}`);
        }

        // Step 3: Clean up old ap_activity_log entries (keep 90 days)
        try {
            const { createClient } = await import("@/lib/supabase");
            const db = createClient();
            if (db) {
                const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
                const { data, error } = await db
                    .from("ap_activity_log")
                    .delete()
                    .lt("created_at", cutoff);
                if (error) {
                    console.warn(`[billcom-ref-import] Log cleanup warning: ${error.message}`);
                } else {
                    const count = typeof data === 'number' ? data : (Array.isArray(data) ? data.length : 0);
                    console.log(`[billcom-ref-import] Log cleanup: removed entries older than 90 days`);
                }
            }
        } catch (err: any) {
            console.warn(`[billcom-ref-import] Log cleanup skipped: ${err?.message ?? err}`);
        }
    },
    budget: { durationMs: 120_000 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Invoice → PO Auto-Matcher — finds unmatched invoices and suggests PO matches.
// Runs every 30 min. Auto-applies matches scoring ≥80 with exactly one candidate.
// Lower-confidence matches queue for human review in the receivings panel.
// ─────────────────────────────────────────────────────────────────────────────
defineJob({
    name: "invoice-po-auto-match",
    schedule: "*/30 * * * *",
    onFail: "telegram-will",
    description: "Auto-match unmatched vendor invoices to purchase orders (every 30m).",
    handler: async () => {
        const { batchMatchUnmatchedInvoices } = await import(
            "@/lib/purchasing/invoice-po-matcher"
        );
        const result = await batchMatchUnmatchedInvoices();
        if (result.autoMatched.length > 0 || result.needsReview.length > 0) {
            console.log(
                `[invoice-po-auto-match] auto-matched=${result.autoMatched.length}, ` +
                `needs-review=${result.needsReview.length}`
            );
        }
    },
    budget: { durationMs: 120_000 },
});

