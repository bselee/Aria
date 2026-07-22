/**
 * @file    src/lib/ops/postgrest-ready.ts
 * @purpose Wait for local PostgREST to accept real queries before bot boot
 *          continues into control-plane / cron work. Stops boot race against
 *          WSL Docker cold starts (503 / ECONNREFUSED storms).
 * @author  Hermia
 * @created 2026-07-13
 * @deps    none (uses fetch + env)
 * @env     PGRST_URL | NEXT_PUBLIC_SUPABASE_URL | SUPABASE_URL
 *          PGRST_JWT_SECRET | SUPABASE_SERVICE_ROLE_KEY (optional JWT)
 */

import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";

export type PostgrestReadyState = "ACTIVE" | "COMING_UP" | "UNKNOWN" | "MISSING_URL";

export interface WaitForPostgrestOptions {
    /** Max total wait before giving up (ms). Default 90s. */
    timeoutMs?: number;
    /** Delay between probes (ms). Default 2s. */
    intervalMs?: number;
    /** Optional logger (default console). */
    log?: (msg: string) => void;
    /** Table used for a real query probe. Default agent_heartbeats. */
    probeTable?: string;
}

function getBaseUrl(): string | null {
    const raw =
        process.env.PGRST_URL ||
        process.env.NEXT_PUBLIC_SUPABASE_URL ||
        process.env.SUPABASE_URL ||
        "";
    if (!raw.trim()) return null;
    return raw.replace(/\/rest\/v1\/?$/i, "").replace(/\/+$/, "");
}

function getAuthToken(): string {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "mock-key";
    if (key.split(".").length === 3) return key;
    const secret =
        process.env.PGRST_JWT_SECRET || "aria-local-dev-secret-not-for-production";
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url",
    );
    const payload = Buffer.from(
        JSON.stringify({ role: "anon", iss: "postgrest", exp: 9999999999 }),
    ).toString("base64url");
    const sig = crypto
        .createHmac("sha256", secret)
        .update(`${header}.${payload}`)
        .digest("base64url");
    return `${header}.${payload}.${sig}`;
}


/**
 * HTTP GET helper using Node's native http/https modules.
 * Avoids undici/fetch incompatibility with PostgREST's Haskell/Warp
 * server (observed as "SocketError: other side closed" on Windows).
 */
function nodeHttpGet(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; ok: boolean }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const mod = parsed.protocol === "https:" ? https : http;
        const req = mod.get(
            url,
            { headers, timeout: timeoutMs },
            (res) => {
                // Consume body so connection can be reused
                res.resume();
                resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400 });
            },
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
}

/**
 * Single readiness probe: OpenAPI root + authenticated 1-row table query.
 * ACTIVE only when table query returns 2xx (not just TCP open / OpenAPI).
 */
export async function probePostgrestReady(
    _fetchImpl?: typeof fetch,
    probeTable = "agent_heartbeats",
): Promise<PostgrestReadyState> {
    const base = getBaseUrl();
    if (!base) return "MISSING_URL";

    try {
        const root = await nodeHttpGet(`${base}/`, { Accept: "application/json" }, 4000);

        if (root.status === 503) return "COMING_UP";
        if (!(root.ok || root.status === 401)) return "UNKNOWN";

        const token = getAuthToken();
        const q = await nodeHttpGet(
            `${base}/${probeTable}?limit=1`,
            { Accept: "application/json", apikey: token, Authorization: `Bearer ${token}` },
            5000,
        );

        if (q.status === 503) return "COMING_UP";
        if (q.ok || q.status === 206 || q.status === 401 || q.status === 404) {
            // 404 table missing still means PostgREST is up
            return "ACTIVE";
        }
        return "UNKNOWN";
    } catch {
        return "UNKNOWN";
    }
}

/**
 * Block until PostgREST accepts queries, or timeout.
 * Returns final state. Does not throw.
 */
export async function waitForPostgrestReady(
    opts: WaitForPostgrestOptions = {},
): Promise<{ ready: boolean; state: PostgrestReadyState; waitedMs: number }> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const log = opts.log ?? ((m: string) => console.log(m));
    const probeTable = opts.probeTable ?? "agent_heartbeats";
    const started = Date.now();

    let state = await probePostgrestReady(fetch, probeTable);
    if (state === "ACTIVE") {
        log(`[boot] PostgREST ready (${state})`);
        return { ready: true, state, waitedMs: 0 };
    }
    if (state === "MISSING_URL") {
        log("[boot] PostgREST URL missing — skipping readiness wait");
        return { ready: false, state, waitedMs: 0 };
    }

    log(`[boot] Waiting for PostgREST (state=${state}, timeout=${timeoutMs}ms)...`);
    while (Date.now() - started < timeoutMs) {
        await new Promise((r) => setTimeout(r, intervalMs));
        state = await probePostgrestReady(fetch, probeTable);
        if (state === "ACTIVE") {
            const waitedMs = Date.now() - started;
            log(`[boot] PostgREST ready after ${waitedMs}ms`);
            return { ready: true, state, waitedMs };
        }
        log(`[boot] PostgREST still ${state}...`);
    }

    const waitedMs = Date.now() - started;
    log(`[boot] PostgREST not ready after ${waitedMs}ms (last=${state}) — continuing degraded`);
    return { ready: false, state, waitedMs };
}
