/**
 * @file    src/lib/purchasing/packed-shelf-credit.test.ts
 * @purpose Pin the packed-FG shelf credit end to end (Bill, 2026-10-29):
 *          BAS Auto sized WDG101 at "order 22" while 420 packed WDG104 + 11
 *          cases of WDG204 sat on the rack. Packed FG is already-bought raw.
 *          The candidate must derive FG coverage and a combined runway from the
 *          feed entries, and the engine must hold a hybrid (resale-bom) item
 *          whose combined runway covers lead + safety — while still ordering a
 *          genuinely short item.
 *
 * @author  Hermia
 * @created 2026-10-29
 * @deps    bom-demand, policy-candidates, policy-engine, invoice-pool
 */
import { describe, expect, it } from "vitest";

import { derivePackedShelfCredit } from "../finale/bom-demand";
import { buildPurchasingCandidate } from "./policy-candidates";
import { assessPurchasingCandidate } from "./policy-engine";
import type { PurchasingItem } from "../finale/client";
import { isSelfReferentialIdentity } from "./invoice-pool";

function item(overrides: Partial<PurchasingItem>): PurchasingItem {
    return {
        supplierName: "Clarke",
        productId: "WDG101",
        productName: "AquaBAC-WDG 3000 - (25lb)",
        stockOnHand: 8.28,
        stockOnOrder: 0,
        dailyRate: 0.1867,
        demandVelocity: 0.12,
        salesVelocity: 0,
        leadTimeDays: 11,
        effectiveLeadTimeDays: 11,
        adjustedRunwayDays: 44.36,
        suggestedQty: 0,
        itemType: "resale-bom",
        ...overrides,
    } as PurchasingItem;
}

const WDG_FEEDS = [
    { sku: "WDG104", name: "AquaBAC 8oz", dailySalesRate: 0.544, buildsWorth: 25.3, qtyPerUnit: 0.008, stockOnHand: 420 },
    { sku: "WDG204", name: "AquaBAC case", dailySalesRate: 0.133, buildsWorth: 8.6, qtyPerUnit: 0.096, stockOnHand: 11 },
];

describe("derivePackedShelfCredit", () => {
    it("computes coverage from the soonest-stocked-out FG and raw-equivalents from qtyPerUnit", () => {
        const credit = derivePackedShelfCredit(WDG_FEEDS);
        expect(credit.coverageDays).not.toBeNull();
        expect(credit.coverageDays!).toBeCloseTo(11 / 0.133, 0); // WDG204 is the binding shelf
        expect(credit.packedRawEquivalent).not.toBeNull();
        expect(credit.packedRawEquivalent!).toBeCloseTo(420 * 0.008 + 11 * 0.096, 5);
        expect(credit.fgDrivenDailyRaw!).toBeCloseTo(0.544 * 0.008 + 0.133 * 0.096, 5);
    });

    it("returns nulls when no feed carries stock (legacy behavior)", () => {
        const credit = derivePackedShelfCredit([{ dailySalesRate: 0.5, qtyPerUnit: 0.1 }]);
        expect(credit.coverageDays).toBeNull();
        expect(credit.packedRawEquivalent).toBeNull();
        expect(credit.fgDrivenDailyRaw).toBeNull();
    });

    it("still computes coverage when qtyPerUnit is missing but stock is known", () => {
        const credit = derivePackedShelfCredit([{ dailySalesRate: 2, stockOnHand: 90 }]);
        expect(credit.coverageDays).toBe(45);
        expect(credit.packedRawEquivalent).toBeNull();
    });
});

describe("buildPurchasingCandidate shelf credit", () => {
    it("derives finishedGoodsCoverageDays and combinedRunwayDays from feed entries", () => {
        const candidate = buildPurchasingCandidate(item({ feedsFinishedGoods: WDG_FEEDS }));
        expect(candidate.finishedGoodsCoverageDays).not.toBeNull();
        expect(candidate.finishedGoodsCoverageDays!).toBeGreaterThan(80);
        expect(candidate.combinedRunwayDays).not.toBeNull();
        // 8.28 raw + 4.368 packed-equiv = 12.65 raw units over 0.1867/d ≈ 68d
        expect(candidate.combinedRunwayDays!).toBeGreaterThan(50);
    });

    it("leaves both null when feeds carry no stock", () => {
        const candidate = buildPurchasingCandidate(item({}));
        expect(candidate.finishedGoodsCoverageDays).toBeNull();
        expect(candidate.combinedRunwayDays).toBeNull();
    });
});

describe("assessPurchasingCandidate suppression", () => {
    it("holds a hybrid item whose packed FG shelf covers the order point (WDG101 class)", () => {
        const candidate = buildPurchasingCandidate(item({
            feedsFinishedGoods: WDG_FEEDS,
            suggestedQty: 22,
            totalBurnRate: 0.1867,
        }));
        const assessment = assessPurchasingCandidate(candidate);
        expect(assessment.decision).toBe("hold");
        expect(assessment.reasonCodes).toContain("fg_coverage_sufficient");
        expect(assessment.explanation).toContain("Combined runway");
    });

    it("does not suppress an item whose combined runway is below the order point", () => {
        const candidate = buildPurchasingCandidate(item({
            stockOnHand: 1,
            adjustedRunwayDays: 5,
            feedsFinishedGoods: [
                { sku: "FG1", name: "FG", dailySalesRate: 10, buildsWorth: 1, qtyPerUnit: 0.1, stockOnHand: 3 },
            ],
            suggestedQty: 40,
        }));
        const assessment = assessPurchasingCandidate(candidate);
        expect(assessment.reasonCodes).not.toContain("fg_coverage_sufficient");
    });

    it("still suppresses a pure-BOM item on FG coverage alone (legacy path)", () => {
        const candidate = buildPurchasingCandidate(item({
            demandVelocity: 0.5,
            feedsFinishedGoods: [],
        }));
        // No stock data on feeds → coverage null → legacy path not via combined;
        // force coverage through the context-shaped field on the candidate.
        const withCoverage = {
            ...candidate,
            directDemand: 0,
            bomDemand: 0.5,
            suggestedQty: 10,
            finishedGoodsCoverageDays: 92,
        };
        const assessment = assessPurchasingCandidate(withCoverage);
        expect(assessment.reasonCodes).toContain("fg_coverage_sufficient");
    });
});

describe("isSelfReferentialIdentity", () => {
    it("flags PO125393 against PO 125393", () => {
        expect(isSelfReferentialIdentity("PO125393", "125393")).toBe(true);
        expect(isSelfReferentialIdentity("PO 125271", "125271")).toBe(true);
    });

    it("keeps real invoice identities", () => {
        expect(isSelfReferentialIdentity("215047605", "125429")).toBe(false);
        expect(isSelfReferentialIdentity("KM-098970", "124868")).toBe(false);
        expect(isSelfReferentialIdentity("PO125393", "999999")).toBe(false);
        expect(isSelfReferentialIdentity(null, "125393")).toBe(false);
    });
});
