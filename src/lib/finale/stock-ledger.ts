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
 *          The rate is SPLIT BY MOVEMENT KIND, because they mean different
 *          things (HERMIA 2026-10-13, the MFG-audit incident):
 *
 *            DEMAND     Build, Sale shipment      -> may set a daily rate
 *            ADJUSTMENT Stock change or take,     -> stock position only;
 *                       Return shipment              sets a rate only when
 *                                                    recurring and no demand
 *          `Transfer` is internal between facilities and `Purchase shipment` is
 *          receipts, so neither counts. A one-off manual correction is a
 *          write-off, and amortizing it over the window invented order lines:
 *          a single 3,003-unit MFG-audit removal (S-12230) read as 33.4/day and
 *          raised a CRITICAL 4,000-unit order for packaging no longer used.
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

/**
 * Transaction types that represent real demand: goods consumed by a build or
 * sold to a customer. These are the only types allowed to set a consumption
 * rate.
 */
export const LEDGER_DEMAND_TYPES: ReadonlySet<string> = new Set([
    "Build",
    "Sale shipment",
]);

/**
 * Manual inventory corrections. The crew completes these constantly, so they
 * change the stock position but they are NOT demand: a cycle count, an MFG
 * audit write-off, a stock-take, or a return all arrive as `Stock change or
 * take` / `Return shipment`. Counting them as a rate annualizes a single
 * correction into ongoing demand (S-12230: one 3,003-unit write-off became
 * 33.4/day and a CRITICAL order line), which is what this module now refuses
 * to do.
 */
export const LEDGER_ADJUST_TYPES: ReadonlySet<string> = new Set([
    "Stock change or take",
    "Return shipment",
]);

/**
 * Union of both sets: everything that moves units out of stock. Kept as the
 * "what left the building" set; it is NOT the rate basis any more.
 */
export const LEDGER_CONSUME_TYPES: ReadonlySet<string> = new Set([
    ...LEDGER_DEMAND_TYPES,
    ...LEDGER_ADJUST_TYPES,
]);

/**
 * Distinct adjustment days required before a manual correction may stand in
 * for demand on a SKU with no Build/Sale movement. One correction is a
 * write-off we cannot distinguish from a take; several on different days is
 * the crew restocking a consumable (tape, boxes, gloves) the way they really
 * use it.
 */
export const LEDGER_MIN_ADJUST_DAYS = 2;

/** Bumped whenever the aggregation changes, so a stale disk cache refetches once. */
export const LEDGER_SNAPSHOT_VERSION = 2;

/** Default look-back window for the consumption rate, in days. */
export const LEDGER_DEFAULT_DAYS = 90;

/** Default cache staleness before a refresh is attempted, in minutes. */
export const LEDGER_DEFAULT_MAX_AGE_MIN = 240;

const PAGE_SIZE = 500;

export interface LedgerSku {
    sku: string;
    /** Net units moved out over the window across ALL movement types. */
    net: number;
    /** Gross units out over the window, before paired reversal. */
    gross: number;
    /** Ledger rows contributing to this SKU. */
    rows: number;
    /** Most recent movement date (YYYY-MM-DD), or "". */
    lastDate: string;
    /** net / days — the rate the purchasing decision should use. */
    dailyRate: number;
    /** Net units over Build + Sale shipment only: the demand fact. */
    demandNet: number;
    /** Net units over manual corrections (take / return) only. */
    adjustNet: number;
    /** Manual-correction rows for this SKU. */
    adjustRows: number;
    /** Distinct calendar days carrying a manual correction. */
    adjustDays: number;
    /** adjustNet / days, regardless of whether it was allowed to set dailyRate. */
    adjustRate: number;
}

export interface LedgerSnapshot {
    generatedAt: string;
    /** Aggregation shape version — see LEDGER_SNAPSHOT_VERSION. */
    version: number;
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
 * Decide the consumption rate for one SKU from its split movement.
 *
 * HERMIA(2026-10-13 — the MFG audit incident): a manual correction is not a
 * demand rate. The rule, in order:
 *
 *   1. Any real demand (Build / Sale shipment) sets the rate on its own.
 *      Manual corrections never add to it, so a one-day audit write-off cannot
 *      become ongoing demand: S-12230 read as 33.4/day from a single 3,003-unit
 *      removal. The same contamination on live raws was smaller but real —
 *      RAWMALIBUCOMPOST read 14% high (790.8/d vs 677.5/d).
 *   2. With no demand, a manual correction may stand in for consumption ONLY
 *      when it is recurring (>= LEDGER_MIN_ADJUST_DAYS distinct days), which is
 *      how the crew restock tape, boxes and gloves. A single correction is a
 *      write-off we cannot tell apart from a take, so it yields no rate.
 *
 * The one case this cannot see (a single-day take on a SKU that still has
 * stock) is handled by ledgerRateFor, which the caller passes stock into.
 *
 * @param entry  Movement split for the SKU.
 * @param days   Window length in days.
 * @returns      Units per day.
 */
export function deriveLedgerRate(
    entry: Pick<LedgerSku, "demandNet" | "adjustNet" | "adjustDays">,
    days: number,
): number {
    if (days <= 0) return 0;
    if (entry.demandNet > 0) return entry.demandNet / days;
    if (entry.adjustNet > 0 && entry.adjustDays >= LEDGER_MIN_ADJUST_DAYS) {
        return entry.adjustNet / days;
    }
    return 0;
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
    /**
     * Distinct days carrying a manual correction, keyed by SKU. Held outside
     * LedgerSku on purpose: the snapshot is JSON.stringify'd to disk, and a Set
     * would serialize to {} and silently lose the day count.
     */
    const adjustDaySet: Record<string, Set<string>> = {};
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
                entry = {
                    sku, net: 0, gross: 0, rows: 0, lastDate: "", dailyRate: 0,
                    demandNet: 0, adjustNet: 0, adjustRows: 0, adjustDays: 0, adjustRate: 0,
                };
                bySku[sku] = entry;
            }
            const delta = out - incoming;
            entry.gross += out;
            entry.net += delta;
            entry.rows++;
            if (LEDGER_DEMAND_TYPES.has(type)) {
                entry.demandNet += delta;
            } else {
                // Manual correction: changes the stock position, not demand.
                entry.adjustNet += delta;
                entry.adjustRows++;
                (adjustDaySet[sku] ??= new Set<string>()).add(record);
            }
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
        entry.adjustDays = adjustDaySet[entry.sku]?.size ?? 0;
        entry.adjustRate = days > 0 ? entry.adjustNet / days : 0;
        entry.dailyRate = deriveLedgerRate(entry, days);
    }

    return {
        generatedAt: new Date().toISOString(),
        version: LEDGER_SNAPSHOT_VERSION,
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
        && cached.version === LEDGER_SNAPSHOT_VERSION
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
 * @param snapshot     Ledger snapshot.
 * @param sku          Product id.
 * @param opts         stockOnHand lets a single-day manual correction still
 *                     count when the SKU kept stock — a take, not a write-off.
 *                     Omit it (CLIs) to get the conservative rate.
 * @returns            Consumption per day, or 0 when the SKU genuinely has none.
 */
export function ledgerRateFor(
    snapshot: LedgerSnapshot | null | undefined,
    sku: string,
    opts?: { stockOnHand?: number | null },
): number {
    const entry = snapshot?.bySku?.[sku];
    if (!entry) return 0;
    if (entry.dailyRate > 0) return entry.dailyRate;
    // One correction day that left stock behind is a working take, not a
    // write-off. Keep the rate so a real consumable cannot silently leave the
    // board; a write-off lands on 0 stock and stays excluded.
    if (
        entry.adjustRate > 0
        && entry.adjustDays === 1
        && (opts?.stockOnHand ?? 0) > 0
    ) {
        return entry.adjustRate;
    }
    return 0;
}

/**
 * Net units behind the consumption rate for one SKU.
 *
 * Mirrors deriveLedgerRate so the candidate gate and the rate can never
 * disagree: demand when there is any, otherwise a RECURRING manual correction.
 * A lone write-off returns 0 and no longer admits the SKU to the pipeline.
 *
 * The stock-dependent half of the rule (a single-day take that left stock on
 * the shelf) is deliberately omitted here: the candidate gate runs before stock
 * is fetched. Such SKUs carry a reorder quantity and are admitted by that path,
 * and ledgerRateFor applies the stock test once stock is known.
 *
 * @param snapshot  Ledger snapshot.
 * @param sku       Product id.
 * @returns         Net consumption over the window, or 0 when there is no basis.
 */
export function ledgerNetFor(snapshot: LedgerSnapshot | null | undefined, sku: string): number {
    const entry = snapshot?.bySku?.[sku];
    if (!entry) return 0;
    if (entry.demandNet > 0) return entry.demandNet;
    if (entry.adjustNet > 0 && entry.adjustDays >= LEDGER_MIN_ADJUST_DAYS) return entry.adjustNet;
    return 0;
}
