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
 */

import { defineJob } from "../registry";
import { OpsManager } from "../../lib/intelligence/ops-manager";

const ops = () => OpsManager.singleton;

defineJob({
    name: "ap-polling",
    schedule: "*/15 * * * *",
    onFail: "log",
    description: "Poll ap@buildasoil.com for new invoices, then PO-sweep post-pass.",
    handler: async () => {
        const o = ops();
        if (!o) return;
        await o.pollAPInbox();
        // KAIZEN #5: po-sweep folded into ap-polling. Was its own */4h cron;
        // now runs as a post-pass on every ap-polling tick to share the inbox
        // walk with classification + forwarding. The ~3-4x more frequent run
        // is fine — po-sweep is mostly a no-op when there's nothing to match.
        try { await o.runPOSweep(); } catch (err: any) {
            console.warn(`[ap-polling] post-pass po-sweep failed: ${err?.message ?? err}`);
        }
    },
    budget: { durationMs: 180_000 },  // bumped from default to cover the post-pass
});

defineJob({
    name: "build-risk",
    schedule: "30 7 * * 1-5",
    onFail: "telegram-will",
    description: "Daily build risk analysis (Mon-Fri 7:30 AM).",
    handler: async () => { await ops()?.runDailyBuildRisk(); },
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
    schedule: "0 18 * * 1-5",
    onFail: "log",
    description: "6 PM Mon-Fri: enqueue overnight email classification work.",
    handler: async () => { await ops()?.enqueueNightshiftWork(); },
});

defineJob({
    name: "housekeeping",
    schedule: "0 21 * * *",
    onFail: "log",
    description: "Nightly housekeeping at 9:00 PM.",
    handler: async () => { await ops()?.runHousekeeping(); },
});

defineJob({
    name: "stat-indexing",
    schedule: "5 * * * *",
    onFail: "log",
    description: "Hourly Pinecone indexing of operational context.",
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
// L1 at sent+5d → L2 at L1+7d → mark NONCOMM at L2+7d. Dropships excluded.
defineJob({
    name: "po-followup-watcher",
    schedule: "45 7 * * 1-5",
    onFail: "log",
    description: "7:45 AM Mon-Fri: draft polite vendor nudges for quiet POs.",
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
    schedule: "50 7 * * 1-5",
    onFail: "log",
    description: "7:50 AM Mon-Fri: find POs stalled at any stage (acked-no-tracking, delivered-no-receipt, etc).",
    handler: async () => {
        const { detectStuckPOs, summariseStuck } = await import("@/lib/purchasing/po-stuck-detector");
        const rows = await detectStuckPOs();
        const summary = summariseStuck(rows);
        if (summary.total > 0) {
            console.log(`[po-stuck-detector] ${summary.total} stuck:`, summary.byStage);
        }
    },
});

// Refresh carrier status for every active shipment.
defineJob({
    name: "carrier-poll",
    schedule: "0 6 * * *",
    onFail: "log",
    description: "6 AM daily: refresh live carrier status for active shipments.",
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

// po-sweep removed — KAIZEN #5: folded into ap-polling as a post-pass.
// runPOSweep() remains on OpsManager and is invoked on every ap-polling tick.

defineJob({
    name: "reconcile-axiom",
    schedule: "0 1 * * 1-5",
    onFail: "log",
    description: "Axiom Print vendor reconciliation (1:00 AM Mon-Fri).",
    handler: async () => { await ops()?.runReconcileAxiom(); },
});

defineJob({
    name: "reconcile-fedex",
    schedule: "30 1 * * 1-5",
    onFail: "log",
    description: "FedEx vendor reconciliation (1:30 AM Mon-Fri).",
    handler: async () => { await ops()?.runReconcileFedEx(); },
});

defineJob({
    name: "reconcile-teraganix",
    schedule: "0 2 * * 1-5",
    onFail: "log",
    description: "TeraGanix vendor reconciliation (2:00 AM Mon-Fri).",
    handler: async () => { await ops()?.runReconcileTeraGanix(); },
});

defineJob({
    name: "reconcile-uline",
    schedule: "0 3 * * 1-5",
    onFail: "log",
    description: "ULINE vendor reconciliation (3:00 AM Mon-Fri).",
    handler: async () => { await ops()?.runReconcileULINE(); },
});

defineJob({
    name: "build-completion-watcher",
    schedule: "*/30 * * * *",
    onFail: "log",
    description: "Poll Finale for completed production builds (every 30m).",
    handler: async () => { await ops()?.pollBuildCompletions(); },
});

defineJob({
    name: "po-receiving-watcher",
    schedule: "*/30 * * * *",
    onFail: "log",
    description: "Poll Finale for received POs (every 30m).",
    handler: async () => { await ops()?.pollPOReceivings(); },
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

defineJob({
    name: "close-finished-tasks",
    schedule: "*/5 * * * *",
    onFail: "log",
    description: "Hygiene: close completed agent_task rows (every 5m).",
    handler: async () => { await ops()?.runCloseFinishedTasks(); },
});

defineJob({
    name: "migration-tripwire",
    schedule: "*/30 * * * *",
    onFail: "log",
    description: "Self-heal Layer A: tripwire checks (every 30m).",
    handler: async () => { await ops()?.runMigrationTripwire(); },
});

defineJob({
    name: "task-self-healer",
    schedule: "*/10 * * * *",
    onFail: "log",
    description: "Self-heal Layer C: dispatch queued playbooks (every 10m).",
    handler: async () => { await ops()?.runTaskSelfHealer(); },
});

defineJob({
    name: "issue-projection",
    schedule: "*/5 * * * *",
    onFail: "log",
    description: "Phase 1 issue ledger projection (every 5m).",
    handler: async () => { await ops()?.runIssueProjection(); },
});

// Detect open POs at risk of arriving after stockout and surface them as
// PO_ARRIVAL_AT_RISK rows in ap_activity_log. Builds panel + Activity feed
// render them; "Compose ETA draft" and other next-step actions are
// triggered from the Activity row, not pushed via Slack/Gmail.
// Every 2h: arrival ETAs and runway both change slowly, no need for tighter.
defineJob({
    name: "po-arrival-risk-check",
    schedule: "0 */2 * * *",
    onFail: "log",
    description: "Detect PO arrivals that will land after stockout (every 2h).",
    handler: async () => { await ops()?.runPOArrivalRiskCheck(); },
    budget: { durationMs: 180_000 },
});

// Phase 1 backend agentic flow substrate. Drains flow_events, spawns and
// advances flow_runs. Side-effect imports the flow registry on first tick.
// Gated by FLOWS_ENABLED so a misbehaving runner can be disabled in one env.
defineJob({
    name: "flows-tick",
    schedule: "* * * * *",
    enabled: (process.env.FLOWS_ENABLED ?? "true").toLowerCase() !== "false",
    onFail: "log",
    description: "Flow runner: drain flow_events, spawn/advance flow_runs (every 1m).",
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

// Gated cron — preserved env flag from inline registration.
defineJob({
    name: "issue-orchestrator",
    schedule: "*/5 * * * *",
    enabled: (process.env.ISSUE_ORCHESTRATOR_ENABLED ?? "false").toLowerCase() === "true",
    onFail: "log",
    description: "Issue orchestrator (every 5m, gated by ISSUE_ORCHESTRATOR_ENABLED).",
    handler: async () => { await ops()?.runIssueOrchestrator(); },
});
