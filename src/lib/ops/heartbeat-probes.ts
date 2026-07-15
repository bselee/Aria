/**
 * @file    src/lib/ops/heartbeat-probes.ts
 * @purpose Individual liveness probe functions for the Aria system heartbeat.
 *          Each probe is a self-contained, resilient async check of one
 *          critical dependency (infra), long-lived process, or scheduled cron.
 *          Probes never throw — they resolve to a {@link ProbeResult} whose
 *          `ok` flag drives alerting in src/lib/ops/heartbeat.ts.
 * @author  Hermia
 * @created 2026-06-11
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient } from "@/lib/db";

/**
 * The outcome of running a single probe.
 */
export interface ProbeResult {
    /** Stable probe identifier (matches {@link ProbeSpec.name}). */
    name: string;
    /** True when the checked dependency is healthy. */
    ok: boolean;
    /** Human-readable one-line status, shown in the Telegram alert. */
    message: string;
    /** Optional structured detail for console logging / debugging. */
    detail?: unknown;
}

/**
 * Declarative description of a probe: its identity, category, severity, and
 * the async function that performs the check.
 */
export interface ProbeSpec {
    /** Stable probe identifier. */
    name: string;
    /** Grouping bucket used only for reporting. */
    category: "infra" | "process" | "cron";
    /**
     * When true, a failure triggers a business-hours-bypassing critical
     * Telegram alert. When false, the failure is informational and only
     * surfaces during business hours.
     */
    critical: boolean;
    /** The check. Must resolve (never reject) to a {@link ProbeResult}. */
    probe: () => Promise<ProbeResult>;
}

/** Supabase client type (nullable when env vars are missing). */
type SupabaseClientOrNull = ReturnType<typeof createClient>;

/**
 * Race a promise against a timeout. Rejects with a labelled Error if `ms`
 * elapses before the wrapped promise settles.
 *
 * @param work  The promise to bound.
 * @param ms    Timeout budget in milliseconds.
 * @param label Used in the timeout error message.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
        work.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/**
 * Resolve a single-row freshness query and return the most recent timestamp
 * (ISO string) found in `column`, or null when no rows / no client.
 *
 * @param db        Supabase client (may be null).
 * @param table     Table to query.
 * @param column    Timestamp column to read + order by.
 * @param filter    Optional `(query) => query` to narrow the result set.
 */
async function latestTimestamp(
    db: SupabaseClientOrNull,
    table: string,
    column: string,
    filter?: (q: any) => any,
): Promise<string | null> {
    if (!db) return null;
    let query = db.from(table).select(column).order(column, { ascending: false }).limit(1);
    if (filter) query = filter(query);
    const { data, error } = await query;
    if (error || !data || data.length === 0) return null;
    const row = data[0] as Record<string, unknown>;
    const value = row[column];
    return typeof value === "string" ? value : null;
}

/** Age in minutes between now and an ISO timestamp. */
function ageMinutes(iso: string): number {
    return Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
}

/** Age in hours between now and an ISO timestamp. */
function ageHours(iso: string): number {
    return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

// ── Infra probes (critical) ──────────────────────────────────────────────

/**
 * Probe: Supabase reachability. Confirms a client can be constructed and a
 * trivial single-row read against `agent_heartbeats` completes within 5s.
 */
async function probeSupabasePing(): Promise<ProbeResult> {
    const name = "supabase-ping";
    const db = createClient();
    if (!db) {
        return { name, ok: false, message: "Client null — Supabase env missing" };
    }
    try {
        const { error } = await withTimeout(
            Promise.resolve(db.from("agent_heartbeats").select("id").limit(1)),
            5000,
            name,
        );
        if (error) {
            return { name, ok: false, message: `Query error: ${error.message}`, detail: error };
        }
        return { name, ok: true, message: "OK" };
    } catch (err) {
        return { name, ok: false, message: errMsg(err), detail: err };
    }
}

/**
 * Probe: Finale API reachability. Issues a basic-auth GET to the Facilities
 * endpoint with an 8s timeout. Any non-2xx response or timeout is unhealthy.
 */
async function probeFinaleApi(): Promise<ProbeResult> {
    const name = "finale-api";
    const key = process.env.FINALE_API_KEY;
    const secret = process.env.FINALE_API_SECRET;
    const accountPath = process.env.FINALE_ACCOUNT_PATH;
    if (!key || !secret) {
        return { name, ok: false, message: "FINALE_API_KEY / FINALE_API_SECRET missing" };
    }
    if (!accountPath) {
        return { name, ok: false, message: "FINALE_ACCOUNT_PATH missing" };
    }
    const base = (process.env.FINALE_BASE_URL || "https://app.finaleinventory.com").replace(/\/+$/, "");
    const url = `${base}/${accountPath}/api/graphql`;
    const auth = Buffer.from(`${key}:${secret}`).toString("base64");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        // Lightweight GraphQL introspection query — just ask for __typename
        // to confirm the endpoint is reachable + auth is valid.
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: "{ __typename }" }),
            signal: controller.signal,
        });
        if (!res.ok) {
            return { name, ok: false, message: `HTTP ${res.status}`, detail: { status: res.status } };
        }
        return { name, ok: true, message: "OK" };
    } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        return {
            name,
            ok: false,
            message: aborted ? "Timeout after 8000ms" : errMsg(err),
            detail: err,
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Build a Gmail OAuth token-file probe for the given filename.
 *
 * @param name     Probe name.
 * @param fileName Token file (relative to CWD) to read + validate.
 */
function gmailTokenProbe(name: string, fileName: string): () => Promise<ProbeResult> {
    return async (): Promise<ProbeResult> => {
        const filePath = path.join(process.cwd(), fileName);
        try {
            const raw = await fs.readFile(filePath, "utf8");
            const parsed = JSON.parse(raw) as { access_token?: string; refresh_token?: string };
            const hasToken =
                (typeof parsed.access_token === "string" && parsed.access_token.length > 0) ||
                (typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0);
            if (!hasToken) {
                return { name, ok: false, message: `${fileName} has no access/refresh token` };
            }
            return { name, ok: true, message: "OK" };
        } catch (err) {
            const missing = err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
            return {
                name,
                ok: false,
                message: missing ? `${fileName} missing` : errMsg(err),
                detail: err,
            };
        }
    };
}

/**
 * Probe: dashboard HTTP liveness. Tries `/api/health`, falling back to
 * `/api/command-board/heartbeats` when health returns 404. Non-2xx (after the
 * fallback) or timeout is unhealthy.
 */
async function probeDashboardHttp(): Promise<ProbeResult> {
    const name = "dashboard-http";
    const candidates = [
        "http://localhost:3001/api/health",
        "http://localhost:3001/api/command-board/heartbeats",
    ];
    let lastDetail: unknown;
    for (let i = 0; i < candidates.length; i++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(candidates[i], { method: "GET", signal: controller.signal });
            if (res.ok) {
                return { name, ok: true, message: "OK" };
            }
            // Only fall through to the next candidate on a 404 from /api/health.
            if (res.status === 404 && i < candidates.length - 1) {
                lastDetail = { url: candidates[i], status: res.status };
                continue;
            }
            return { name, ok: false, message: `HTTP ${res.status}`, detail: { url: candidates[i], status: res.status } };
        } catch (err) {
            const aborted = err instanceof Error && err.name === "AbortError";
            lastDetail = err;
            if (i === candidates.length - 1) {
                return { name, ok: false, message: aborted ? "Timeout after 5000ms" : errMsg(err), detail: err };
            }
        } finally {
            clearTimeout(timer);
        }
    }
    return { name, ok: false, message: "Unreachable", detail: lastDetail };
}

// ── Process probes ───────────────────────────────────────────────────────

/**
 * Probe: aria-bot process liveness via its `agent_heartbeats` row. The bot
 * stamps a heartbeat every 5 min; a row age over 15 min (3x grace) is unhealthy.
 */
async function probeBotAlive(): Promise<ProbeResult> {
    const name = "bot-alive";
    const db = createClient();
    if (!db) return { name, ok: false, message: "Client null — Supabase env missing" };
    try {
        const ts = await withTimeout(
            latestTimestamp(db, "agent_heartbeats", "heartbeat_at", (q) => q.eq("agent_name", "aria-bot")),
            5000,
            name,
        );
        if (!ts) return { name, ok: false, message: "No aria-bot heartbeat row found" };
        const age = ageMinutes(ts);
        if (age > 15) {
            return { name, ok: false, message: `Last heartbeat ${age}min ago (>15min)`, detail: { ts, age } };
        }
        return { name, ok: true, message: `OK (${age}min ago)` };
    } catch (err) {
        return { name, ok: false, message: errMsg(err), detail: err };
    }
}

/**
 * Probe: aria-slack poller liveness via its `agent_heartbeats` row. Stamps
 * every ~1 min; row age over 5 min is unhealthy. A missing row is treated as
 * OK (Slack may be intentionally unregistered when env is unset).
 */
async function probeSlackPollerAlive(): Promise<ProbeResult> {
    const name = "slack-poller-alive";
    const db = createClient();
    if (!db) return { name, ok: false, message: "Client null — Supabase env missing" };
    try {
        const ts = await withTimeout(
            latestTimestamp(db, "agent_heartbeats", "heartbeat_at", (q) => q.eq("agent_name", "aria-slack")),
            5000,
            name,
        );
        if (!ts) return { name, ok: true, message: "No aria-slack row — not registered (OK)" };
        const age = ageMinutes(ts);
        if (age > 5) {
            return { name, ok: false, message: `Last heartbeat ${age}min ago (>5min)`, detail: { ts, age } };
        }
        return { name, ok: true, message: `OK (${age}min ago)` };
    } catch (err) {
        return { name, ok: false, message: errMsg(err), detail: err };
    }
}

// ── Cron freshness probes (informational) ────────────────────────────────

/**
 * Build a `cron_runs` freshness probe.
 *
 * @param name      Probe name.
 * @param taskName  `cron_runs.task_name` to look up.
 * @param maxAgeHrs Maximum tolerated age (hours) of the most recent run.
 * @param opts      Optional `weekdaysOnly` to skip the check on Sat/Sun.
 */
function cronFreshnessProbe(
    name: string,
    taskName: string,
    maxAgeHrs: number,
    opts: { weekdaysOnly?: boolean } = {},
): () => Promise<ProbeResult> {
    return async (): Promise<ProbeResult> => {
        if (opts.weekdaysOnly) {
            const dow = new Date().getDay(); // 0 = Sun, 6 = Sat
            if (dow === 0 || dow === 6) {
                return { name, ok: true, message: "Weekend — not scheduled (OK)" };
            }
        }
        const db = createClient();
        if (!db) return { name, ok: false, message: "Client null — Supabase env missing" };
        try {
            const ts = await withTimeout(
                latestTimestamp(db, "cron_runs", "started_at", (q) => q.eq("task_name", taskName)),
                5000,
                name,
            );
            if (!ts) return { name, ok: false, message: `No ${taskName} run recorded` };
            const hrs = ageHours(ts);
            if (hrs > maxAgeHrs) {
                const display = maxAgeHrs >= 2 ? `${hrs.toFixed(1)}h` : `${Math.round(hrs * 60)}min`;
                return {
                    name,
                    ok: false,
                    message: `Last run ${display} ago (>${maxAgeHrs}h)`,
                    detail: { ts, hrs },
                };
            }
            return { name, ok: true, message: `OK (${hrs.toFixed(1)}h ago)` };
        } catch (err) {
            return { name, ok: false, message: errMsg(err), detail: err };
        }
    };
}

/** Normalize any thrown value to a string message. */
function errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

/**
 * The complete, ordered registry of system heartbeat probes. Consumed by
 * `runSystemHeartbeat()` in src/lib/ops/heartbeat.ts.
 */
export const HEARTBEAT_PROBES: ProbeSpec[] = [
    // Infra (critical)
    { name: "supabase-ping", category: "infra", critical: true, probe: probeSupabasePing },
    { name: "finale-api", category: "infra", critical: true, probe: probeFinaleApi },
    { name: "gmail-default-token", category: "infra", critical: true, probe: gmailTokenProbe("gmail-default-token", "token-default.json") },
    { name: "gmail-ap-token", category: "infra", critical: true, probe: gmailTokenProbe("gmail-ap-token", "ap-token.json") },
    { name: "dashboard-http", category: "infra", critical: true, probe: probeDashboardHttp },
    // Process
    { name: "bot-alive", category: "process", critical: true, probe: probeBotAlive },
    { name: "slack-poller-alive", category: "process", critical: false, probe: probeSlackPollerAlive },
    // Cron freshness (informational)
    { name: "ap-polling-fresh", category: "cron", critical: false, probe: cronFreshnessProbe("ap-polling-fresh", "ap-polling", 20) },
    { name: "build-risk-fresh", category: "cron", critical: false, probe: cronFreshnessProbe("build-risk-fresh", "build-risk", 26, { weekdaysOnly: true }) },
    { name: "email-tracking-ingest-fresh", category: "cron", critical: false, probe: cronFreshnessProbe("email-tracking-ingest-fresh", "email-tracking-ingest", 4) },
];
