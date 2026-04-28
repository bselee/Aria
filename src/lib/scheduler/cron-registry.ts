/**
 * @file    cron-registry.ts
 * @purpose Centralized registry of all ARIA scheduled tasks. Provides typed
 *          definitions with human-readable descriptions, schedule expressions,
 *          and runtime status tracking. Single source of truth for what ARIA
 *          actually schedules in OpsManager.registerJobs().
 */

export type CronCategory =
    | 'email'
    | 'purchasing'
    | 'reporting'
    | 'reconciliation'
    | 'manufacturing'
    | 'kaizen'
    | 'maintenance';

export interface CronJobDefinition {
    name: string;
    description: string;
    schedule: string;
    scheduleHuman: string;
    timezone?: string;
    category: CronCategory;
    weekdaysOnly: boolean;
}

export interface CronRunStatus {
    lastRun: Date;
    durationMs: number;
    status: 'success' | 'error';
    error?: string;
}

/**
 * Complete registry of all jobs scheduled in OpsManager.registerJobs().
 */
export const CRON_JOBS: CronJobDefinition[] = [
    {
        name: 'APPolling',
        description: 'Runs the AP inbox pipeline: ingest, identify, reconcile, and forward invoices',
        schedule: '*/15 * * * *',
        scheduleHuman: 'Every 15 minutes',
        category: 'email',
        weekdaysOnly: false,
    },
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
        scheduleHuman: 'Every 4 hours (offset by 30 minutes)',
        category: 'purchasing',
        weekdaysOnly: false,
    },
    {
        name: 'POReceivingWatcher',
        description: 'Detects newly received POs and sends Telegram alerts',
        schedule: '*/30 * * * *',
        scheduleHuman: 'Every 30 minutes',
        category: 'purchasing',
        weekdaysOnly: false,
    },
    {
        name: 'PurchasingCalendarSync',
        description: 'Syncs open POs to Google Calendar events with tracking and ETA data',
        schedule: '0 */4 * * *',
        scheduleHuman: 'Every 4 hours',
        timezone: 'America/Denver',
        category: 'purchasing',
        weekdaysOnly: false,
    },
    {
        name: 'DailySummary',
        description: 'Morning operational summary to Telegram and Slack (Friday=weekly wrap, Monday=previous week review)',
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
    {
        name: 'BuildCompletionWatcher',
        description: 'Detects completed builds and updates downstream notifications and calendar state',
        schedule: '*/30 * * * *',
        scheduleHuman: 'Every 30 minutes',
        category: 'manufacturing',
        weekdaysOnly: false,
    },
    {
        name: 'BuildRisk',
        description: 'Analyzes BOM components for supply risk and sends alerts',
        schedule: '30 7 * * 1-5',
        scheduleHuman: '7:30 AM weekdays',
        timezone: 'America/Denver',
        category: 'manufacturing',
        weekdaysOnly: true,
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
        name: 'Housekeeping',
        description: 'Prunes stale operational data from Supabase, Pinecone, and local state',
        schedule: '0 21 * * *',
        scheduleHuman: '9:00 PM daily',
        timezone: 'America/Denver',
        category: 'maintenance',
        weekdaysOnly: false,
    },
    {
        name: 'StatIndexing',
        description: 'Indexes operational snapshots for dashboard and memory retrieval',
        schedule: '5 * * * *',
        scheduleHuman: '5 minutes after every hour',
        timezone: 'America/Denver',
        category: 'maintenance',
        weekdaysOnly: false,
    },
    {
        name: 'MissingReconciliationWatchdog',
        description: 'Alerts if any vendor reconciliation has not run successfully in 24h',
        schedule: '0 9 * * 1-5',
        scheduleHuman: '9:00 AM weekdays',
        timezone: 'America/Denver',
        category: 'reconciliation',
        weekdaysOnly: true,
    },
    {
        name: 'CloseFinishedTasks',
        description: 'Hygiene: closes finished agent_task rows whose closes_when predicate is satisfied',
        schedule: '*/5 * * * *',
        scheduleHuman: 'Every 5 minutes',
        category: 'maintenance',
        weekdaysOnly: false,
    },
    {
        name: 'MigrationTripwire',
        description: 'Self-heal Layer A: compares supabase/migrations/*.sql on disk to applied versions; surfaces drift as a tripwire_violation task',
        schedule: '*/30 * * * *',
        scheduleHuman: 'Every 30 minutes',
        category: 'maintenance',
        weekdaysOnly: false,
    },
];

const cronRunStatus = new Map<string, CronRunStatus>();

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

export function getCronRunStatus(taskName: string): CronRunStatus | undefined {
    return cronRunStatus.get(taskName);
}

export function getAllCronRunStatuses(): Map<string, CronRunStatus> {
    return cronRunStatus;
}

export function getJobsByCategory(category: CronCategory): CronJobDefinition[] {
    return CRON_JOBS.filter((job) => job.category === category);
}

export function getJobByName(name: string): CronJobDefinition | undefined {
    return CRON_JOBS.find((job) => job.name === name);
}

export function getCategories(): CronCategory[] {
    return [...new Set(CRON_JOBS.map((job) => job.category))];
}

export function getCategorySummary(): Record<CronCategory, number> {
    const summary = {} as Record<CronCategory, number>;
    for (const job of CRON_JOBS) {
        summary[job.category] = (summary[job.category] || 0) + 1;
    }
    return summary;
}

const CATEGORY_EMOJI: Record<CronCategory, string> = {
    email: 'EMAIL',
    purchasing: 'PURCHASING',
    reporting: 'REPORTING',
    reconciliation: 'RECONCILIATION',
    manufacturing: 'MANUFACTURING',
    kaizen: 'KAIZEN',
    maintenance: 'MAINTENANCE',
};

export function formatCronStatusReport(): string {
    const lines: string[] = ['<b>ARIA Cron Registry</b>', ''];

    for (const category of getCategories()) {
        const header = CATEGORY_EMOJI[category] || category.toUpperCase();
        const jobs = getJobsByCategory(category);
        lines.push(`<b>${header}</b>`);

        for (const job of jobs) {
            const status = cronRunStatus.get(job.name);
            let statusIcon = '⬜';
            let statusText = 'Not yet run';

            if (status) {
                if (status.status === 'success') {
                    statusIcon = '✅';
                    statusText = `${formatTimeAgo(status.lastRun)} (${status.durationMs}ms)`;
                } else {
                    statusIcon = '❌';
                    statusText = `FAILED ${formatTimeAgo(status.lastRun)}: ${status.error?.slice(0, 60) || 'Unknown'}`;
                }
            }

            lines.push(`  ${statusIcon} <b>${job.name}</b>`);
            lines.push(`     ${job.scheduleHuman} - ${job.description}`);
            if (status) {
                lines.push(`     ${statusText}`);
            }
        }

        lines.push('');
    }

    lines.push(`<i>Total: ${CRON_JOBS.length} registered jobs</i>`);
    return lines.join('\n');
}

export function formatCompactStatus(): string {
    const total = CRON_JOBS.length;
    const running = [...cronRunStatus.values()].filter((status) => status.status === 'success').length;
    const errors = [...cronRunStatus.values()].filter((status) => status.status === 'error').length;
    const neverRun = total - cronRunStatus.size;

    return `ok ${running} | errors ${errors} | pending ${neverRun} | total ${total}`;
}

function formatTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}
