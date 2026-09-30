/**
 * @file    src/lib/finale/stock-ledger.ts
 * @purpose Physical consumption from Finale's stock movement ledger
 *          (`stockHistoryViewConnection`). This is the determination source for
 *          purchasing: it does NOT depend on Finale's per-product reorder
 *          configuration (`reorderQuantityToOrder`) or its product-level
 *          velocity fields, both of which read zero on job supplies and
 *          unconfigured SKUs while the SKU is actively being consumed.
 *
 *          Bill's directive (2026-09-30): "our determination should not be
 *          based upon Finale's reorder quantity... that is a complete miss."
 *
 *          Net consumption per SKU = sum over consumption transaction types of
 *          (unitsOut - unitsIn). `Transfer` is internal between facilities and
 *          `Purchase shipment` is receipts, so neither counts as consumption.
 *
 *          One paged pass over the whole ledger, cached to disk so the
 *          purchasing scan does not pay ~100s on every cycle. Read-only.
 *
 * @author  Hermia
 * @created 2026-09-30
 * @deps    (none — native fetch; own env reads so both lib and CLI can use it)
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 *          STOCK_LEDGER_DAYS (default 90), STOCK_LEDGER_MAX_AGE_MIN (default 240)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/** Transaction types that represent consumption or goods leaving the building. */
export const LEDGER_CONSUME_TYPES: ReadonlySet<string> = new Set([
    "Build",
    "Stock change or take",
    "Sale shipment",
    "Return shipment",
]);

/** Default look-back window for the consumption rate, in days. */
export const LEDGER_DEFAULT_DAYS = 90;

/** Default cache staleness before a refresh is attempted, in minutes. */
export const LEDGER_DEFAULT_MAX_AGE_MIN = 240;

const PAGE_SIZE = 500;

export interface LedgerSku {
    sku: string;
    /** Net units consumed over the window (gross out minus paired in). */
    net: number;
    /** Gross units out over the window, before paired reversal. */
    gross: number;
    /** Ledger rows contributing to this SKU. */
    rows: number;
    /** Most recent consumption date (YYYY-MM-DD), or "". */
    lastDate: string;
    /** net / days — the consumption rate the purchasing decision should use. */
    dailyRate: number;
}

export interface LedgerSnapshot {
    generatedAt: string;
    days: number;
    pages: number;
    ledgerRows: number;
    bySku: Record<string, LedgerSku>;
}

interface FetchDeps {
    apiBase?: string;
    accountPath?: string;
    authHeader?: string;
}

function resolveDeps(deps?: FetchDeps): FetchDeps {
    const apiKey = process.env.FINALE_API_KEY || "";
    const apiSecret = process.env.FINALE_API_SECRET || "";
    return {
        apiBase: deps?.apiBase || process.env.FINALE_BASE_URL || "https://app.finaleinventory.com",
        accountPath: deps?.accountPath ?? process.env.FINALE_ACCOUNT_PATH ?? "",
        authHeader: deps?.authHeader || `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
    };
}

function toNumber(value: unknown): number {
    if (value === null || value === undefined || value === "" || value === "--") return 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function cachePath(days: number): string {
    return join(process.cwd(), "data", `stock-ledger-cache-${days}.json`);
}

interface LedgerGqlResponse {
    errors?: Array<{ message?: string }>;
    data?: {
        stockHistoryViewConnection?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            edges?: Array<{
                node?: {
                    transactionType?: string | null;
                    recordDate?: string | null;
                    unitsIn?: string | number | null;
                    unitsOut?: string | number | null;
                    product?: { productId?: string | null } | null;
                } | null;
            } | null>;
        } | null;
    } | null;
}

/**
 * Page the entire stock movement ledger for a rolling window and aggregate net
 * consumption per SKU.
 *
 * @param days        Look-back window in days.
 * @param deps        Optional connection overrides (tests / custom clients).
 * @param onProgress  Optional progress callback, called once per page.
 * @returns           Aggregated snapshot of consumption by SKU.
 */
export async function fetchLedgerSnapshot(
    days: number = LEDGER_DEFAULT_DAYS,
    deps?: FetchDeps,
    onProgress?: (info: { page: number; ledgerRows: number; skus: number }) => void,
): Promise<LedgerSnapshot> {
    const { apiBase, accountPath, authHeader } = resolveDeps(deps);

    const now = new Date();
    const begin = new Date(now);
    begin.setDate(begin.getDate() - days);
    const beginStr = begin.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const endStr = new Date(now.getTime() + 86_400_000).toLocaleDateString("en-CA", {
        timeZone: "America/Denver",
    });

    const bySku: Record<string, LedgerSku> = {};
    let cursor: string | null = null;
    let pages = 0;
    let ledgerRows = 0;

    for (;;) {
        const after = cursor ? `, after: "${cursor}"` : "";
        const query = `{ stockHistoryViewConnection(first: ${PAGE_SIZE}${after}
            recordDate: { begin: "${beginStr}", end: "${endStr}" }) {
            pageInfo { hasNextPage endCursor }
            edges { node { transactionType recordDate unitsIn unitsOut product { productId } } }
        } }`;

        const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: "POST",
            headers: { Authorization: authHeader!, "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
            signal: AbortSignal.timeout(90_000),
        });
        const json = (await res.json()) as LedgerGqlResponse;
        if (json?.errors?.length) {
            throw new Error(`stockHistoryViewConnection failed: ${String(json.errors[0]?.message).slice(0, 200)}`);
        }
        const conn = json?.data?.stockHistoryViewConnection;
        if (!conn) throw new Error("stockHistoryViewConnection returned no connection");

        for (const edge of conn.edges || []) {
            const node = edge?.node || {};
            ledgerRows++;
            const sku = String(node.product?.productId || "").trim();
            if (!sku) continue;
            const type = String(node.transactionType || "?");
            if (!LEDGER_CONSUME_TYPES.has(type)) continue;

            const out = Math.abs(toNumber(node.unitsOut));
            const incoming = toNumber(node.unitsIn);
            const record = node.recordDate ? String(node.recordDate).slice(0, 10) : "";

            let entry = bySku[sku];
            if (!entry) {
                entry = { sku, net: 0, gross: 0, rows: 0, lastDate: "", dailyRate: 0 };
                bySku[sku] = entry;
            }
            entry.gross += out;
            entry.net += out - incoming;
            entry.rows++;
            if (record > entry.lastDate) entry.lastDate = record;
        }

        pages++;
        onProgress?.({ page: pages, ledgerRows, skus: Object.keys(bySku).length });
        if (!conn.pageInfo?.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
        // Gentle on Finale: it rate-limits hard and upsets the app for staff.
        await new Promise(r => setTimeout(r, 250));
    }

    for (const entry of Object.values(bySku)) {
        entry.dailyRate = entry.net / days;
    }

    return {
        generatedAt: new Date().toISOString(),
        days,
        pages,
        ledgerRows,
        bySku,
    };
}

/**
 * Read the cached ledger snapshot when it is present and fresh, otherwise
 * refetch. A stale-but-present cache is returned if the refresh fails, so a
 * transient Finale outage degrades to slightly old data instead of no data.
 *
 * @param days         Look-back window in days.
 * @param options      maxAgeMinutes / forceRefresh / onProgress / deps.
 * @returns            Ledger snapshot (never null; throws only on cold failure).
 */
export async function getLedgerSnapshot(
    days: number = LEDGER_DEFAULT_DAYS,
    options?: {
        maxAgeMinutes?: number;
        forceRefresh?: boolean;
        deps?: FetchDeps;
        onProgress?: (info: { page: number; ledgerRows: number; skus: number }) => void;
    },
): Promise<LedgerSnapshot> {
    const maxAgeMin = options?.maxAgeMinutes
        ?? (process.env.STOCK_LEDGER_MAX_AGE_MIN ? Number(process.env.STOCK_LEDGER_MAX_AGE_MIN) : LEDGER_DEFAULT_MAX_AGE_MIN);
    const file = cachePath(days);

    let cached: LedgerSnapshot | null = null;
    if (existsSync(file)) {
        try {
            cached = JSON.parse(readFileSync(file, "utf-8")) as LedgerSnapshot;
        } catch { cached = null; }
    }

    const fresh = cached
        && cached.days === days
        && cached.generatedAt
        && (Date.now() - Date.parse(cached.generatedAt)) < maxAgeMin * 60_000;

    if (cached && fresh && !options?.forceRefresh) return cached;

    try {
        const snapshot = await fetchLedgerSnapshot(days, options?.deps, options?.onProgress);
        try {
            mkdirSync(join(process.cwd(), "data"), { recursive: true });
            writeFileSync(file, JSON.stringify(snapshot));
        } catch { /* cache write is best-effort */ }
        return snapshot;
    } catch (err) {
        if (cached) {
            console.warn(`[stock-ledger] refresh failed, serving cached snapshot from ${cached.generatedAt}: ${(err as Error).message}`);
            return cached;
        }
        throw err;
    }
}

/**
 * Consumption rate for one SKU from a snapshot.
 *
 * @param snapshot  Ledger snapshot.
 * @param sku       Product id.
 * @returns         Net consumption per day, or 0 when the SKU has no consumption.
 */
export function ledgerRateFor(snapshot: LedgerSnapshot | null | undefined, sku: string): number {
    const entry = snapshot?.bySku?.[sku];
    return entry && entry.dailyRate > 0 ? entry.dailyRate : 0;
}

/**
 * Net consumption for one SKU from a snapshot.
 *
 * @param snapshot  Ledger snapshot.
 * @param sku       Product id.
 * @returns         Net units consumed over the window, or 0.
 */
export function ledgerNetFor(snapshot: LedgerSnapshot | null | undefined, sku: string): number {
    const entry = snapshot?.bySku?.[sku];
    return entry && entry.net > 0 ? entry.net : 0;
}
