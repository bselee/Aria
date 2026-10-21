/**
 * @file    src/cli/ordering-divergence.ts
 * @purpose Read-only divergence report for the ordering engine's sibling
 *          velocity paths. Joins the cached resale scan and the cached BOM
 *          scan per SKU and prints, side by side:
 *
 *            dailyRate (chosen)  · receipts (purchaseVelocity)  ·
 *            BOM-derived (totalBurnRate, BOM path only)  · dailyRateSource
 *
 *          Flags a SKU when:
 *            (a) either path's chosen dailyRate exceeds 3x its physical
 *                signal (ledger when dailyRateSource === 'ledger', else
 *                receipts) — the reality cap from the rice-bran bug should
 *                make this impossible; or
 *            (b) the resale and BOM paths disagree by more than 3x on the
 *                same SKU — the sibling-paths cohesion gap this CLI is the
 *                verification instrument for (Phase 3 sibling sweep).
 *
 *          READ-ONLY: reads .aria-cache/purchasing/purchasing-{resale,bom}.json
 *          produced by the dashboard scan scheduler (src/lib/purchasing/cache.ts).
 *          Never calls Finale.
 *
 * @author  Hermia
 * @created 2026-10-21
 * @deps    fs, path (no Finale, no DB)
 * @env     ARIA_PURCHASING_CACHE_DIR (optional override)
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

/** One path's velocity signals as persisted on a cached PurchasingItem. */
export interface DivergenceInputRow {
    productId: string;
    dailyRate?: number | null;
    dailyRateSource?: string | null;
    purchaseVelocity?: number | null;
    totalBurnRate?: number | null;
}

export interface DivergenceRow {
    productId: string;
    resaleRate: number | null;
    resaleSource: string | null;
    bomRate: number | null;
    bomSource: string | null;
    receipts: number | null;
    /** >3x reality-cap breach on the resale path. */
    resaleCapBreach: boolean;
    /** >3x reality-cap breach on the BOM path. */
    bomCapBreach: boolean;
    /** The two paths' chosen rates disagree by more than 3x. */
    crossPathDivergence: boolean;
    flagged: boolean;
}

export const DIVERGENCE_FACTOR = 3;

function fin(n: unknown): number | null {
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** Receipts may legitimately be zero (no purchase history) — keep the 0. */
function receiptsOf(n: unknown): number | null {
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Physical signal for a path. Precedence:
 *   1. stock ledger (data/stock-ledger-cache-90.json) — physical consumption,
 *      the same source the engine's velocity chooser trusts (2026-10-21 fix)
 *   2. when the chosen rate came from the ledger, the rate IS the ledger
 *   3. receipts — lumpy purchase history, the last resort
 * A zero-ledger row falls back cleanly; nothing to breach when all absent.
 */
function physicalSignal(
    row: DivergenceInputRow,
    chosen: number | null,
    ledgerRate: number | null,
): number | null {
    if (ledgerRate != null && ledgerRate > 0) return ledgerRate;
    if (row.dailyRateSource === "ledger") return chosen;
    if (fin(row.purchaseVelocity) != null) return fin(row.purchaseVelocity);
    return chosen;
}

function breaches(chosen: number | null, physical: number | null): boolean {
    if (chosen == null || physical == null) return false;
    return chosen > DIVERGENCE_FACTOR * physical;
}

/**
 * Core analysis — pure, fixture-testable. Join resale + BOM rows per SKU and
 * evaluate both divergence signals.
 */
export function analyzeDivergence(
    resaleRows: DivergenceInputRow[],
    bomRows: DivergenceInputRow[],
    ledgerBySku?: Map<string, number>,
): DivergenceRow[] {
    const bomBySku = new Map(bomRows.map((r) => [r.productId, r]));
    const skus = new Set<string>([...resaleRows.map((r) => r.productId), ...bomRows.map((r) => r.productId)]);
    const out: DivergenceRow[] = [];

    for (const sku of skus) {
        const resale = resaleRows.find((r) => r.productId === sku) ?? null;
        const bom = bomBySku.get(sku) ?? null;

        const resaleRate = fin(resale?.dailyRate);
        const bomRate = fin(bom?.dailyRate);
        const receipts = receiptsOf(resale?.purchaseVelocity) ?? receiptsOf(bom?.purchaseVelocity);
        const ledgerRate = ledgerBySku?.get(sku) ?? null;

        const resalePhys = physicalSignal(resale ?? { productId: sku }, resaleRate, ledgerRate);
        const bomPhys = physicalSignal(bom ?? { productId: sku }, bomRate, ledgerRate);

        const resaleCapBreach = breaches(resaleRate, resalePhys);
        const bomCapBreach = breaches(bomRate, bomPhys);
        const crossPathDivergence =
            resaleRate != null && bomRate != null &&
            (Math.max(resaleRate, bomRate) > DIVERGENCE_FACTOR * Math.min(resaleRate, bomRate));

        out.push({
            productId: sku,
            resaleRate,
            resaleSource: resale?.dailyRateSource ?? null,
            bomRate,
            bomSource: bom?.dailyRateSource ?? null,
            receipts,
            resaleCapBreach,
            bomCapBreach,
            crossPathDivergence,
            flagged: resaleCapBreach || bomCapBreach || crossPathDivergence,
        });
    }
    return out.sort((a, b) => Number(b.flagged) - Number(a.flagged) || a.productId.localeCompare(b.productId));
}

interface CachedSnapshot { value?: Array<{ items?: DivergenceInputRow[] }> }

function loadSnapshot(path: string): DivergenceInputRow[] {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CachedSnapshot;
    return (parsed.value ?? []).flatMap((g) => g.items ?? []);
}

/** Stock-ledger snapshot: sku -> 90d physical daily rate. Optional — the CLI
 *  still works (receipts fallback) when the cache file is absent. */
function loadLedgerRates(cacheDir: string): Map<string, number> | undefined {
    const file = join(cacheDir, "..", "..", "data", "stock-ledger-cache-90.json");
    if (!existsSync(file)) return undefined;
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { bySku?: Record<string, { dailyRate?: number }> };
        const map = new Map<string, number>();
        for (const [sku, entry] of Object.entries(parsed.bySku ?? {})) {
            if (typeof entry?.dailyRate === "number" && Number.isFinite(entry.dailyRate) && entry.dailyRate > 0) {
                map.set(sku, entry.dailyRate);
            }
        }
        return map.size > 0 ? map : undefined;
    } catch {
        return undefined;
    }
}

function n(v: number | null): string {
    return v == null ? "—" : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2);
}

async function main(): Promise<void> {
    const cacheDir = process.env.ARIA_PURCHASING_CACHE_DIR
        ?? join(process.cwd(), ".aria-cache", "purchasing");
    const resale = loadSnapshot(join(cacheDir, "purchasing-resale.json"));
    const bom = loadSnapshot(join(cacheDir, "purchasing-bom.json"));
    if (resale.length === 0 && bom.length === 0) {
        console.error(`No cached scans found in ${cacheDir} — run a dashboard scan first.`);
        process.exit(1);
    }

    const rows = analyzeDivergence(resale, bom, loadLedgerRates(cacheDir));
    const flagged = rows.filter((r) => r.flagged);

    console.log(`ordering-divergence — resale items ${resale.length}, bom items ${bom.length}, joined SKUs ${rows.length}`);
    console.log(`flagged: ${flagged.length}\n`);
    if (flagged.length > 0) {
        console.log("SKU | resale rate (src) | bom rate (src) | receipts | signals");
        for (const r of flagged) {
            const signals: string[] = [];
            if (r.resaleCapBreach) signals.push("resale>3x-physical");
            if (r.bomCapBreach) signals.push("bom>3x-physical");
            if (r.crossPathDivergence) signals.push("paths>3x-apart");
            console.log(
                `${r.productId} | ${n(r.resaleRate)} (${r.resaleSource ?? "—"}) | ` +
                `${n(r.bomRate)} (${r.bomSource ?? "—"}) | ${n(r.receipts)} | ${signals.join(", ")}`,
            );
        }
    } else {
        console.log("No >3x divergence on any joined SKU.");
    }
    process.exit(flagged.length > 0 ? 1 : 0);
}

const isEntrypoint = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;

if (isEntrypoint) {
    main().catch((e: unknown) => {
        console.error("ERR", (e as Error).message);
        process.exit(1);
    });
}
