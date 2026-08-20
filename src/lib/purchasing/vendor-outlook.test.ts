/**
 * @file    vendor-outlook.test.ts
 * @purpose Outlook parse + build vs sales vs mixed order-by.
 * @author  Hermia
 * @created 2026-08-14
 */
import { describe, expect, it } from "vitest";
import { parseOutlookNote, planItemOutlook, planVendorOutlook, encodeOutlookNotes, decodeOutlookNotes, isHoldActive } from "./vendor-outlook";

describe("hold until", () => {
    it("round-trips HOLD token without eating other notes", () => {
        const raw = encodeOutlookNotes("2026-12-01", "Colorful 60d");
        expect(raw).toMatch(/HOLD:2026-12-01/);
        const d = decodeOutlookNotes(raw);
        expect(d.holdUntilDate).toBe("2026-12-01");
        expect(d.notes).toBe("Colorful 60d");
    });

    it("is active through the hold date", () => {
        expect(isHoldActive("2026-12-01", new Date("2026-08-14T12:00:00Z"))).toBe(true);
        expect(isHoldActive("2026-08-01", new Date("2026-08-14T12:00:00Z"))).toBe(false);
        expect(isHoldActive(null)).toBe(false);
    });
});

describe("parseOutlookNote", () => {
    it("reads lead and cover from a comment", () => {
        const p = parseOutlookNote("Martin said 120d MTO, cover 180d");
        expect(p.leadTimeOverrideDays).toBe(120);
        expect(p.targetCoverDays).toBe(180);
    });

    it("treats bare MTO as 120d lead", () => {
        expect(parseOutlookNote("Canada MTO prepay")?.leadTimeOverrideDays).toBe(120);
    });

    it("reads months cover", () => {
        expect(parseOutlookNote("order 6 months cover")?.targetCoverDays).toBe(180);
    });
});

describe("planItemOutlook", () => {
    it("plans BOM/build inputs off Finale demand, last truck — not 256k overdue", () => {
        const today = new Date("2026-08-14T12:00:00Z");
        const plan = planItemOutlook({
            productId: "RAWWORMCASTINGS",
            itemType: "bom-component",
            stockOnHand: 29204,
            stockOnOrder: 0,
            dailyRate: 5.48,
            salesVelocity: 5.48,
            demandVelocity: 1449,
            lastPurchaseQty: 42000,
            leadTimeDays: 15,
        }, null, today);
        expect(plan.reason).toBe("build_consumption");
        expect(plan.orderByDate).not.toBeNull();
        expect(plan.orderByDays).toBe(Math.round(29204 / 1449 - 15));
        expect(plan.truckHintQty).toBe(42000);
        expect(plan.summary).toMatch(/sales 5\.5\/d \+ build 1449\/d/);
        expect(plan.summary).not.toMatch(/256/);
    });

    it("uses dated build minus lead as order-by", () => {
        const today = new Date("2026-08-14T12:00:00Z");
        const plan = planItemOutlook({
            productId: "FM104",
            itemType: "bom-component",
            stockOnHand: 45,
            dailyRate: 1,
            salesVelocity: 1,
            leadTimeDays: 21,
            forwardDemandEntry: {
                requiredQty: 200,
                earliestBuildDate: "2026-09-12",
                feedsBuilds: ["OCB101"],
            },
        }, null, today);
        expect(plan.reason).toBe("dated_build");
        expect(plan.orderByDate).toBe("2026-08-22");
        expect(plan.summary).toMatch(/9\/12/);
    });

    it("uses sales only for resale / no-BOM", () => {
        const today = new Date("2026-08-14T12:00:00Z");
        const plan = planItemOutlook({
            productId: "S-4125",
            itemType: "resale",
            stockOnHand: 74,
            dailyRate: 6,
            salesVelocity: 6,
            demandVelocity: 0,
            leadTimeDays: 7,
        }, { notes: "bridge 21d", leadTimeOverrideDays: 21, targetCoverDays: null }, today);
        expect(plan.reason).toBe("sales");
        expect(plan.leadDays).toBe(21);
        expect(plan.orderByDays).toBe(Math.round(74 / 6 - 21));
    });

    it("mixed sales+BOM uses the tighter burn", () => {
        const today = new Date("2026-08-14T12:00:00Z");
        const plan = planItemOutlook({
            productId: "MIX101",
            itemType: "resale-bom",
            stockOnHand: 100,
            salesVelocity: 10,
            demandVelocity: 2,
            leadTimeDays: 10,
        }, null, today);
        expect(plan.reason).toBe("build_consumption");
        expect(plan.orderByDays).toBe(Math.round(100 / 10 - 10));
        expect(plan.summary).toMatch(/sales 10\.0\/d \+ build 2\/d/);
    });
});

describe("planVendorOutlook", () => {
    it("headlines the tightest dated/sales/build item", () => {
        const today = new Date("2026-08-14T12:00:00Z");
        const { tightest, rampCount } = planVendorOutlook([
            {
                productId: "RAWWORMCASTINGS",
                itemType: "bom-component",
                stockOnHand: 29204,
                salesVelocity: 5,
                demandVelocity: 1400,
                leadTimeDays: 15,
            },
            {
                productId: "S-4125",
                itemType: "resale",
                stockOnHand: 74,
                salesVelocity: 6,
                dailyRate: 6,
                leadTimeDays: 7,
            },
        ], null, today);
        expect(rampCount).toBe(1);
        expect(["RAWWORMCASTINGS", "S-4125"]).toContain(tightest?.productId);
        expect(tightest?.orderByDays).toBeLessThan(10);
    });
});
