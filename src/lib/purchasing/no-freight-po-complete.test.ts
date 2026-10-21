import { describe, expect, it } from "vitest";
import {
    checkNoFreightCompleteEligibility,
    invoiceGoodsAmount,
    type NoFreightInvoice,
    type NoFreightPOInput,
} from "./no-freight-po-complete";
import type { PatternEvidence } from "./vendor-freight-pattern";

function inv(overrides: Partial<NoFreightInvoice> = {}): NoFreightInvoice {
    return {
        invoiceNumber: "1001",
        status: "received",
        subtotal: 725,
        freight: 0,
        tax: 0,
        total: 725,
        ...overrides,
    };
}

function po(overrides: Partial<NoFreightPOInput> = {}): NoFreightPOInput {
    return {
        orderId: "125273",
        vendorName: "Stock Bag Depot",
        finaleStatusId: "ORDER_LOCKED",
        finaleReceived: true,
        poGoodsTotal: 725,
        poFreightAmount: 0,
        invoices: [inv()],
        ...overrides,
    };
}

function freightHistory(): PatternEvidence[] {
    return Array.from({ length: 16 }, (_, i) => ({
        poId: `prior-${i}`,
        hadFreightOnPO: true,
        invoiceFreight: 80,
        matched: true,
    }));
}

describe("checkNoFreightCompleteEligibility", () => {
    it("completes Stock Bag when committed, received, and amounts match", () => {
        const r = checkNoFreightCompleteEligibility(po());
        expect(r.eligible).toBe(true);
    });

    it("completes Miles and Thrive the same way", () => {
        expect(checkNoFreightCompleteEligibility(po({ vendorName: "Miles Filippelli", poGoodsTotal: 1980, invoices: [inv({ subtotal: 1980, total: 1980 })] })).eligible).toBe(true);
        expect(checkNoFreightCompleteEligibility(po({ vendorName: "Thrive Probiotics", poGoodsTotal: 1014, invoices: [inv({ subtotal: 1014, total: 1014 })] })).eligible).toBe(true);
    });

    it("holds a vendor that still needs freight attached", () => {
        const r = checkNoFreightCompleteEligibility(po({ vendorName: "Rootwise Soil Dynamics" }));
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/bas_freight/);
    });

    it("holds when Finale is not still committed", () => {
        const draft = checkNoFreightCompleteEligibility(po({ finaleStatusId: "ORDER_CREATED" }));
        expect(draft.eligible).toBe(false);
        if (!draft.eligible) expect(draft.reason).toMatch(/not committed/);

        const done = checkNoFreightCompleteEligibility(po({ finaleStatusId: "ORDER_COMPLETED" }));
        expect(done.eligible).toBe(false);
        if (!done.eligible) expect(done.reason).toMatch(/ORDER_COMPLETED/);
    });

    it("holds when shipment qty is short of the order, even if a receive date exists", () => {
        const r = checkNoFreightCompleteEligibility(po({
            orderId: "124908",
            vendorName: "New Moon Development Co",
            finaleReceived: true,
            orderedQty: 250,
            receivedQty: 225,
            poGoodsTotal: 7875,
            invoices: [inv({ subtotal: 7875, total: 7875 })],
        }));
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/225 of 250/);
    });
    it("holds when goods are not received", () => {
        const r = checkNoFreightCompleteEligibility(po({ finaleReceived: false }));
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/not Finale-received/);
    });

    it("holds a dropship", () => {
        const r = checkNoFreightCompleteEligibility(po({ orderId: "23339077-DropshipPO" }));
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/dropship/);
    });

    it("holds when no usable invoice is matched", () => {
        const r = checkNoFreightCompleteEligibility(po({ invoices: [inv({ subtotal: 0, total: 0 })] }));
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/no matched invoice/);
    });

    it("holds when this invoice has freight, even for Miles", () => {
        const r = checkNoFreightCompleteEligibility(po({
            vendorName: "Miles Filippelli",
            invoices: [inv({ subtotal: 1440, freight: 4, total: 1444 })],
            poGoodsTotal: 1440,
        }));
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/not on the PO/);
    });

    it("holds when the PO already has a freight line", () => {
        const r = checkNoFreightCompleteEligibility(po({ poFreightAmount: 85 }));
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/PO already has freight/);
    });

    it("holds a partial invoice even if the vendor is no-freight", () => {
        const r = checkNoFreightCompleteEligibility(po({
            vendorName: "Miles Filippelli",
            poGoodsTotal: 2700,
            invoices: [inv({ subtotal: 500, total: 500 })],
        }));
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/short by \$2200.00/);
    });

    it("sums partial invoices and completes only when they cover the PO", () => {
        const short = checkNoFreightCompleteEligibility(po({
            vendorName: "Thrive Probiotics",
            poGoodsTotal: 2000,
            invoices: [inv({ invoiceNumber: "1", subtotal: 800, total: 800 }), inv({ invoiceNumber: "2", subtotal: 700, total: 700 })],
        }));
        expect(short.eligible).toBe(false);

        const covered = checkNoFreightCompleteEligibility(po({
            vendorName: "Thrive Probiotics",
            poGoodsTotal: 1500,
            invoices: [inv({ invoiceNumber: "1", subtotal: 800, total: 800 }), inv({ invoiceNumber: "2", subtotal: 700, total: 700 })],
        }));
        expect(covered.eligible).toBe(true);
    });

    it("allows half-dollar rounding and holds a dollar miss", () => {
        expect(checkNoFreightCompleteEligibility(po({ poGoodsTotal: 725.4, invoices: [inv({ subtotal: 725, total: 725 })] })).eligible).toBe(true);
        const miss = checkNoFreightCompleteEligibility(po({ poGoodsTotal: 726, invoices: [inv({ subtotal: 725, total: 725 })] }));
        expect(miss.eligible).toBe(false);
        if (!miss.eligible) expect(miss.reason).toMatch(/short by \$1.00/);
    });

    it("dedupes the same invoice number with commas", () => {
        const r = checkNoFreightCompleteEligibility(po({
            vendorName: "Miles Filippelli",
            poGoodsTotal: 2620,
            invoices: [
                inv({ invoiceNumber: "552026", subtotal: 2620, total: 2620 }),
                inv({ invoiceNumber: "552,026", subtotal: 2620, total: 2620 }),
            ],
        }));
        expect(r.eligible).toBe(true);
    });

    it("uses total when subtotal was not extracted", () => {
        expect(invoiceGoodsAmount(inv({ subtotal: 0, freight: 0, tax: 0, total: 2130 }))).toBe(2130);
        const r = checkNoFreightCompleteEligibility(po({
            poGoodsTotal: 2130,
            invoices: [inv({ subtotal: 0, total: 2130 })],
        }));
        expect(r.eligible).toBe(true);
    });

    it("holds a learned no-freight vendor if any prior PO had freight to attach", () => {
        const evidence: PatternEvidence[] = [
            ...Array.from({ length: 15 }, (_, i) => ({
                poId: `clean-${i}`,
                hadFreightOnPO: false,
                invoiceFreight: 0,
                matched: false,
            })),
            { poId: "one-freight", hadFreightOnPO: true, invoiceFreight: 0, matched: false },
        ];
        const r = checkNoFreightCompleteEligibility(
            po({ vendorName: "Quiet Pickup Vendor", poGoodsTotal: 100, invoices: [inv({ subtotal: 100, total: 100 })] }),
            evidence,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/history includes freight/);
    });

    it("does not let freight history override a confirmed no-freight vendor", () => {
        const r = checkNoFreightCompleteEligibility(
            po({ vendorName: "Thrive Probiotics" }),
            freightHistory(),
        );
        expect(r.eligible).toBe(true);
    });
});
