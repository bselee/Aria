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

    it("uses case quantities for mapped bottle/jug SKUs", () => {
        expect(getUlineOrderingRule("FJG102")).toMatchObject({
            ulineModel: "S-13505B",
            orderUnitEaches: 1,
            quantityStep: 120,
        });
        expect(getUlineOrderingRule("FJG103")).toMatchObject({
            ulineModel: "S-13506B",
            orderUnitEaches: 1,
            quantityStep: 120,
        });
        expect(getUlineOrderingRule("FJG104")).toMatchObject({
            ulineModel: "S-10748B",
            orderUnitEaches: 1,
            quantityStep: 120,
        });
        expect(getUlineOrderingRule("FJG101")).toMatchObject({
            ulineModel: "S-15837B",
            orderUnitEaches: 1,
            quantityStep: 240,
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

    it("rounds mapped case SKUs up to the next full 120-each vendor step", () => {
        const converted = convertFinaleItemToUlineOrder({
            finaleSku: "FJG102",
            finaleEachQuantity: 155,
            finaleUnitPrice: 1.25,
            description: "F-Style jug 32 oz",
        });

        expect(converted.ulineModel).toBe("S-13505B");
        expect(converted.quantity).toBe(240);
        expect(converted.orderUnitEaches).toBe(1);
        expect(converted.quantityStep).toBe(120);
        expect(converted.effectiveEachQuantity).toBe(240);
        expect(converted.unitPrice).toBeCloseTo(1.25);
        expect(converted.guardrailWarnings).toContain("Rounded FJG102 from 155 eaches to 240 ULINE quantity.");
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

    it("blocks vendor-step rounding when it inflates spend by an absurd amount", () => {
        const converted = convertFinaleItemToUlineOrder({
            finaleSku: "FJG102",
            finaleEachQuantity: 1,
            finaleUnitPrice: 20,
            description: "F-Style jug 32 oz",
        });

        expect(converted.guardrailWarnings.some(w => w.includes("BLOCKING GUARDRAIL"))).toBe(true);
    });

    it("applies newly observed bundle multiples from the live ULINE cart", () => {
        expect(convertFinaleItemToUlineOrder({
            finaleSku: "S-4125",
            finaleEachQuantity: 304,
            finaleUnitPrice: 1.09,
            description: "box",
        }).effectiveEachQuantity).toBe(325);

        expect(convertFinaleItemToUlineOrder({
            finaleSku: "S-4124",
            finaleEachQuantity: 7,
            finaleUnitPrice: 1.11,
            description: "box",
        }).effectiveEachQuantity).toBe(25);

        expect(convertFinaleItemToUlineOrder({
            finaleSku: "S-445",
            finaleEachQuantity: 9,
            finaleUnitPrice: 3.25,
            description: "pack",
        }).effectiveEachQuantity).toBe(24);

        expect(convertFinaleItemToUlineOrder({
            finaleSku: "S-4738",
            finaleEachQuantity: 50,
            finaleUnitPrice: 2.29,
            description: "box",
        }).effectiveEachQuantity).toBe(60);
    });

    it("floors corrugated box orders to a meaningful batch size", () => {
        const converted = convertFinaleItemToUlineOrder({
            finaleSku: "BOX-24X14X10",
            finaleEachQuantity: 50,
            finaleUnitPrice: 2.29,
            description: 'Corrugated Boxes - (24"x14"x10") /20',
        });

        expect(converted.quantity).toBe(500);
        expect(converted.effectiveEachQuantity).toBe(500);
    });
});
