/**
 * @file    deliver-bill-vendors.test.ts
 * @purpose Predicate tests for the bill-as-they-deliver vendor domain model.
 */
import { describe, it, expect } from "vitest";
import { isDeliverAndBillVendor, isBlanketMultiDeliveryVendor } from "./deliver-bill-vendors";

describe("isDeliverAndBillVendor", () => {
    it("matches the bill-per-delivery vendors Bill named (2026-10-28)", () => {
        expect(isDeliverAndBillVendor("Miles Filippelli")).toBe(true);
        expect(isDeliverAndBillVendor("Fermented Plant Extracts")).toBe(true);
        expect(isDeliverAndBillVendor("Cowoco")).toBe(true);
        expect(isDeliverAndBillVendor("CR Minerals")).toBe(true);
        expect(isDeliverAndBillVendor("Rootwise Organics")).toBe(true);
        expect(isDeliverAndBillVendor("Thrive")).toBe(true);
    });

    it("is case- and punctuation-insensitive", () => {
        expect(isDeliverAndBillVendor("cr minerals co.")).toBe(true);
        expect(isDeliverAndBillVendor("MILES FILIPPELLI")).toBe(true);
    });

    it("rejects vendors that bill per PO — New Moon bills UP FRONT, never flagged", () => {
        expect(isDeliverAndBillVendor("Uline")).toBe(false);
        expect(isDeliverAndBillVendor("Axiom Print")).toBe(false);
        expect(isDeliverAndBillVendor("Belt Power")).toBe(false);
        expect(isDeliverAndBillVendor("New Moon Dev Co")).toBe(false);
        expect(isDeliverAndBillVendor(null)).toBe(false);
    });
});

describe("isBlanketMultiDeliveryVendor", () => {
    it("names the known blanket-PO vendors", () => {
        expect(isBlanketMultiDeliveryVendor("CR Minerals")).toBe(true);
        expect(isBlanketMultiDeliveryVendor("Miles Filippelli")).toBe(false);
        expect(isBlanketMultiDeliveryVendor("New Moon Dev Co")).toBe(false);
    });
});
