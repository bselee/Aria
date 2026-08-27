/**
 * @file    active-purchases-status.test.ts
 * @purpose Regression guard for the cached-status vocabulary bug: po-sync's
 *          normalizePOStatus() rewrites Finale "Committed" -> "open", so the
 *          Active Purchases status gate must accept BOTH vocabularies. When it
 *          only accepted ["committed","completed"], every cached PO was dropped
 *          and the dashboard column rendered empty ("0 active of 500 Finale POs
 *          (fromCache=true)") while ?bust=1 returned 19.
 * @author  Hermia
 * @created 2026-08-27
 * @deps    vitest
 * @env     none — pure logic assertions, no DB or network
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
    join(process.cwd(), "src/lib/purchasing/active-purchases.ts"),
    "utf8",
);
const CACHE_SRC = readFileSync(
    join(process.cwd(), "src/lib/purchasing/po-cache.ts"),
    "utf8",
);

/** Extract the ACTIVE_STATUSES set literal from the source. */
function activeStatuses(): string[] {
    const m = /const ACTIVE_STATUSES = new Set\(\[([\s\S]*?)\]\)/.exec(SRC);
    if (!m) throw new Error("ACTIVE_STATUSES set not found in active-purchases.ts");
    return [...m[1].matchAll(/"([a-z]+)"/g)].map(x => x[1]);
}

describe("active-purchases status gate", () => {
    it("accepts Finale's raw vocabulary", () => {
        const s = activeStatuses();
        expect(s).toContain("committed");
        expect(s).toContain("completed");
    });

    it("accepts po-sync's normalized vocabulary — the cached-path bug", () => {
        // normalizePOStatus(): "Committed" -> "open". Without this the cached
        // branch yields zero active POs and the column renders empty.
        const s = activeStatuses();
        expect(s).toContain("open");
        expect(s).toContain("partial");
    });

    it("excludes the terminal normalized 'received' bucket", () => {
        // "received" is Completed/Received. Only ~134 of 949 such cached rows
        // carry a receive_date, so isHighConfidenceReceived() cannot exit them
        // and settled POs leak back in (observed 67 vs Finale's 19).
        expect(activeStatuses()).not.toContain("received");
    });

    it("uses the set for the gate rather than a re-introduced inline array", () => {
        expect(SRC).toMatch(/if \(!ACTIVE_STATUSES\.has\(status\)\) continue;/);
        expect(SRC).not.toMatch(/\[\s*"committed",\s*"completed"\s*\]\.includes\(status\)/);
    });
});

describe("po-cache readCachedPos windowing", () => {
    it("orders by issue_date, not updated_at", () => {
        // A cache-wide refresh stamps ~1,300 rows with a near-identical
        // updated_at, making that ordering arbitrary: 538 rows sorted ahead of
        // PO 125235 and pushed live POs past the limit(500) cutoff.
        expect(CACHE_SRC).toMatch(/\.order\("issue_date", \{ ascending: false \}\)/);
        expect(CACHE_SRC).not.toMatch(
            /\.select\("\*"\)[\s\S]{0,120}\.order\("updated_at", \{ ascending: false \}\)[\s\S]{0,40}\.limit\(500\)/,
        );
    });

    it("filters terminal rows and honours the daysBack window", () => {
        expect(CACHE_SRC).toMatch(/\.neq\("status", "closed"\)/);
        expect(CACHE_SRC).toMatch(/\.gte\("issue_date", cutoff\)/);
        expect(CACHE_SRC).toMatch(/readCachedPos\(daysBack\)/);
    });
});
