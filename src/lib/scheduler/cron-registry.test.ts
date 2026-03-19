/**
 * @file    cron-registry.test.ts
 * @purpose Tests for the centralized cron registry — validates job definitions,
 *          runtime status tracking, query helpers, and formatting.
 * @author  Will / Antigravity
 * @created 2026-03-19
 * @updated 2026-03-19
 * @deps    vitest, cron-registry
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    CRON_JOBS,
    type CronJobDefinition,
    type CronCategory,
    recordCronRun,
    getCronRunStatus,
    getAllCronRunStatuses,
    getJobsByCategory,
    getJobByName,
    getCategories,
    getCategorySummary,
    formatCronStatusReport,
    formatCompactStatus,
} from './cron-registry';

// ──────────────────────────────────────────────────
// JOB DEFINITIONS
// ──────────────────────────────────────────────────

describe('CRON_JOBS definitions', () => {
    it('should contain at least 30 registered jobs', () => {
        expect(CRON_JOBS.length).toBeGreaterThanOrEqual(30);
    });

    it('should have unique job names (no duplicates)', () => {
        const names = CRON_JOBS.map(j => j.name);
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(names.length);
    });

    it('should have valid cron expressions for all jobs', () => {
        // Basic validation: cron expressions should have 5 space-separated fields
        for (const job of CRON_JOBS) {
            const parts = job.schedule.split(' ');
            expect(parts.length, `${job.name} schedule "${job.schedule}" should have 5 fields`).toBe(5);
        }
    });

    it('should have descriptions for all jobs', () => {
        for (const job of CRON_JOBS) {
            expect(job.description.length, `${job.name} should have a description`).toBeGreaterThan(10);
        }
    });

    it('should have human-readable schedules for all jobs', () => {
        for (const job of CRON_JOBS) {
            expect(job.scheduleHuman.length, `${job.name} should have scheduleHuman`).toBeGreaterThan(3);
        }
    });

    it('should set weekdaysOnly=true for all weekday-only schedules', () => {
        for (const job of CRON_JOBS) {
            // If schedule contains "1-5" or "5" as day-of-week, it should be weekdaysOnly
            const parts = job.schedule.split(' ');
            const dow = parts[4]; // 5th field = day of week
            if (dow === '1-5' || dow === '5') {
                expect(job.weekdaysOnly, `${job.name} runs only on weekdays but weekdaysOnly is false`).toBe(true);
            }
        }
    });

    it('should specify timezone for all Denver-specific schedules', () => {
        // Jobs with fixed hour schedules on weekdays should have timezone
        const weekdayJobs = CRON_JOBS.filter(j => j.weekdaysOnly);
        for (const job of weekdayJobs) {
            expect(job.timezone, `${job.name} is weekday-only but missing timezone`).toBe('America/Denver');
        }
    });

    it('should include all critical task names that ops-manager uses', () => {
        const criticalTasks = [
            'Supervisor', 'EmailIngestionDefault', 'DailySummary',
            'POSync', 'TrackingAgent', 'MorningHeartbeat',
            'ReconcileAxiom', 'BuildCompletionWatcher',
            'NightlyHousekeeping', 'DedupSetReset',
        ];
        const registeredNames = new Set(CRON_JOBS.map(j => j.name));
        for (const task of criticalTasks) {
            expect(registeredNames.has(task), `Critical task "${task}" missing from registry`).toBe(true);
        }
    });
});

// ──────────────────────────────────────────────────
// RUNTIME STATUS TRACKING
// ──────────────────────────────────────────────────

describe('recordCronRun / getCronRunStatus', () => {
    it('should record a successful cron run', () => {
        recordCronRun('TestTask', 150, 'success');
        const status = getCronRunStatus('TestTask');
        expect(status).toBeDefined();
        expect(status!.status).toBe('success');
        expect(status!.durationMs).toBe(150);
        expect(status!.lastRun).toBeInstanceOf(Date);
    });

    it('should record a failed cron run with error message', () => {
        recordCronRun('FailingTask', 500, 'error', 'Connection timeout');
        const status = getCronRunStatus('FailingTask');
        expect(status).toBeDefined();
        expect(status!.status).toBe('error');
        expect(status!.error).toBe('Connection timeout');
    });

    it('should overwrite previous status on re-run', () => {
        recordCronRun('RerunTask', 100, 'error', 'First failure');
        recordCronRun('RerunTask', 50, 'success');
        const status = getCronRunStatus('RerunTask');
        expect(status!.status).toBe('success');
        expect(status!.durationMs).toBe(50);
        expect(status!.error).toBeUndefined();
    });

    it('should return undefined for unregistered tasks', () => {
        expect(getCronRunStatus('NonExistentTask_XYZ')).toBeUndefined();
    });

    it('should return all statuses via getAllCronRunStatuses', () => {
        recordCronRun('AllStatusTest1', 10, 'success');
        recordCronRun('AllStatusTest2', 20, 'error', 'oops');
        const all = getAllCronRunStatuses();
        expect(all.has('AllStatusTest1')).toBe(true);
        expect(all.has('AllStatusTest2')).toBe(true);
    });
});

// ──────────────────────────────────────────────────
// QUERY HELPERS
// ──────────────────────────────────────────────────

describe('query helpers', () => {
    it('getJobsByCategory should return only jobs matching the category', () => {
        const emailJobs = getJobsByCategory('email');
        expect(emailJobs.length).toBeGreaterThan(0);
        for (const job of emailJobs) {
            expect(job.category).toBe('email');
        }
    });

    it('getJobsByCategory should return empty for non-existent category', () => {
        // TypeScript prevents invalid categories, but test the runtime behavior
        const result = getJobsByCategory('nonexistent' as CronCategory);
        expect(result).toEqual([]);
    });

    it('getJobByName should return the correct job', () => {
        const job = getJobByName('Supervisor');
        expect(job).toBeDefined();
        expect(job!.name).toBe('Supervisor');
        expect(job!.category).toBe('maintenance');
    });

    it('getJobByName should return undefined for unknown name', () => {
        expect(getJobByName('GhostTask')).toBeUndefined();
    });

    it('getCategories should return all unique categories', () => {
        const categories = getCategories();
        expect(categories.length).toBeGreaterThanOrEqual(6);
        expect(categories).toContain('email');
        expect(categories).toContain('purchasing');
        expect(categories).toContain('reporting');
    });

    it('getCategorySummary should sum to total job count', () => {
        const summary = getCategorySummary();
        const total = Object.values(summary).reduce((a, b) => a + b, 0);
        expect(total).toBe(CRON_JOBS.length);
    });
});

// ──────────────────────────────────────────────────
// FORMATTING
// ──────────────────────────────────────────────────

describe('formatCronStatusReport', () => {
    it('should produce HTML-formatted output', () => {
        const report = formatCronStatusReport();
        expect(report).toContain('<b>');
        expect(report).toContain('ARIA Cron Registry');
    });

    it('should include all category headers', () => {
        const report = formatCronStatusReport();
        expect(report).toContain('EMAIL');
        expect(report).toContain('PURCHASING');
        expect(report).toContain('REPORTING');
    });

    it('should show total job count', () => {
        const report = formatCronStatusReport();
        expect(report).toContain(`${CRON_JOBS.length} registered jobs`);
    });

    it('should show success status for recently recorded runs', () => {
        recordCronRun('Supervisor', 42, 'success');
        const report = formatCronStatusReport();
        expect(report).toContain('✅');
        expect(report).toContain('Supervisor');
    });

    it('should show error status for failed runs', () => {
        recordCronRun('TrackingAgent', 999, 'error', 'API timeout');
        const report = formatCronStatusReport();
        expect(report).toContain('❌');
        expect(report).toContain('FAILED');
        expect(report).toContain('API timeout');
    });
});

describe('formatCompactStatus', () => {
    it('should produce a one-line summary', () => {
        const compact = formatCompactStatus();
        expect(compact).toContain('ok');
        expect(compact).toContain('total');
        expect(compact).not.toContain('\n');
    });
});
