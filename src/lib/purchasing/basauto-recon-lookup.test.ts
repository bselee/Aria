/**
 * @file    src/lib/purchasing/basauto-recon-lookup.test.ts
 * @purpose Contract tests for the basauto recon badge lookup — proves the map
 *          keys on SKU (not productId, the bug that hid GLP117 from a lookup)
 *          and that malformed reports degrade silently instead of throwing.
 *
 * @author  Hermia
 * @created 2026-08-21
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildReconBadgeMap, extractMissingFlags, readReconBadges } from "./basauto-recon-lookup";

describe("buildReconBadgeMap", () => {
    const report = {
        crawledAt: "2026-08-21T15:15:37.670Z",
        items: [
            {
                sku: "GLP117",
                verdict: "QTY_MISMATCH",
                severity: "medium",
                reason: "Both flag it but quantities disagree: basauto 191 vs Aria 80 (58% apart).",
                basauto: { reorderQty: 191, urgency: "Overdue" },
            },
            {
                sku: "ALK101",
                verdict: "OVERBUY_RISK",
                severity: "high",
                reason: "Aria counts PO #125215 basauto cannot see. Do not re-buy.",
                basauto: { reorderQty: 277, urgency: "Overdue" },
            },
        ],
    };

    it("keys on uppercased sku", () => {
        const map = buildReconBadgeMap(report);
        expect(map.get("GLP117")?.basautoQty).toBe(191);
        expect(map.get("GLP117")?.verdict).toBe("QTY_MISMATCH");
        expect(map.size).toBe(2);
    });

    it("normalizes lowercase and padded skus", () => {
        const map = buildReconBadgeMap({ items: [{ sku: " glp117 ", basauto: { reorderQty: 5 } }] });
        expect(map.get("GLP117")?.basautoQty).toBe(5);
    });

    it("preserves the reason text so the row can explain the disagreement", () => {
        expect(buildReconBadgeMap(report).get("ALK101")?.reason).toContain("Do not re-buy");
    });

    it("defaults unknown severity to medium", () => {
        const map = buildReconBadgeMap({ items: [{ sku: "X1", severity: "bogus" }] });
        expect(map.get("X1")?.severity).toBe("medium");
    });

    it("keeps high and low severities intact", () => {
        const map = buildReconBadgeMap({
            items: [
                { sku: "H", severity: "high" },
                { sku: "L", severity: "low" },
            ],
        });
        expect(map.get("H")?.severity).toBe("high");
        expect(map.get("L")?.severity).toBe("low");
    });

    it("returns an empty map for null, empty, or item-less reports", () => {
        expect(buildReconBadgeMap(null).size).toBe(0);
        expect(buildReconBadgeMap(undefined).size).toBe(0);
        expect(buildReconBadgeMap({}).size).toBe(0);
        expect(buildReconBadgeMap({ items: [] }).size).toBe(0);
    });

    it("skips items with no sku rather than creating a blank key", () => {
        const map = buildReconBadgeMap({ items: [{ verdict: "AGREE" }, { sku: "", verdict: "AGREE" }] });
        expect(map.size).toBe(0);
    });

    it("nulls a non-numeric basauto qty instead of coercing it", () => {
        const map = buildReconBadgeMap({
            items: [{ sku: "A", basauto: { reorderQty: null } }, { sku: "B", basauto: null }],
        });
        expect(map.get("A")?.basautoQty).toBeNull();
        expect(map.get("B")?.basautoQty).toBeNull();
    });

    it("carries the crawl timestamp onto each badge so rows can show snapshot age", () => {
        const map = buildReconBadgeMap(report);
        expect(map.get("GLP117")?.crawledAt).toBe("2026-08-21T15:15:37.670Z");
        expect(map.get("ALK101")?.crawledAt).toBe("2026-08-21T15:15:37.670Z");
    });

    it("leaves crawledAt null when the report lacks one", () => {
        expect(buildReconBadgeMap({ items: [{ sku: "X1" }] }).get("X1")?.crawledAt).toBeNull();
    });

    it("carries the basauto-side snapshot so verdicts can be re-derived live", () => {
        const map = buildReconBadgeMap({
            items: [{
                sku: "GLP117",
                verdict: "QTY_MISMATCH",
                basauto: { reorderQty: 191, urgency: "Overdue", stockDaysLeft: 3, reorderDate: "2026-08-25", velocity: 4.2, onOrder: 0 },
            }],
        });
        const b = map.get("GLP117");
        expect(b?.basauto?.reorderQty).toBe(191);
        expect(b?.basauto?.velocity).toBe(4.2);
        expect(b?.basauto?.onOrder).toBe(0);
        expect(b?.basauto?.stockDaysLeft).toBe(3);
    });
});

describe("extractMissingFlags", () => {
    it("collects MISSING_IN_ARIA items only, high severity first", () => {
        const flags = extractMissingFlags({
            crawledAt: "2026-08-24T13:00:00.000Z",
            items: [
                { sku: "MID", verdict: "MISSING_IN_ARIA", severity: "medium", vendor: "V1", reason: "r-mid", basauto: { urgency: "Soon", reorderQty: 5, stockDaysLeft: 20 } },
                { sku: "ROWED", verdict: "AGREE", severity: "low" },
                { sku: "HIGH", verdict: "MISSING_IN_ARIA", severity: "high", vendor: "V2", reason: "r-high", basauto: { urgency: "Overdue", reorderQty: 181, stockDaysLeft: 0 } },
                { sku: "LOW", verdict: "MISSING_IN_ARIA", severity: "low", reason: "r-low", basauto: { urgency: "OK" } },
            ],
        });
        expect(flags.map(f => f.sku)).toEqual(["HIGH", "MID", "LOW"]);
        expect(flags[0].reason).toBe("r-high");
        expect(flags[0].vendor).toBe("V2");
        expect(flags[0].crawledAt).toBe("2026-08-24T13:00:00.000Z");
    });

    it("returns an empty list for null or item-less reports", () => {
        expect(extractMissingFlags(null)).toEqual([]);
        expect(extractMissingFlags({ items: [] })).toEqual([]);
    });
});

describe("readReconBadges", () => {
    it("returns an empty badge map when the report file is absent", () => {
        const res = readReconBadges("C:/definitely/not/a/real/aria/dir");
        expect(res.badges.size).toBe(0);
        expect(res.stale).toBe(true);
        expect(res.crawledAt).toBeNull();
    });

    it("reads a report from data/basauto-recon.json and reports freshness", () => {
        const dir = mkdtempSync(join(tmpdir(), "recon-lookup-"));
        try {
            const dataDir = join(dir, "data");
            mkdirSync(dataDir);
            writeFileSync(
                join(dataDir, "basauto-recon.json"),
                JSON.stringify({
                    crawledAt: new Date().toISOString(),
                    items: [{ sku: "A1", verdict: "AGREE", basauto: { reorderQty: 4 } }],
                }),
            );
            const res = readReconBadges(dir);
            expect(res.badges.get("A1")?.basautoQty).toBe(4);
            expect(res.stale).toBe(false);
            expect(res.crawledAt).toBeTruthy();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("flags an old report as stale", () => {
        const dir = mkdtempSync(join(tmpdir(), "recon-lookup-"));
        try {
            const dataDir = join(dir, "data");
            mkdirSync(dataDir);
            writeFileSync(
                join(dataDir, "basauto-recon.json"),
                JSON.stringify({
                    crawledAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
                    items: [],
                }),
            );
            expect(readReconBadges(dir).stale).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
