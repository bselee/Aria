/**
 * @file    src/lib/purchasing/basauto-recon-lookup.ts
 * @purpose Read the basauto↔Aria reconciliation report from disk and expose a
 *          per-SKU lookup so the Ordering panel can show the THIRD opinion
 *          (basauto) alongside Finale and Aria on the row itself.
 *
 *          Context: src/lib/purchasing/basauto-recon.ts produces the report and
 *          /api/dashboard/basauto-recon serves it to its own panel. But the
 *          Ordering panel row only ever showed "Finale: N → Aria: M", so a SKU
 *          where basauto disagrees with BOTH (e.g. GLP117: basauto 191,
 *          Finale 129, Aria 80) looked like a simple two-way divergence. This
 *          module makes the third number joinable without a second HTTP hop.
 *
 *          Reliability (2026-08-24): the report is written by a daily 07:00
 *          cron, so the join used to silently serve whatever was on disk — the
 *          panel showed Friday's verdicts next to live Finale numbers with no
 *          hint they were 3 days old. readReconBadges() now returns the crawl
 *          timestamp + a stale flag (same 30h TTL as the recon API route), and
 *          caches the parsed report keyed on file mtime so the 70KB JSON is not
 *          re-parsed on every Ordering GET.
 *
 * @author  Hermia
 * @created 2026-08-21
 * @deps    fs, path (reads data/basauto-recon.json — same file the panel uses)
 * @env     none
 */

import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

/** A report older than this is flagged stale (cron runs daily at 07:00 MT). */
export const STALE_AFTER_MS = 30 * 60 * 60 * 1000;

/** The subset of a recon item the Ordering row needs. */
export interface ReconBadge {
    /** basauto's own recommended reorder quantity. */
    basautoQty: number | null;
    /** basauto urgency string (Overdue | Urgent | Soon | OK | PURCHASE). */
    basautoUrgency: string | null;
    /** Reconciliation verdict, e.g. QTY_MISMATCH / OVERBUY_RISK / ARIA_ONLY. */
    verdict: string;
    severity: "high" | "medium" | "low";
    /** Human-readable explanation of WHY the two disagree. */
    reason: string;
    /** When the recon crawl ran — surfaces the snapshot's age on the row. */
    crawledAt: string | null;
}

/** Result of one report read: the per-SKU map plus its freshness. */
export interface ReconLookupResult {
    badges: Map<string, ReconBadge>;
    crawledAt: string | null;
    stale: boolean;
}

/** Report shape we depend on — deliberately loose, the file is produced elsewhere. */
interface ReconReportShape {
    crawledAt?: string;
    items?: Array<{
        sku?: string;
        verdict?: string;
        severity?: string;
        reason?: string;
        basauto?: { reorderQty?: number | null; urgency?: string | null } | null;
    }>;
}

/**
 * Build a SKU→badge map from an already-parsed recon report.
 *
 * Pure and exported separately so tests don't need the filesystem.
 *
 * @param report Parsed contents of data/basauto-recon.json.
 * @returns Map keyed by UPPERCASED sku. Empty map when the report has no items.
 */
export function buildReconBadgeMap(report: ReconReportShape | null | undefined): Map<string, ReconBadge> {
    const map = new Map<string, ReconBadge>();
    if (!report?.items?.length) return map;

    const crawledAt = typeof report.crawledAt === "string" ? report.crawledAt : null;

    for (const item of report.items) {
        const sku = (item?.sku ?? "").trim().toUpperCase();
        if (!sku) continue;

        const severity = item.severity === "high" || item.severity === "low" ? item.severity : "medium";

        map.set(sku, {
            basautoQty: typeof item.basauto?.reorderQty === "number" ? item.basauto.reorderQty : null,
            basautoUrgency: item.basauto?.urgency ?? null,
            verdict: item.verdict ?? "UNKNOWN",
            severity,
            reason: item.reason ?? "",
            crawledAt,
        });
    }
    return map;
}

/**
 * Read the recon report from disk and return the SKU→badge lookup plus its
 * freshness (crawl timestamp + stale flag).
 *
 * Never throws: a missing, stale, or malformed report yields an empty badge
 * map (with `stale: true`) so the Ordering panel degrades to its previous
 * Finale→Aria display rather than failing the whole request — but the panel
 * can now SAY the third opinion is stale instead of hiding it.
 *
 * Module-level cache keyed on file mtime: the dashboard GETs this on every
 * Ordering fetch (SWR + manual Re-scan), so the ~70KB JSON is parsed only
 * when the file actually changes.
 *
 * @param cwd Optional working directory override (tests).
 * @returns Badge map + freshness; empty map when unavailable.
 */
export function readReconBadges(cwd: string = process.cwd()): ReconLookupResult {
    try {
        const path = join(cwd, "data", "basauto-recon.json");
        if (!existsSync(path)) return EMPTY_RESULT;

        const mtimeMs = statSync(path).mtimeMs;
        if (!_cache || _cache.mtimeMs !== mtimeMs) {
            const report = JSON.parse(readFileSync(path, "utf-8")) as ReconReportShape;
            const crawledAt = typeof report.crawledAt === "string" ? report.crawledAt : null;
            const ageMs = crawledAt ? Date.now() - new Date(crawledAt).getTime() : Number.POSITIVE_INFINITY;
            _cache = {
                mtimeMs,
                result: {
                    badges: buildReconBadgeMap(report),
                    crawledAt,
                    stale: !Number.isFinite(ageMs) || ageMs > STALE_AFTER_MS,
                },
            };
        }
        return _cache.result;
    } catch {
        return EMPTY_RESULT;
    }
}

const EMPTY_RESULT: ReconLookupResult = { badges: new Map(), crawledAt: null, stale: true };

let _cache: { mtimeMs: number; result: ReconLookupResult } | null = null;
