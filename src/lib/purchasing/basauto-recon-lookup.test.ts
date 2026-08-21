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
import { buildReconBadgeMap, readReconBadges } from "./basauto-recon-lookup";

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
});

describe("readReconBadges", () => {
    it("returns an empty map when the report file is absent", () => {
        expect(readReconBadges("C:/definitely/not/a/real/aria/dir").size).toBe(0);
    });
});
