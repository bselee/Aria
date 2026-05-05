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
    description: "Poll ap@buildasoil.com for new invoices.",
    handler: async () => { await ops()?.pollAPInbox(); },
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

defineJob({
    name: "po-sweep",
    schedule: "30 */4 * * *",
    onFail: "log",
    description: "PO-first AP sweep every 4 hours.",
    handler: async () => { await ops()?.runPOSweep(); },
});

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

// Gated cron — preserved env flag from inline registration.
defineJob({
    name: "issue-orchestrator",
    schedule: "*/5 * * * *",
    enabled: (process.env.ISSUE_ORCHESTRATOR_ENABLED ?? "false").toLowerCase() === "true",
    onFail: "log",
    description: "Issue orchestrator (every 5m, gated by ISSUE_ORCHESTRATOR_ENABLED).",
    handler: async () => { await ops()?.runIssueOrchestrator(); },
});
