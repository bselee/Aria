/**
 * @file    src/lib/ops/observability.ts
 * @purpose Observability infrastructure: agent_metrics table + cron cost logging.
 *          Tracks execution time, token usage, and estimated cost per cron job.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/storage/local-db
 *
 * Tables created in aria-local.db:
 *   agent_metrics — per-agent execution metrics (heartbeats, task counts, durations)
 *   cron_cost_log — per-cron-run estimated LLM cost (Phase 5.3)
 */

import { getLocalDb } from "@/lib/storage/local-db";

// ── Schema ──────────────────────────────────────────────────────────────────

let initialized = false;

function ensureObservabilitySchema(): void {
    if (initialized) return;
    const db = getLocalDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_name TEXT NOT NULL,
            metric_type TEXT NOT NULL,
            value REAL DEFAULT 0,
            metadata TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent ON agent_metrics(agent_name);
        CREATE INDEX IF NOT EXISTS idx_agent_metrics_type ON agent_metrics(metric_type);
        CREATE INDEX IF NOT EXISTS idx_agent_metrics_created ON agent_metrics(created_at);

        CREATE TABLE IF NOT EXISTS cron_cost_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_name TEXT NOT NULL,
            duration_ms INTEGER DEFAULT 0,
            estimated_tokens_in INTEGER DEFAULT 0,
            estimated_tokens_out INTEGER DEFAULT 0,
            estimated_cost_usd REAL DEFAULT 0,
            model_used TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cron_cost_job ON cron_cost_log(job_name);
        CREATE INDEX IF NOT EXISTS idx_cron_cost_created ON cron_cost_log(created_at);
    `);
    initialized = true;
}

// ── Agent Metrics ───────────────────────────────────────────────────────────

export function recordAgentMetric(
    agentName: string,
    metricType: string,
    value: number = 1,
    metadata: Record<string, unknown> = {},
): void {
    try {
        ensureObservabilitySchema();
        const db = getLocalDb();
        db.prepare(
            `INSERT INTO agent_metrics (agent_name, metric_type, value, metadata)
             VALUES (?, ?, ?, ?)`
        ).run(agentName, metricType, value, JSON.stringify(metadata));
    } catch (err: any) {
        // Non-fatal — observability failure should never break an agent
    }
}

export function getAgentStats(agentName: string, hours = 24): Array<{
    metricType: string;
    count: number;
    avgValue: number;
    maxValue: number;
}> {
    try {
        ensureObservabilitySchema();
        const db = getLocalDb();
        const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
        const rows = db.prepare(
            `SELECT metric_type, COUNT(*) as count, AVG(value) as avgValue, MAX(value) as maxValue
             FROM agent_metrics
             WHERE agent_name = ? AND created_at >= ?
             GROUP BY metric_type`
        ).all(agentName, cutoff) as Array<{
            metric_type: string;
            count: number;
            avgValue: number;
            maxValue: number;
        }>;
        return rows.map(r => ({
            metricType: r.metric_type,
            count: r.count,
            avgValue: r.avgValue,
            maxValue: r.maxValue,
        }));
    } catch {
        return [];
    }
}

// ── Cron Cost Logging ───────────────────────────────────────────────────────

/** Cost per million tokens (USD) */
const MODEL_COSTS: Record<string, { inPerMToken: number; outPerMToken: number }> = {
    "claude-haiku-4-5": { inPerMToken: 0.80, outPerMToken: 4.00 },
    "gemini-2.5-flash": { inPerMToken: 0, outPerMToken: 0 },       // Free via OpenRouter
    "gpt-4o": { inPerMToken: 2.50, outPerMToken: 10.00 },
    "gpt-4o-mini": { inPerMToken: 0.15, outPerMToken: 0.60 },
    "gpt-4": { inPerMToken: 30.00, outPerMToken: 60.00 },           // Best accuracy + speed (0.62s)
    "gpt-3.5-turbo": { inPerMToken: 0.50, outPerMToken: 1.50 },     // Best value for high-volume (0.74s)
    "claude-sonnet-4": { inPerMToken: 3.00, outPerMToken: 15.00 },
    "openrouter-free": { inPerMToken: 0, outPerMToken: 0 },
};

export function recordCronCost(
    jobName: string,
    durationMs: number,
    tokensIn: number = 0,
    tokensOut: number = 0,
    modelUsed: string = "",
): void {
    try {
        ensureObservabilitySchema();
        const db = getLocalDb();

        // Estimate cost based on model pricing
        const costTable = MODEL_COSTS[modelUsed] || MODEL_COSTS["openrouter-free"];
        const costUsd = (tokensIn / 1_000_000 * costTable.inPerMToken) +
                        (tokensOut / 1_000_000 * costTable.outPerMToken);

        db.prepare(
            `INSERT INTO cron_cost_log (job_name, duration_ms, estimated_tokens_in,
             estimated_tokens_out, estimated_cost_usd, model_used)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(jobName, durationMs, tokensIn, tokensOut, costUsd, modelUsed);
    } catch {
        // Non-fatal
    }
}

export function getCronCostSummary(days = 7): Array<{
    jobName: string;
    runCount: number;
    totalCostUsd: number;
    avgDurationMs: number;
    totalTokensIn: number;
    totalTokensOut: number;
}> {
    try {
        ensureObservabilitySchema();
        const db = getLocalDb();
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const rows = db.prepare(
            `SELECT job_name, COUNT(*) as runCount,
                    SUM(estimated_cost_usd) as totalCostUsd,
                    AVG(duration_ms) as avgDurationMs,
                    SUM(estimated_tokens_in) as totalTokensIn,
                    SUM(estimated_tokens_out) as totalTokensOut
             FROM cron_cost_log
             WHERE created_at >= ?
             GROUP BY job_name
             ORDER BY totalCostUsd DESC`
        ).all(cutoff) as Array<{
            job_name: string;
            runCount: number;
            totalCostUsd: number;
            avgDurationMs: number;
            totalTokensIn: number;
            totalTokensOut: number;
        }>;
        return rows.map(r => ({
            jobName: r.job_name,
            runCount: r.runCount,
            totalCostUsd: r.totalCostUsd,
            avgDurationMs: Math.round(r.avgDurationMs),
            totalTokensIn: r.totalTokensIn,
            totalTokensOut: r.totalTokensOut,
        }));
    } catch {
        return [];
    }
}

/**
 * Generate a weekly cost summary string for the daily summary email.
 */
export function formatWeeklyCostReport(): string {
    const summary = getCronCostSummary(7);
    if (summary.length === 0) return "No cost data available.";

    const totalCost = summary.reduce((s, r) => s + r.totalCostUsd, 0);
    const totalRuns = summary.reduce((s, r) => s + r.runCount, 0);

    let report = `📊 Weekly LLM Cost Report (last 7 days)\n`;
    report += `   Total: $${totalCost.toFixed(4)} across ${totalRuns} cron runs\n\n`;

    for (const row of summary.slice(0, 10)) {
        report += `   ${row.jobName.padEnd(30)} $${row.totalCostUsd.toFixed(4)} (${row.runCount} runs)\n`;
    }

    return report;
}
