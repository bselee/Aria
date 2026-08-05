/**
 * @file    client.ts
 * @purpose LTL Select Invoice Center API client: Auth0 password grant + paginated
 *          invoice fetch. Auth and endpoints verified live 2026-08-05.
 *
 *          Auth:  POST https://{AUTH0_DOMAIN}/oauth/token (password grant)
 *          Data:  GET  {API_BASE}/shipments/invoice?pageSize=20&pageNumber=N&...
 *                 pageSize MUST be ≤ 20, pageNumber ≥ 1 (25/0 → "Page size or
 *                 page number out of range").
 * @author  Hermia
 * @created 2026-08-05
 * @deps    types.ts
 * @env     LTLSELECT_USER, LTLSELECT_PASS, LTLSELECT_AUTH0_DOMAIN,
 *          LTLSELECT_CLIENT_ID, LTLSELECT_AUDIENCE, LTLSELECT_API_BASE
 */

import type { LtlSelectInvoice, LtlSelectInvoicePage } from "./types";

// ── Env / config ─────────────────────────────────────────────────────────────

export interface LtlSelectEnv {
    username: string;
    password: string;
    auth0Domain: string;
    clientId: string;
    audience: string;
    apiBase: string;
}

/**
 * Read LTL Select credentials from the process environment.
 *
 * @throws Error listing every missing variable (never echoes values).
 */
export function loadLtlSelectEnv(env: NodeJS.ProcessEnv = process.env): LtlSelectEnv {
    const required: Array<[keyof LtlSelectEnv, string]> = [
        ["username", "LTLSELECT_USER"],
        ["password", "LTLSELECT_PASS"],
        ["auth0Domain", "LTLSELECT_AUTH0_DOMAIN"],
        ["clientId", "LTLSELECT_CLIENT_ID"],
        ["audience", "LTLSELECT_AUDIENCE"],
        ["apiBase", "LTLSELECT_API_BASE"],
    ];
    const missing = required
        .filter(([, name]) => !env[name])
        .map(([, name]) => name);
    if (missing.length > 0) {
        throw new Error(`Missing LTL Select env: ${missing.join(", ")} (see .env.local)`);
    }
    const read = (name: string): string => env[name] as string;
    return {
        username: read("LTLSELECT_USER"),
        password: read("LTLSELECT_PASS"),
        auth0Domain: read("LTLSELECT_AUTH0_DOMAIN"),
        clientId: read("LTLSELECT_CLIENT_ID"),
        audience: read("LTLSELECT_AUDIENCE"),
        apiBase: read("LTLSELECT_API_BASE").replace(/\/+$/, ""),
    };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Exchange username/password for a Bearer access token via the Auth0
 * password grant (works for the LTL Select SPA client).
 *
 * @throws Error with status code on non-OK auth response.
 */
export async function getLtlSelectToken(env: LtlSelectEnv): Promise<string> {
    const url = `https://${env.auth0Domain}/oauth/token`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "password",
            username: env.username,
            password: env.password,
            client_id: env.clientId,
            audience: env.audience,
            scope: "openid profile email",
        }),
        signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LTL Select auth failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) {
        throw new Error("LTL Select auth returned no access_token");
    }
    return data.access_token;
}

// ── Invoice fetch ────────────────────────────────────────────────────────────

export interface FetchInvoicesOptions {
    /** Inclusive start date, YYYY-MM-DD. */
    dateFrom: string;
    /** Inclusive end date, YYYY-MM-DD. */
    dateTo: string;
    /** Page size — clamped to the API's 1..20 range. Default 20. */
    pageSize?: number;
    /** JS getTimezoneOffset() minutes (360 = US Mountain). Default 360. */
    userTimezoneOffset?: number;
    /** Safety cap on pages fetched. Default 50 (1000 rows). */
    maxPages?: number;
}

export interface FetchInvoicesResult {
    invoices: LtlSelectInvoice[];
    totalCount: number;
}

/**
 * Fetch all Invoice Center rows for a date range, following pagination.
 *
 * @throws Error on non-OK page responses (message includes status + snippet).
 */
export async function fetchLtlSelectInvoices(
    token: string,
    env: LtlSelectEnv,
    options: FetchInvoicesOptions,
): Promise<FetchInvoicesResult> {
    const pageSize = Math.min(20, Math.max(1, options.pageSize ?? 20));
    const timezoneOffset = options.userTimezoneOffset ?? 360;
    const maxPages = options.maxPages ?? 50;

    const invoices: LtlSelectInvoice[] = [];
    let totalCount = 0;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
        const params = new URLSearchParams({
            pageSize: String(pageSize),
            pageNumber: String(pageNumber),
            userTimezoneOffset: String(timezoneOffset),
            dateFrom: options.dateFrom,
            dateTo: options.dateTo,
        });
        const url = `${env.apiBase}/shipments/invoice?${params.toString()}`;

        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
                `LTL Select invoice fetch failed (${res.status}): ${text.slice(0, 200)}`,
            );
        }

        const page = (await res.json()) as LtlSelectInvoicePage;
        const list = Array.isArray(page?.list) ? page.list : [];
        totalCount = typeof page?.totalCount === "number" ? page.totalCount : 0;
        invoices.push(...list);

        // Stop when we've pulled everything the server reported, or an empty page.
        if (list.length === 0 || invoices.length >= totalCount) break;
    }

    return { invoices, totalCount };
}
