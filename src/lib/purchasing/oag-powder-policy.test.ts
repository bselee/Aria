/**
 * @file    src/lib/purchasing/oag-powder-policy.test.ts
 * @purpose Unit tests for OAG powder MTO + CYC FPF policy helpers.
 * @author  Hermia
 * @created 2026-07-29
 */
import { describe, it, expect } from "vitest";
import {
    getOagPowderLeadOverrideDays,
    getOagPowderLotQty,
    isFpfCycOnlyPo,
    isOagFpfRawDnrSku,
    isOagPowderRawSku,
    resolveLeadTimeDays,
    OAG_POWDER_LEAD_DAYS,
} from "./oag-powder-policy";
import { evaluateVendorCycle } from "./vendor-order-cycle";

describe("oag-powder-policy", () => {
    it("marks powder RAW SKUs and 120d lead", () => {
        expect(isOagPowderRawSku("OAG223")).toBe(true);
        expect(isOagPowderRawSku("oag222")).toBe(true);
        expect(isOagPowderRawSku("OAG218")).toBe(false);
        expect(getOagPowderLeadOverrideDays("OAG224")).toBe(OAG_POWDER_LEAD_DAYS);
        expect(getOagPowderLeadOverrideDays("OAG218")).toBeNull();
        expect(getOagPowderLotQty("OAG223")).toBe(2760);
        expect(getOagPowderLotQty("OAG222")).toBe(5520);
    });

    it("treats OAG228 as hard DNR and FPF finished as CYC", () => {
        expect(isOagFpfRawDnrSku("OAG228")).toBe(true);
        expect(isFpfCycOnlyPo(["OAG219"])).toBe(true);
        expect(isFpfCycOnlyPo(["OAG218", "OAG219"])).toBe(true);
        expect(isFpfCycOnlyPo(["OAG219", "OAG223"])).toBe(false);
        expect(isFpfCycOnlyPo([])).toBe(false);
    });

    it("resolveLeadTimeDays: powder SKU beats vendor policy", () => {
        const r = resolveLeadTimeDays({
            productId: "OAG223",
            vendorPolicyLeadDays: 21,
            baseLeadDays: 21,
        });
        expect(r.days).toBe(120);
        expect(r.provenance).toMatch(/powder MTO/i);
    });

    it("resolveLeadTimeDays: non-powder uses vendor policy then base", () => {
        expect(
            resolveLeadTimeDays({
                productId: "OAG218",
                vendorPolicyLeadDays: 45,
                baseLeadDays: 21,
            }).days,
        ).toBe(45);
        expect(
            resolveLeadTimeDays({
                productId: "OAG226",
                vendorPolicyLeadDays: null,
                baseLeadDays: 21,
            }).days,
        ).toBe(21);
    });
});

describe("evaluateVendorCycle FPF CYC exclusion", () => {
    const day = 86400000;
    const base = {
        vendorPartyId: "10566",
        vendorName: "Organics Alive",
    };

    it("does not lock cycle on FPF-only PO (125096 pattern)", () => {
        const pos = [
            {
                orderId: "125096",
                orderDate: new Date(Date.now() - 10 * day).toISOString(),
                status: "ORDER_COMMITTED",
                supplier: "Organics Alive",
                productIds: ["OAG219"],
            },
        ];
        const result = evaluateVendorCycle(pos, base);
        expect(result.decision).toBe("clear");
        expect(result.ignoredCopack).toBe(1);
        expect(result.blockingPOs).toHaveLength(0);
    });

    it("still locks when powder RAW is on a recent PO", () => {
        const pos = [
            {
                orderId: "124788",
                orderDate: new Date(Date.now() - 5 * day).toISOString(),
                status: "ORDER_COMMITTED",
                supplier: "Organics Alive",
                productIds: ["OAG222", "OAG223"],
            },
        ];
        const result = evaluateVendorCycle(pos, base);
        expect(result.decision).toBe("routine_locked");
        expect(result.ignoredCopack).toBe(0);
    });

    it("ignores FPF-only while locking a separate powder PO", () => {
        const pos = [
            {
                orderId: "125096",
                orderDate: new Date(Date.now() - 10 * day).toISOString(),
                status: "OPEN",
                supplier: "Organics Alive",
                productIds: ["OAG219"],
            },
            {
                orderId: "POWDER1",
                orderDate: new Date(Date.now() - 3 * day).toISOString(),
                status: "ORDER_COMMITTED",
                supplier: "Organics Alive",
                productIds: ["OAG223"],
            },
        ];
        const result = evaluateVendorCycle(pos, base);
        expect(result.decision).toBe("routine_locked");
        expect(result.ignoredCopack).toBe(1);
        expect(result.blockingPOs.map((p) => p.orderId)).toEqual(["POWDER1"]);
    });
});
