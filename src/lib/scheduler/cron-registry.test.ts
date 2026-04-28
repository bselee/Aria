/**
 * @file    cron-registry.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
    CRON_JOBS,
    type CronCategory,
    formatCompactStatus,
    formatCronStatusReport,
    getAllCronRunStatuses,
    getCategories,
    getCategorySummary,
    getCronRunStatus,
    getJobByName,
    getJobsByCategory,
    recordCronRun,
} from './cron-registry';

describe('CRON_JOBS definitions', () => {
    it('contains the full current runtime schedule', () => {
        expect(CRON_JOBS.length).toBe(18);
    });

    it('has unique job names', () => {
        const names = CRON_JOBS.map((job) => job.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('has valid cron expressions', () => {
        for (const job of CRON_JOBS) {
            expect(job.schedule.split(' ').length, `${job.name} schedule should have 5 fields`).toBe(5);
        }
    });

    it('marks weekday-only jobs with timezone information', () => {
        for (const job of CRON_JOBS.filter((item) => item.weekdaysOnly)) {
            expect(job.timezone, `${job.name} missing timezone`).toBe('America/Denver');
        }
    });

    it('DailySummary is weekdays-only with correct schedule', () => {
        const daily = CRON_JOBS.find((job) => job.name === 'DailySummary');
        expect(daily?.weekdaysOnly).toBe(true);
        expect(daily?.schedule).toBe('0 8 * * 1-5');
        expect(daily?.timezone).toBe('America/Denver');
    });

    it('includes all task names scheduled by OpsManager.registerJobs', () => {
        const expectedTasks = [
            'APPolling',
            'BuildRisk',
            'DailySummary',
            'WeeklySummary',
            'NightshiftEnqueue',
            'Housekeeping',
            'StatIndexing',
            'POSync',
            'POSweep',
            'ReconcileAxiom',
            'ReconcileFedEx',
            'ReconcileTeraGanix',
            'ReconcileULINE',
            'BuildCompletionWatcher',
            'POReceivingWatcher',
            'PurchasingCalendarSync',
        ];

        const names = new Set(CRON_JOBS.map((job) => job.name));
        for (const task of expectedTasks) {
            expect(names.has(task), `Missing scheduled task ${task}`).toBe(true);
        }
    });
});

describe('recordCronRun / getCronRunStatus', () => {
    it('records successful cron runs', () => {
        recordCronRun('TestTask', 150, 'success');
        const status = getCronRunStatus('TestTask');
        expect(status?.status).toBe('success');
        expect(status?.durationMs).toBe(150);
        expect(status?.lastRun).toBeInstanceOf(Date);
    });

    it('records failed cron runs with an error', () => {
        recordCronRun('FailingTask', 500, 'error', 'Connection timeout');
        const status = getCronRunStatus('FailingTask');
        expect(status?.status).toBe('error');
        expect(status?.error).toBe('Connection timeout');
    });

    it('returns all statuses', () => {
        recordCronRun('AllStatusTest1', 10, 'success');
        recordCronRun('AllStatusTest2', 20, 'error', 'oops');
        const all = getAllCronRunStatuses();
        expect(all.has('AllStatusTest1')).toBe(true);
        expect(all.has('AllStatusTest2')).toBe(true);
    });
});

describe('query helpers', () => {
    it('filters jobs by category', () => {
        const emailJobs = getJobsByCategory('email');
        expect(emailJobs.length).toBeGreaterThan(0);
        for (const job of emailJobs) {
            expect(job.category).toBe('email');
        }
    });

    it('returns empty array for unknown categories at runtime', () => {
        expect(getJobsByCategory('nonexistent' as CronCategory)).toEqual([]);
    });

    it('finds jobs by name', () => {
        const job = getJobByName('APPolling');
        expect(job?.name).toBe('APPolling');
        expect(job?.category).toBe('email');
    });

    it('returns undefined for unknown names', () => {
        expect(getJobByName('GhostTask')).toBeUndefined();
    });

    it('returns category summaries that add up to total jobs', () => {
        const summary = getCategorySummary();
        const total = Object.values(summary).reduce((sum, value) => sum + value, 0);
        expect(total).toBe(CRON_JOBS.length);
    });

    it('returns all active categories', () => {
        const categories = getCategories();
        expect(categories).toContain('email');
        expect(categories).toContain('reconciliation');
        expect(categories).toContain('maintenance');
    });
});

describe('formatting', () => {
    it('formats the full cron status report', () => {
        const report = formatCronStatusReport();
        expect(report).toContain('ARIA Cron Registry');
        expect(report).toContain('EMAIL');
        expect(report).toContain(`${CRON_JOBS.length} registered jobs`);
    });

    it('shows success status for recorded runs', () => {
        recordCronRun('APPolling', 42, 'success');
        const report = formatCronStatusReport();
        expect(report).toContain('✅');
        expect(report).toContain('APPolling');
    });

    it('shows error status for failed runs', () => {
        recordCronRun('NightshiftEnqueue', 999, 'error', 'API timeout');
        const report = formatCronStatusReport();
        expect(report).toContain('❌');
        expect(report).toContain('API timeout');
    });

    it('formats a compact one-line summary', () => {
        const compact = formatCompactStatus();
        expect(compact).toContain('ok');
        expect(compact).toContain('total');
        expect(compact.includes('\n')).toBe(false);
    });
});
