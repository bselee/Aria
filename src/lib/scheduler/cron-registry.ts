/**
 * @file    cron-registry.ts
 * @purpose Centralized registry of all ARIA scheduled tasks. Provides typed
 *          definitions with human-readable descriptions, schedule expressions,
 *          and runtime status tracking. Single source of truth for "what does
 *          ARIA do, and when does it do it?"
 *
 *          Consumed by:
 *            - /crons Telegram command (human-readable status)
 *            - Dashboard (runtime monitoring)
 *            - safeRun() in ops-manager.ts (execution tracking)
 * @author  Will / Antigravity
 * @created 2026-03-19
 * @updated 2026-03-19
 * @deps    none (pure data structure + helpers)
 */

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export type CronCategory =
    | 'email'
    | 'tracking'
    | 'purchasing'
    | 'reporting'
    | 'reconciliation'
    | 'manufacturing'
    | 'kaizen'
    | 'maintenance';

export interface CronJobDefinition {
    /** Machine-readable identifier (matches safeRun task name) */
    name: string;
    /** Human-readable description of what this job does */
    description: string;
    /** Cron expression (5-field format) */
    schedule: string;
    /** Human-readable schedule, e.g. "Every 5 minutes" */
    scheduleHuman: string;
    /** Timezone if cron uses one (e.g. "America/Denver") */
    timezone?: string;
    /** Functional category for grouping */
    category: CronCategory;
    /** Whether this job only runs on weekdays (M-F) */
    weekdaysOnly: boolean;
}

export interface CronRunStatus {
    lastRun: Date;
    durationMs: number;
    status: 'success' | 'error';
    error?: string;
}

// ──────────────────────────────────────────────────
// JOB DEFINITIONS (single source of truth)
// ──────────────────────────────────────────────────

/**
 * Complete registry of all ARIA cron jobs.
 * Every cron.schedule() in ops-manager.ts MUST have a corresponding entry here.
 */
export const CRON_JOBS: CronJobDefinition[] = [
    // ── EMAIL ─────────────────────────────────────
    {
        name: 'Supervisor',
        description: 'Checks ops_agent_exceptions queue and escalates unresolved errors',
        schedule: '*/5 * * * *',
        scheduleHuman: 'Every 5 minutes',
        category: 'maintenance',
        weekdaysOnly: false,
    },
    {
        name: 'EmailIngestionDefault',
        description: 'Ingests raw emails from default Gmail inbox to Supabase queue',
        schedule: '*/5 * * * *',
        scheduleHuman: 'Every 5 minutes',
        category: 'email',
        weekdaysOnly: false,
    },
    {
        name: 'EmailIngestionAP',
        description: 'Ingests AP-inbox emails (invoices, statements) to Supabase queue',
        schedule: '0 8,14 * * 1-5',
        scheduleHuman: '8 AM & 2 PM weekdays',
        timezone: 'America/Denver',
        category: 'email',
        weekdaysOnly: true,
    },
    {
        name: 'APIdentifierAgent',
        description: 'Scans for unread invoice PDFs and queues them for classification',
        schedule: '*/15 * * * *',
        scheduleHuman: 'Every 15 minutes',
        category: 'email',
        weekdaysOnly: false,
    },
    {
        name: 'APForwarderAgent',
        description: 'Forwards classified invoices to Bill.com for payment processing',
        schedule: '2-59/15 * * * *',
        scheduleHuman: 'Every 15 minutes (offset by 2 min)',
        category: 'email',
        weekdaysOnly: false,
    },
    {
        name: 'AcknowledgementAgent',
        description: 'Auto-replies to vendor emails with professional acknowledgement',
        schedule: '*/12 * * * *',
        scheduleHuman: 'Every 12 minutes',
        category: 'email',
        weekdaysOnly: false,
    },
    {
        name: 'AdMaintenance',
        description: 'Labels and archives promotional/advertisement emails',
        schedule: '0 * * * *',
        scheduleHuman: 'Every hour',
        category: 'email',
        weekdaysOnly: false,
    },

    // ── TRACKING ──────────────────────────────────
    {
        name: 'TrackingAgent',
        description: 'Parses shipping confirmation emails and extracts tracking numbers',
        schedule: '0 * * * *',
        scheduleHuman: 'Every hour',
        category: 'tracking',
        weekdaysOnly: false,
    },
    {
        name: 'SlackETASync',
        description: 'Updates Slack threads with live tracking ETAs for open shipments',
        schedule: '0 */2 * * *',
        scheduleHuman: 'Every 2 hours',
        category: 'tracking',
        weekdaysOnly: false,
    },

    // ── PURCHASING ────────────────────────────────
    {
        name: 'POSync',
        description: 'Syncs PO conversation threads and vendor email context',
        schedule: '*/30 * * * *',
        scheduleHuman: 'Every 30 minutes',
        category: 'purchasing',
        weekdaysOnly: false,
    },
    {
        name: 'POSweep',
        description: 'Backfill sweep matching unmatched invoices to POs',
        schedule: '30 */4 * * *',
        scheduleHuman: 'Every 4 hours (offset by 30 min)',
        category: 'purchasing',
        weekdaysOnly: false,
    },
    {
        name: 'AxiomDemandScan',
        description: 'Scans Axiom label demand and adds to reorder queue',
        schedule: '15 8 * * 1-5',
        scheduleHuman: '8:15 AM weekdays',
        timezone: 'America/Denver',
        category: 'purchasing',
        weekdaysOnly: true,
    },
    {
        name: 'UlineFridayOrder',
        description: 'Auto-generates ULINE reorder: creates Finale PO + fills QuickOrder cart',
        schedule: '30 8 * * 5',
        scheduleHuman: '8:30 AM Fridays',
        timezone: 'America/Denver',
        category: 'purchasing',
        weekdaysOnly: true,
    },
    {
        name: 'StaleDraftPOAlert',
        description: 'Alerts when draft POs sit uncommitted for >3 days',
        schedule: '0 9 * * 1-5',
        scheduleHuman: '9:00 AM weekdays',
        timezone: 'America/Denver',
        category: 'purchasing',
        weekdaysOnly: true,
    },
    {
        name: 'POReceivingWatcher',
        description: 'Detects newly-received POs and sends Telegram alerts',
        schedule: '*/30 * * * *',
        scheduleHuman: 'Every 30 minutes',
        category: 'purchasing',
        weekdaysOnly: false,
    },
    {
        name: 'PurchasingCalendarSync',
        description: 'Syncs open POs to Google Calendar events with tracking/ETA data',
        schedule: '0 */4 * * *',
        scheduleHuman: 'Every 4 hours',
        timezone: 'America/Denver',
        category: 'purchasing',
        weekdaysOnly: false,
    },

    // ── REPORTING ─────────────────────────────────
    {
        name: 'DailySummary',
        description: 'Morning operational summary to Telegram and Slack',
        schedule: '0 8 * * 1-5',
        scheduleHuman: '8:00 AM weekdays',
        timezone: 'America/Denver',
        category: 'reporting',
        weekdaysOnly: true,
    },
    {
        name: 'WeeklySummary',
        description: 'Friday weekly ops summary with trend analysis',
        schedule: '1 8 * * 5',
        scheduleHuman: '8:01 AM Fridays',
        timezone: 'America/Denver',
        category: 'reporting',
        weekdaysOnly: true,
    },
    // DECISION(2026-03-20): SlackPurchasesReport REMOVED per Will.
    // Active Purchases no longer posted to Slack — available via Dashboard only.
    {
        name: 'APDailyRecap',
        description: 'End-of-day AP agent recap of all invoice processing decisions',
        schedule: '0 17 * * 1-5',
        scheduleHuman: '5:00 PM weekdays',
        timezone: 'America/Denver',
        category: 'reporting',
        weekdaysOnly: true,
    },
    {
        name: 'OOSReportGenerator',
        description: 'Generates Out-of-Stock Excel report from Stockie alerts',
        schedule: '*/5 7-9 * * 1-5',
        scheduleHuman: '7:45–9:05 AM weekdays (polls every 5 min)',
        timezone: 'America/Denver',
        category: 'reporting',
        weekdaysOnly: true,
    },
    {
        name: 'MorningHeartbeat',
        description: 'Daily "I\'m alive" check — uptime, memory, schedule preview',
        schedule: '0 7 * * 1-5',
        scheduleHuman: '7:00 AM weekdays',
        timezone: 'America/Denver',
        category: 'maintenance',
        weekdaysOnly: true,
    },

    // ── RECONCILIATION ────────────────────────────
    {
        name: 'ReconcileAxiom',
        description: 'Reconciles Axiom Print invoices against Finale POs',
        schedule: '0 1 * * 1-5',
        scheduleHuman: '1:00 AM weekdays',
        timezone: 'America/Denver',
        category: 'reconciliation',
        weekdaysOnly: true,
    },
    {
        name: 'ReconcileFedEx',
        description: 'Reconciles FedEx billing against Finale POs',
        schedule: '30 1 * * 1-5',
        scheduleHuman: '1:30 AM weekdays',
        timezone: 'America/Denver',
        category: 'reconciliation',
        weekdaysOnly: true,
    },
    {
        name: 'ReconcileTeraGanix',
        description: 'Reconciles TeraGanix order confirmations against POs',
        schedule: '0 2 * * 1-5',
        scheduleHuman: '2:00 AM weekdays',
        timezone: 'America/Denver',
        category: 'reconciliation',
        weekdaysOnly: true,
    },
    {
        name: 'ReconcileULINE',
        description: 'Scrapes ULINE invoices and reconciles against Finale POs',
        schedule: '0 3 * * 1-5',
        scheduleHuman: '3:00 AM weekdays',
        timezone: 'America/Denver',
        category: 'reconciliation',
        weekdaysOnly: true,
    },

    // ── MANUFACTURING ─────────────────────────────
    {
        name: 'BuildCompletionWatcher',
        description: 'Detects completed builds and notifies + updates calendar',
        schedule: '*/30 * * * *',
        scheduleHuman: 'Every 30 minutes',
        category: 'manufacturing',
        weekdaysOnly: false,
    },
    {
        name: 'BuildRiskReport',
        description: 'Analyzes BOM components for supply risk and sends alert',
        schedule: '30 7 * * 1-5',
        scheduleHuman: '7:30 AM weekdays',
        timezone: 'America/Denver',
        category: 'manufacturing',
        weekdaysOnly: true,
    },

    // ── KAIZEN / LEARNING ─────────────────────────
    {
        name: 'KaizenSelfReview',
        description: 'Weekly AI self-review of operational decisions and accuracy',
        schedule: '20 8 * * 5',
        scheduleHuman: '8:20 AM Fridays',
        timezone: 'America/Denver',
        category: 'kaizen',
        weekdaysOnly: true,
    },
    {
        name: 'KaizenMemorySync',
        description: 'Syncs operational learnings to Pinecone long-term memory',
        schedule: '0 22 * * *',
        scheduleHuman: '10:00 PM daily',
        timezone: 'America/Denver',
        category: 'kaizen',
        weekdaysOnly: false,
    },
    {
        name: 'NightlyHousekeeping',
        description: 'Prunes stale data from Supabase, Pinecone, and cron_runs',
        schedule: '0 23 * * *',
        scheduleHuman: '11:00 PM daily',
        timezone: 'America/Denver',
        category: 'kaizen',
        weekdaysOnly: false,
    },

    // ── MAINTENANCE ───────────────────────────────
    {
        name: 'DedupSetReset',
        description: 'Clears in-memory dedup sets to prevent OOM over time',
        schedule: '0 0 * * *',
        scheduleHuman: 'Midnight daily',
        timezone: 'America/Denver',
        category: 'maintenance',
        weekdaysOnly: false,
    },
    {
        name: 'NightshiftEnqueue',
        description: 'Batch-enqueues unprocessed AP emails for overnight local LLM classification',
        schedule: '0 18 * * 1-5',
        scheduleHuman: '6:00 PM weekdays',
        timezone: 'America/Denver',
        category: 'kaizen',
        weekdaysOnly: true,
    },
    {
        name: 'NightshiftHandoff',
        description: 'Morning shift-change report: classification results, reconciliation outcomes, to-do list',
        schedule: '55 6 * * 1-5',
        scheduleHuman: '6:55 AM weekdays',
        timezone: 'America/Denver',
        category: 'kaizen',
        weekdaysOnly: true,
    },
];

// ──────────────────────────────────────────────────
// RUNTIME STATUS TRACKING
// ──────────────────────────────────────────────────

/** In-memory cache of last run status for each cron task */
const cronRunStatus = new Map<string, CronRunStatus>();

/**
 * Record a cron job's execution result.
 * Called by safeRun() in ops-manager after each task completes.
 */
export function recordCronRun(
    taskName: string,
    durationMs: number,
    status: 'success' | 'error',
    error?: string,
): void {
    cronRunStatus.set(taskName, {
        lastRun: new Date(),
        durationMs,
        status,
        error,
    });
}

/**
 * Get the last run status for a specific task.
 */
export function getCronRunStatus(taskName: string): CronRunStatus | undefined {
    return cronRunStatus.get(taskName);
}

/**
 * Get all recorded run statuses.
 */
export function getAllCronRunStatuses(): Map<string, CronRunStatus> {
    return cronRunStatus;
}

// ──────────────────────────────────────────────────
// QUERY HELPERS
// ──────────────────────────────────────────────────

/**
 * Get all jobs in a specific category.
 */
export function getJobsByCategory(category: CronCategory): CronJobDefinition[] {
    return CRON_JOBS.filter(j => j.category === category);
}

/**
 * Find a job definition by name.
 */
export function getJobByName(name: string): CronJobDefinition | undefined {
    return CRON_JOBS.find(j => j.name === name);
}

/**
 * Get all unique categories that have registered jobs.
 */
export function getCategories(): CronCategory[] {
    return [...new Set(CRON_JOBS.map(j => j.category))];
}

/**
 * Get job count summary by category.
 */
export function getCategorySummary(): Record<CronCategory, number> {
    const summary = {} as Record<CronCategory, number>;
    for (const job of CRON_JOBS) {
        summary[job.category] = (summary[job.category] || 0) + 1;
    }
    return summary;
}

// ──────────────────────────────────────────────────
// FORMATTING (for Telegram /crons command)
// ──────────────────────────────────────────────────

const CATEGORY_EMOJI: Record<CronCategory, string> = {
    email: '📧',
    tracking: '📦',
    purchasing: '🛒',
    reporting: '📊',
    reconciliation: '🧾',
    manufacturing: '🏭',
    kaizen: '🧠',
    maintenance: '🔧',
};

/**
 * Format the full cron status report for Telegram.
 * Groups jobs by category, shows last run status and timing.
 */
export function formatCronStatusReport(): string {
    const lines: string[] = ['<b>📋 ARIA Cron Registry</b>', ''];

    const categories = getCategories();

    for (const category of categories) {
        const emoji = CATEGORY_EMOJI[category] || '📌';
        const jobs = getJobsByCategory(category);
        lines.push(`${emoji} <b>${category.toUpperCase()}</b>`);

        for (const job of jobs) {
            const status = cronRunStatus.get(job.name);
            let statusIcon = '⬜'; // never run
            let statusText = 'Not yet run';

            if (status) {
                if (status.status === 'success') {
                    statusIcon = '✅';
                    const ago = formatTimeAgo(status.lastRun);
                    statusText = `${ago} (${status.durationMs}ms)`;
                } else {
                    statusIcon = '❌';
                    const ago = formatTimeAgo(status.lastRun);
                    statusText = `FAILED ${ago}: ${status.error?.slice(0, 60) || 'Unknown'}`;
                }
            }

            lines.push(`  ${statusIcon} <b>${job.name}</b>`);
            lines.push(`     ${job.scheduleHuman} — ${job.description}`);
            if (status) {
                lines.push(`     ${statusText}`);
            }
        }
        lines.push('');
    }

    lines.push(`<i>Total: ${CRON_JOBS.length} registered jobs</i>`);
    return lines.join('\n');
}

/**
 * Format a compact status summary (for dashboard or quick check).
 */
export function formatCompactStatus(): string {
    const total = CRON_JOBS.length;
    const running = [...cronRunStatus.values()].filter(s => s.status === 'success').length;
    const errors = [...cronRunStatus.values()].filter(s => s.status === 'error').length;
    const neverRun = total - cronRunStatus.size;

    return `✅ ${running} ok | ❌ ${errors} errors | ⬜ ${neverRun} pending | 📋 ${total} total`;
}

// ──────────────────────────────────────────────────
// INTERNAL HELPERS
// ──────────────────────────────────────────────────

function formatTimeAgo(date: Date): string {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
}
