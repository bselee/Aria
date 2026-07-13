/**
 * @file    src/lib/ops/module-health-check.ts
 * @purpose Startup and runtime health verification for critical Aria modules.
 *          Three responsibilities:
 *
 *          1. verifyCriticalModules() — at boot, import every critical module
 *             and return failures. Called by start-bot.ts before bot.launch().
 *             If any module fails to load, sends a FATAL Telegram alert.
 *
 *          2. getConsecutiveFailures(jobName) — tracks consecutive cron
 *             failures in local SQLite. After 3 strikes, sends a Telegram
 *             alert. Used by cron runner's routeFailure().
 *
 *          3. smokeTestCompile(paths) — pre-restart compile check. Imports
 *             each file via tsx to catch syntax errors before PM2 restart.
 *             Used by the pre-restart script.
 *
 * @author  Hermia
 * @created 2026-07-09
 * @deps    better-sqlite3 (via local-db), tsx (runtime)
 * @env     TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN (for alerts)
 */

import { getLocalDb } from "../storage/local-db";
import { sendTelegramNotify } from "../intelligence/telegram-notify";

// ─── Module list ─────────────────────────────────────────────────────────

/**
 * Critical modules that must load successfully for the AP pipeline to function.
 * If any of these fail to import at boot, the bot is in a degraded state and
 * Bill needs to know immediately.
 */
const CRITICAL_MODULES: Array<{ name: string; path: string }> = [
    { name: "ap-local-forwarder", path: "@/lib/intelligence/workers/ap-local-forwarder" },
    { name: "ap-forwarder", path: "@/lib/intelligence/workers/ap-forwarder" },
    { name: "ap-dedup", path: "@/lib/intelligence/ap-dedup" },
    { name: "ap-single-forward", path: "@/lib/intelligence/ap-single-forward" },
    { name: "ap-identifier", path: "@/lib/intelligence/workers/ap-identifier" },
    { name: "vendor-router", path: "@/lib/intelligence/ap/vendor-router" },
    { name: "local-db", path: "@/lib/storage/local-db" },
    { name: "gmail-auth", path: "@/lib/gmail/auth" },
    { name: "db-client", path: "@/lib/db" },
    { name: "bot-control-plane", path: "@/lib/ops/bot-control-plane" },
    { name: "postgrest-ready", path: "@/lib/ops/postgrest-ready" },
];

export interface HealthCheckResult {
    healthy: boolean;
    failures: Array<{ name: string; error: string }>;
    checked: number;
}

/**
 * Import every critical module and report failures.
 * Does NOT throw — returns a result object so the caller can decide
 * whether to abort boot or continue degraded.
 *
 * @returns {HealthCheckResult} — healthy=true if all modules loaded
 */
export async function verifyCriticalModules(): Promise<HealthCheckResult> {
    const failures: Array<{ name: string; error: string }> = [];
    let checked = 0;

    for (const mod of CRITICAL_MODULES) {
        checked++;
        try {
            await import(mod.path);
            console.log(`[health] ✅ ${mod.name}: OK`);
        } catch (err: any) {
            const error = err?.message ?? String(err);
            failures.push({ name: mod.name, error });
            console.error(`[health] ❌ ${mod.name}: ${error}`);
        }
    }

    const result: HealthCheckResult = {
        healthy: failures.length === 0,
        failures,
        checked,
    };

    if (!result.healthy) {
        const failedList = failures.map(f => `${f.name}: ${f.error.slice(0, 80)}`).join("\n");
        const alertMsg = `🚨 BOOT HEALTH CHECK FAILED\n\n${failures.length} critical module(s) failed to load:\n\n${failedList}\n\nAP pipeline dedup is likely broken. Check for syntax errors in recently edited files.`;
        try {
            await sendTelegramNotify(alertMsg);
        } catch {
            console.error("[health] Failed to send Telegram alert for boot health check failure");
        }
    }

    return result;
}

// ─── Consecutive failure tracking ─────────────────────────────────────────

const FAILURE_TABLE = "cron_failure_tracker";
const ALERT_THRESHOLD = 3;

/**
 * Ensure the failure tracker table exists. Idempotent.
 */
function ensureFailureTable(): void {
    try {
        const db = getLocalDb();
        db.exec(`
            CREATE TABLE IF NOT EXISTS ${FAILURE_TABLE} (
                job_name TEXT PRIMARY KEY,
                consecutive_failures INTEGER NOT NULL DEFAULT 0,
                last_failure_reason TEXT,
                last_failure_at TEXT,
                last_alert_at TEXT
            )
        `);
    } catch {
        // DB might not be ready during early boot — non-fatal
    }
}

/**
 * Record a cron failure and alert if threshold is reached.
 * Resets counter on success (call recordCronSuccess).
 *
 * @param jobName - The cron job name
 * @param reason - Failure reason/message
 */
export async function recordCronFailure(jobName: string, reason: string): Promise<void> {
    try {
        ensureFailureTable();
        const db = getLocalDb();

        const row = db.prepare(
            `SELECT consecutive_failures, last_alert_at FROM ${FAILURE_TABLE} WHERE job_name = ?`
        ).get(jobName) as { consecutive_failures: number; last_alert_at: string | null } | undefined;

        const newCount = (row?.consecutive_failures ?? 0) + 1;
        const now = new Date().toISOString();

        db.prepare(
            `INSERT INTO ${FAILURE_TABLE} (job_name, consecutive_failures, last_failure_reason, last_failure_at, last_alert_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(job_name) DO UPDATE SET
                consecutive_failures = excluded.consecutive_failures,
                last_failure_reason = excluded.last_failure_reason,
                last_failure_at = excluded.last_failure_at,
                last_alert_at = ${FAILURE_TABLE}.last_alert_at`
        ).run(jobName, newCount, reason.slice(0, 200), now, row?.last_alert_at ?? null);

        // Alert on threshold crossing (3 consecutive failures)
        if (newCount >= ALERT_THRESHOLD) {
            // Update last_alert_at BEFORE sending the Telegram alert.
            // This prevents thundering-herd duplicate alerts if Telegram is down:
            // the timestamp is committed regardless of whether the alert succeeds.
            const now = new Date().toISOString();
            db.prepare(
                `UPDATE ${FAILURE_TABLE} SET last_alert_at = ? WHERE job_name = ?`
            ).run(now, jobName);

            // Only alert if it's been > 6 hours since last alert
            const shouldAlert = !row?.last_alert_at ||
                (Date.now() - new Date(row.last_alert_at).getTime() > 6 * 60 * 60 * 1000);

            if (shouldAlert) {
                const alertMsg = `CRON FAILURE STREAK\n\n${jobName} has failed ${newCount} consecutive times.\n\nLast error: ${reason.slice(0, 150)}\n\nCheck pm2 logs or run: pm2 logs aria-bot --lines 50`;
                try {
                    await sendTelegramNotify(alertMsg);
                } catch {
                    console.error(`[health] Failed to send Telegram alert for ${jobName} failure streak`);
                }
            }
        }
    } catch (e: any) {
        console.warn(`[health] recordCronFailure failed: ${e.message}`);
    }
}

/**
 * Reset the failure counter for a job after a successful run.
 *
 * @param jobName - The cron job name
 */
export function recordCronSuccess(jobName: string): void {
    try {
        ensureFailureTable();
        const db = getLocalDb();
        db.prepare(
            `INSERT INTO ${FAILURE_TABLE} (job_name, consecutive_failures, last_failure_reason, last_failure_at, last_alert_at)
             VALUES (?, 0, NULL, NULL, NULL)
             ON CONFLICT(job_name) DO UPDATE SET
                consecutive_failures = 0,
                last_failure_reason = NULL,
                last_failure_at = NULL,
                last_alert_at = NULL`
        ).run(jobName);
    } catch {
        // non-fatal
    }
}

// ─── Pre-restart smoke test ───────────────────────────────────────────────

/**
 * Smoke-test module compilation before PM2 restart.
 * Imports each file via dynamic import to catch syntax/transform errors.
 * Returns the list of failures (empty = all clear).
 *
 * Call this from a pre-restart script before `pm2 restart aria-bot`.
 *
 * @param paths - Array of file paths to test (relative to project root)
 * @returns Array of { path, error } for each file that failed to compile
 */
export async function smokeTestCompile(paths: string[]): Promise<Array<{ path: string; error: string }>> {
    const failures: Array<{ path: string; error: string }> = [];

    for (const p of paths) {
        try {
            await import(p);
            console.log(`[smoke] ✅ ${p}`);
        } catch (err: any) {
            const error = err?.message ?? String(err);
            failures.push({ path: p, error });
            console.error(`[smoke] ❌ ${p}: ${error}`);
        }
    }

    return failures;
}
