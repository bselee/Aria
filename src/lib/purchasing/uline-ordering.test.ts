import { describe, expect, it } from "vitest";

import {
    convertFinaleItemToUlineOrder,
    getUlineOrderingRule,
} from "./uline-ordering";

describe("getUlineOrderingRule", () => {
    it("uses vendor-multiple rounding for common box SKUs", () => {
        const rule = getUlineOrderingRule("S-4128");

        expect(rule.orderUnitEaches).toBe(1);
        expect(rule.quantityStep).toBe(25);
        expect(rule.maxFinaleEaches).toBe(10_000);
    });

    it("uses carton or pail units for pack-only SKUs", () => {
        expect(getUlineOrderingRule("S-2835")).toMatchObject({
            orderUnitEaches: 1000,
            quantityStep: 1,
        });
        expect(getUlineOrderingRule("S-3902")).toMatchObject({
            orderUnitEaches: 5000,
            quantityStep: 1,
        });
    });
});

describe("convertFinaleItemToUlineOrder", () => {
    it("rounds box quantities up to the nearest vendor multiple while keeping Finale in eaches", () => {
        const converted = convertFinaleItemToUlineOrder({
            finaleSku: "S-4128",
            finaleEachQuantity: 1285,
            finaleUnitPrice: 0.65,
            description: "12 x 6 x 6 long box",
        });

        expect(converted.quantity).toBe(1300);
        expect(converted.finaleEachQuantity).toBe(1285);
        expect(converted.effectiveEachQuantity).toBe(1300);
        expect(converted.unitPrice).toBe(0.65);
        expect(converted.guardrailWarnings).toContain("Rounded S-4128 from 1285 eaches to 1300 ULINE quantity.");
    });

    it("converts pack-only SKUs into vendor order units and vendor-unit pricing", () => {
        const converted = convertFinaleItemToUlineOrder({
            finaleSku: "S-2835",
            finaleEachQuantity: 1000,
            finaleUnitPrice: 0.041,
            description: "1 quart reclosable bags",
        });

        expect(converted.quantity).toBe(1);
        expect(converted.orderUnitEaches).toBe(1000);
        expect(converted.unitPrice).toBeCloseTo(41);
        expect(converted.effectiveEachQuantity).toBe(1000);
    });

    it("rounds pack-only SKUs up to the nearest vendor unit", () => {
        const converted = convertFinaleItemToUlineOrder({
            finaleSku: "S-3902",
            finaleEachQuantity: 1000,
            finaleUnitPrice: 0.039,
            description: "desiccants",
        });

        expect(converted.quantity).toBe(1);
        expect(converted.orderUnitEaches).toBe(5000);
        expect(converted.effectiveEachQuantity).toBe(5000);
        expect(converted.unitPrice).toBeCloseTo(195);
    });

    it("flags quantities above the vendor guardrail cap", () => {
        const converted = convertFinaleItemToUlineOrder({
            finaleSku: "S-4092",
            finaleEachQuantity: 12_500,
            finaleUnitPrice: 0.51,
            description: "9 x 5 x 5 box",
        });

        expect(converted.guardrailWarnings.some(w => w.includes("exceeds the 10000-each guardrail"))).toBe(true);
    });
});
