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

// HERMIA(2026-05-28): Vendor reconcilers disabled. Bill.com handles invoices
// natively — vendor-specific scraping/reconciliation is unnecessary complexity.
// CLI scripts remain available for manual runs if needed.
// defineJob({
//     name: "reconcile-axiom",
//     schedule: "0 1 * * 1-5",
//     onFail: "log",
//     description: "Axiom Print vendor reconciliation (1:00 AM Mon-Fri).",
//     handler: async () => { await ops()?.runReconcileAxiom(); },
// });

// defineJob({
//     name: "reconcile-fedex",
//     schedule: "30 1 * * 1-5",
//     onFail: "log",
//     description: "FedEx vendor reconciliation (1:30 AM Mon-Fri).",
//     handler: async () => { await ops()?.runReconcileFedEx(); },
// });

// defineJob({
//     name: "reconcile-teraganix",
//     schedule: "0 2 * * 1-5",
//     onFail: "log",
//     description: "TeraGanix vendor reconciliation (2:00 AM Mon-Fri).",
//     handler: async () => { await ops()?.runReconcileTeraGanix(); },
// });

// defineJob({
//     name: "reconcile-uline",
//     schedule: "0 3 * * 1-5",
//     onFail: "log",
//     description: "ULINE vendor reconciliation (3:00 AM Mon-Fri).",
//     handler: async () => { await ops()?.runReconcileULINE(); },
// });

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

// HERMIA(2026-05-28): Prompt Bill to confirm receipt of delivered POs.
// Runs 4x/day during business hours. Finds delivered 24-72h ago, not yet
// received in Finale. Sends Telegram with inline buttons.
defineJob({
    name: "delivery-receipt-prompt",
    schedule: "0 9,12,15,18 * * 1-5",
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

// HERMIA(2026-05-28): 5m → 15m. Task closure is hygiene, not urgent.
// Saves ~192 invocations/day.
defineJob({
    name: "close-finished-tasks",
    schedule: "*/15 * * * *",
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

// HERMIA(2026-05-28): 5m → 15m. Issue projection rarely finds new work per cycle.
// Saves ~192 invocations/day.
defineJob({
    name: "issue-projection",
    schedule: "*/15 * * * *",
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
    onFail: "log",
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

// HERMIA(2026-05-28): Cognitive Round — the "soul" of Aria.
// Surveys all state, makes priority decisions, logs to SQLite.
// Runs every 15 min, right before ap-polling.
defineJob({
    name: "cognitive-round",
    schedule: "*/15 * * * *",
    onFail: "log",
    description: "Cognitive Round: survey state, decide priorities, log decisions (every 15m).",
    handler: async () => {
        const { runCognitiveRound } = await import("@/lib/intelligence/cognitive-round");
        const decision = await runCognitiveRound();
        // Future: wire decision.suppress/boost into cron runner
        // so suppressed jobs skip their next tick after this round
        if (decision.suppress.length > 0 || decision.boost.length > 0) {
            console.log(`[cognitive-round] suppress: ${decision.suppress.join(", ")} | boost: ${decision.boost.join(", ")}`);
        }
    },
});

// HERMIA(2026-05-28): Memory hot/cold tier sync.
// Pushes local SQLite vectors to Supabase backup every 6h.
// Protects against aria-local.db loss/corruption.
defineJob({
    name: "memory-sync",
    schedule: "0 */6 * * *",
    onFail: "log",
    description: "Sync local memory vectors to Supabase backup (every 6h).",
    handler: async () => {
        const { syncMemoryToSupabase } = await import("@/lib/storage/memory-sync");
        const result = await syncMemoryToSupabase();
        if (result.synced > 0) {
            console.log(`[memory-sync] Synced ${result.synced} vectors across ${result.namespaces} namespaces`);
        }
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

defineJob({
    name: "autonomy-scan",
    schedule: "*/10 * * * *", // every 10 minutes
    onFail: "log",
    description: "Scan for draft POs and process Level 1 & Level 2 vendor autonomy actions.",
    handler: async () => {
        const o = ops();
        if (!o || !o.bot) return;
        const { autoProcessAutonomyDrafts } = await import("../../lib/purchasing/autonomy-engine");
        await autoProcessAutonomyDrafts(o.bot);
    },
});

// ── CORE-04: Follow-up SOP ───────────────────────────────────────────────
// Checks for stale Slack requests (>24h unanswered) and vendor POs (>48h
// without confirmation). Nudges Bill via Telegram. Runs every 2 hours.
// Slack requests are marked last_nudge_at to avoid re-nudging within 24h.
defineJob({
    name: "followup-sop",
    schedule: "0 */2 * * *", // every 2 hours
    onFail: "log",
    description: "Follow-up SOP: nudge Bill for unanswered Slack requests or unconfirmed vendor POs.",
    handler: async () => {
        const { runFollowUpSOP } = await import("../../lib/slack/followup-sop");
        await runFollowUpSOP();
    },
});
