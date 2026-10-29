/**
 * @file    src/app/api/dashboard/swallowed-error-guard.test.ts
 * @purpose Tripwire against the recurring "swallowed PostgREST read" class.
 *
 *          WHY THIS EXISTS
 *          ---------------
 *          `createClient()` from `@/lib/db` RESOLVES `{ data, error }` instead
 *          of throwing, so a query that fails (a mistyped column → 42703, a
 *          dropped table, an expired approval) returns `data: null` and the
 *          route, if it never reads `.error`, serves a confident clean payload.
 *          This class bit three times in one day (2026-10-29): active-purchases
 *          `tracking_paused`/`tracking_source`, invoice `line_items`, and the
 *          `invoice-pdf` route. It always reads as a "blank panel" — the worst
 *          failure mode, because nobody notices.
 *
 *          This test scans every dashboard route that reads PostgREST and FAILS
 *          if one performs a read without ANY error handling (`.error` read or a
 *          `degraded[]` surface). The few known-unguarded routes live in
 *          `KNOWN_UNGUARDED` so the suite stays green today; each one is a
 *          migration ticket (route them through `po-truth` / surface `degraded`).
 *          When a route is migrated, REMOVE it from `KNOWN_UNGUARDED` — the test
 *          also fails if a listed route stops being unguarded, so the list cannot
 *          rot silently.
 *
 * @author  Hermia
 * @created 2026-10-29
 * @deps    node:fs, node:url (test-only)
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Routes that read PostgREST but do not yet read `.error` / surface `degraded`.
 * Each entry is an open migration ticket; remove it once the route is guarded.
 */
const KNOWN_UNGUARDED: string[] = [
    "budget-status/route.ts",
    "pending-approvals/route.ts",
];

const DASHBOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

interface Scan {
    route: string;
    reads: number;
    hasErrorCheck: boolean;
}

function scanRoutes(): Scan[] {
    const out: Scan[] = [];
    for (const dir of readdirSync(DASHBOARD_DIR)) {
        const routePath = path.join(DASHBOARD_DIR, dir, "route.ts");
        let src: string;
        try {
            src = readFileSync(routePath, "utf8");
        } catch {
            continue; // not a route dir
        }
        const reads = (src.match(/\.from\(\s*["'`]/g) ?? []).length;
        if (reads === 0) continue;
        const hasErrorCheck = /\.error\b|degraded/.test(src);
        out.push({ route: `${dir}/route.ts`, reads, hasErrorCheck });
    }
    return out;
}

describe("dashboard swallowed-error guard", () => {
    it("every PostgREST-reading route checks `.error` or surfaces `degraded`", () => {
        const routes = scanRoutes();
        const unguarded = routes.filter((r) => !r.hasErrorCheck).map((r) => r.route);

        for (const u of unguarded) {
            expect(
                KNOWN_UNGUARDED,
                `route ${u} reads PostgREST with no error handling. Route it through ` +
                    `po-truth / surface degraded[], then remove it from KNOWN_UNGUARDED.`,
            ).toContain(u);
        }
    });

    it("the KNOWN_UNGUARDED baseline does not rot — every listed route is still unguarded", () => {
        const unguarded = new Set(
            scanRoutes()
                .filter((r) => !r.hasErrorCheck)
                .map((r) => r.route),
        );
        for (const k of KNOWN_UNGUARDED) {
            expect(
                unguarded.has(k),
                `route ${k} is listed as unguarded but now handles errors — remove it from KNOWN_UNGUARDED.`,
            ).toBe(true);
        }
    });
});
