/**
 * @file    src/lib/purchasing/basauto-recon.test.ts
 * @purpose Unit tests for the basauto ↔ Aria reconciliation verdict logic.
 *          Pure functions only — no network, no Finale, no DB.
 *
 * @author  Hermia
 * @created 2026-08-21
 * @deps    vitest, src/lib/purchasing/basauto-recon.ts
 * @env     none
 */

import { describe, it, expect } from "vitest";
import {
    type BasautoRecord,
    type AriaItemLite,
    assessBasautoItem,
    buildReconReport,
    normalizeSku,
    toNumber,
} from "./basauto-recon";

function bas(overrides: Partial<BasautoRecord> = {}): BasautoRecord {
    return {
        productId: "RAWGYPSUM",
        description: "Diamond K Gypsum By The Pound",
        supplier: "Diamond K Gypsum",
        urgency: "OK",
        unitsInStock: 13978,
        stockDaysLeft: 100,
        reorderQty: 0,
        reorderDate: null,
        onOrder: 0,
        quantityInDrafts: 0,
        supplierLeadDays: 10,
        velocity: 100,
        lastReceived: null,
        quantity: null,
        averageBuildConsumption: null,
        ...overrides,
    };
}

function aria(overrides: Partial<AriaItemLite> = {}): AriaItemLite {
    return {
        productId: "RAWGYPSUM",
        urgency: "ok",
        stockOnHand: 13978,
        stockOnOrder: 0,
        dailyRate: 111.54,
        dailyRateSource: "demand",
        leadTimeDays: 15,
        effectiveLeadTimeDays: 15,
        adjustedRunwayDays: 125.3,
        runwayDays: 125.3,
        openPOs: [],
        suggestedQty: 0,
        assessmentDecision: "hold",
        assessmentRecommendedQty: 0,
        supplierName: "Diamond K Gypsum",
        ...overrides,
    };
}

describe("normalizeSku / toNumber", () => {
    it("normalizes case and whitespace", () => {
        expect(normalizeSku(" rawgypsum ")).toBe("RAWGYPSUM");
        expect(normalizeSku(null)).toBe("");
    });
    it("parses numbers including comma strings and rejects junk", () => {
        expect(toNumber("1,234")).toBe(1234);
        expect(toNumber(42)).toBe(42);
        expect(toNumber("--")).toBeNull();
        expect(toNumber(null)).toBeNull();
    });
});

describe("assessBasautoItem", () => {
    it("returns null when both systems are calm", () => {
        expect(assessBasautoItem(bas(), aria())).toBeNull();
    });

    it("flags MISSING_IN_ARIA when basauto is urgent and Aria has no record", () => {
        const r = assessBasautoItem(bas({ urgency: "Overdue", reorderQty: 50, stockDaysLeft: 0 }), null);
        expect(r?.verdict).toBe("MISSING_IN_ARIA");
        expect(r?.severity).toBe("high");
    });

    it("returns null for MISSING when basauto is calm", () => {
        expect(assessBasautoItem(bas({ urgency: "OK" }), null)).toBeNull();
    });

    it("flags OVERBUY_RISK when Aria counts a committed PO basauto cannot see", () => {
        const a = aria({
            urgency: "ok",
            stockOnHand: 10,
            dailyRate: 2,
            openPOs: [{ orderId: "125188", quantity: 3000, orderDate: "2026-08-12" }],
            stockOnOrder: 3000,
        });
        const r = assessBasautoItem(bas({ urgency: "Overdue", reorderQty: 100, onOrder: 0, stockDaysLeft: 0 }), a);
        expect(r?.verdict).toBe("OVERBUY_RISK");
        expect(r?.severity).toBe("high");
        expect(r?.reason).toContain("#125188");
        expect(r?.reason).toContain("Do not re-buy");
    });

    it("does NOT flag OVERBUY_RISK when basauto already sees the on-order qty", () => {
        const a = aria({
            urgency: "ok",
            stockOnHand: 10,
            dailyRate: 2,
            openPOs: [{ orderId: "125188", quantity: 3000 }],
        });
        const r = assessBasautoItem(bas({ urgency: "Overdue", reorderQty: 100, onOrder: 3000 }), a);
        expect(r?.verdict).not.toBe("OVERBUY_RISK");
    });

    it("flags VELOCITY_MISMATCH for depletion vs demand gaps (RAWGYPSUM case)", () => {
        const r = assessBasautoItem(
            bas({ urgency: "Urgent", velocity: 366.78, reorderQty: 30744, quantity: -33010, stockDaysLeft: 16.4 }),
            aria(),
        );
        expect(r?.verdict).toBe("VELOCITY_MISMATCH");
        expect(r?.reason).toContain("3.3×");
    });

    it("flags FALSE_URGENT when Aria runway is far past the order point", () => {
        const r = assessBasautoItem(
            bas({ urgency: "Overdue", velocity: 100, stockDaysLeft: 5, reorderQty: 500 }),
            aria({ adjustedRunwayDays: 200, effectiveLeadTimeDays: 15, dailyRate: 100 }),
        );
        expect(r?.verdict).toBe("FALSE_URGENT");
    });

    it("flags BORDERLINE when runway is inside 2× lead time", () => {
        const r = assessBasautoItem(
            bas({ urgency: "Urgent", velocity: 50, stockDaysLeft: 8 }),
            aria({ adjustedRunwayDays: 20, effectiveLeadTimeDays: 15, dailyRate: 50 }),
        );
        expect(r?.verdict).toBe("BORDERLINE");
    });

    it("flags AGREE when both are non-OK and quantities match", () => {
        const r = assessBasautoItem(
            bas({ urgency: "Urgent", reorderQty: 100 }),
            aria({ urgency: "critical", suggestedQty: 105, adjustedRunwayDays: 8 }),
        );
        expect(r?.verdict).toBe("AGREE");
        expect(r?.severity).toBe("low");
    });

    it("flags QTY_MISMATCH when both are non-OK but quantities differ >50%", () => {
        const r = assessBasautoItem(
            bas({ urgency: "Urgent", reorderQty: 1000 }),
            aria({ urgency: "critical", suggestedQty: 200, adjustedRunwayDays: 8 }),
        );
        expect(r?.verdict).toBe("QTY_MISMATCH");
    });

    it("flags ARIA_ONLY when Aria sees urgency basauto misses", () => {
        const r = assessBasautoItem(bas({ urgency: "OK" }), aria({ urgency: "critical", adjustedRunwayDays: 5 }));
        expect(r?.verdict).toBe("ARIA_ONLY");
    });
});

describe("buildReconReport", () => {
    it("summarizes counts and sorts high severity first", () => {
        const records = [
            bas({ productId: "AAA", urgency: "Overdue", reorderQty: 100, stockDaysLeft: 0 }),
            bas({ productId: "BBB", urgency: "Urgent", velocity: 400, quantity: -36000, stockDaysLeft: 16 }),
            bas({ productId: "CCC", urgency: "OK" }),
        ];
        const items = [
            aria({ productId: "AAA", urgency: "ok", dailyRate: 1, stockOnHand: 5, openPOs: [{ orderId: "1", quantity: 500 }] }),
            aria({ productId: "BBB" }),
            aria({ productId: "CCC", urgency: "ok" }),
        ];
        const report = buildReconReport(records, items, { source: "api", ariaCachedAt: null });
        expect(report.summary.flagged).toBe(2);
        expect(report.summary.byVerdict.OVERBUY_RISK).toBe(1);
        expect(report.summary.byVerdict.VELOCITY_MISMATCH).toBe(1);
        expect(report.summary.basautoItems).toBe(3);
        expect(report.items[0].severity).toBe("high");
        expect(report.items[0].sku).toBe("AAA");
    });
});
