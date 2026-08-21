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
 * @author  Hermia
 * @created 2026-08-21
 * @deps    fs, path (reads data/basauto-recon.json — same file the panel uses)
 * @env     none
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

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
        });
    }
    return map;
}

/**
 * Read the recon report from disk and return the SKU→badge lookup.
 *
 * Never throws: a missing, stale, or malformed report yields an empty map so
 * the Ordering panel degrades to its previous Finale→Aria display rather than
 * failing the whole request.
 *
 * @param cwd Optional working directory override (tests).
 * @returns SKU→badge map, empty when unavailable.
 */
export function readReconBadges(cwd: string = process.cwd()): Map<string, ReconBadge> {
    try {
        const path = join(cwd, "data", "basauto-recon.json");
        if (!existsSync(path)) return new Map();
        return buildReconBadgeMap(JSON.parse(readFileSync(path, "utf-8")) as ReconReportShape);
    } catch {
        return new Map();
    }
}
