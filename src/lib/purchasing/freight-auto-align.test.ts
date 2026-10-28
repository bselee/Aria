/**
 * @file    freight-auto-align.test.ts
 * @purpose Tests for the autonomous freight alignment decisions: lane choice,
 *          dwell, and the completion blocker. No DB or Finale access.
 */
import { describe, it, expect } from "vitest";
import { pickFreightLane, dwellSatisfied, completionBlocker, sumFreightAdjustments } from "./freight-auto-align";

describe("pickFreightLane", () => {
    it("picks the vendor lane when the goods invoice carries freight", () => {
        const r = pickFreightLane({ invoiceFreight: 350, destAmount: 0 });
        expect(r.lane).toBe("vendor");
        expect(r.amount).toBe(350);
    });

    it("picks the Destination lane when the goods invoice has no freight", () => {
        const r = pickFreightLane({ invoiceFreight: 0, destAmount: 4800 });
        expect(r.lane).toBe("destination");
        expect(r.amount).toBe(4800);
    });

    it("never applies both lanes — vendor freight wins over Destination", () => {
        const r = pickFreightLane({ invoiceFreight: 120, destAmount: 4800 });
        expect(r.lane).toBe("vendor");
        expect(r.amount).toBe(120);
    });

    it("returns none when no bill supplies freight", () => {
        const r = pickFreightLane({ invoiceFreight: 0, destAmount: 0.4 });
        expect(r.lane).toBe("none");
        expect(r.amount).toBe(0);
    });
});

describe("dwellSatisfied", () => {
    const now = Date.parse("2026-10-28T15:00:00.000-06:00");

    it("false for a fresh anchor", () => {
        expect(dwellSatisfied("2026-10-28T14:00:00.000-06:00", now)).toBe(false);
    });

    it("true once 24h have passed", () => {
        expect(dwellSatisfied("2026-10-27T14:00:00.000-06:00", now)).toBe(true);
    });

    it("false for a missing anchor", () => {
        expect(dwellSatisfied(null, now)).toBe(false);
    });
});

describe("completionBlocker", () => {
    const clean = {
        shortsCount: 0,
        hasMatchedInvoice: true,
        invoiceTotal: 2996,
        poTotal: 2996,
        invoiceFreight: 0,
        poFreight: 350,
        openDispute: false,
        pendingApproval: false,
    };

    it("passes an aligned PO", () => {
        expect(completionBlocker(clean)).toBeNull();
    });

    it("never completes a short receipt", () => {
        expect(completionBlocker({ ...clean, shortsCount: 1 })).toContain("not all received");
    });

    it("blocks on an open overbill dispute", () => {
        expect(completionBlocker({ ...clean, openDispute: true })).toContain("dispute");
    });

    it("blocks on a pending approval", () => {
        expect(completionBlocker({ ...clean, pendingApproval: true })).toContain("approval");
    });

    it("blocks when invoice freight exceeds what the PO carries", () => {
        expect(completionBlocker({ ...clean, invoiceFreight: 400, poFreight: 350 })).toContain("exceeds");
    });

    it("blocks when the bill exceeds the PO beyond tolerance", () => {
        expect(completionBlocker({ ...clean, invoiceTotal: 4000, poTotal: 2996 })).toContain("exceeds PO");
    });

    it("tolerates a small bill-vs-PO delta", () => {
        expect(completionBlocker({ ...clean, invoiceTotal: 3005, poTotal: 2996 })).toBeNull();
    });

    it("blocks without a matched invoice", () => {
        expect(completionBlocker({ ...clean, hasMatchedInvoice: false })).toContain("no matched");
    });
});

describe("sumFreightAdjustments", () => {
    it("sums only /10007 freight lines", () => {
        const doc = {
            orderAdjustmentList: [
                { amount: 1.5, description: "Freight", productPromoUrl: "/x/api/productpromo/10007" },
                { amount: 560.2, description: "Freight", productPromoUrl: "/x/api/productpromo/10007" },
                { amount: 100.49, description: "Tax", productPromoUrl: "/x/api/productpromo/10008" },
                { amount: 300, description: "Labor", productPromoUrl: "/x/api/productpromo/10016" },
            ],
        };
        expect(sumFreightAdjustments(doc)).toBe(561.7);
    });

    it("returns zero for a missing list", () => {
        expect(sumFreightAdjustments(null)).toBe(0);
    });
});
