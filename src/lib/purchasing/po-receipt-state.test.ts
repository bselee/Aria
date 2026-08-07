import { describe, expect, it } from "vitest";
import {
    hasPurchaseOrderReceipt,
    resolvePurchaseOrderReceiptDate,
    isHighConfidenceReceived,
} from "./po-receipt-state";

describe("po receipt state", () => {
    it("treats status 'received' as received", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Received",
            receiveDate: "2026-03-27",
        })).toBe(true);
    });

    it("treats committed with receive date as received (Finale sets receiveDate on receipt)", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Committed",
            receiveDate: "2026-03-27",
        })).toBe(true);
    });

    it("treats committed without receive date or received shipments as not received", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Committed",
            receiveDate: null,
            shipments: [],
        })).toBe(false);
    });

    it("treats all shipments received as received (staff receptions)", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Committed",
            receiveDate: null,
            shipments: [
                { status: "Received", receiveDate: "2026-04-07" },
                { status: "Received", receiveDate: "2026-04-08" },
                { status: "Received", receiveDate: "2026-04-09" },
            ],
        })).toBe(true);
    });

    it("treats partial received shipments as received", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Committed",
            receiveDate: null,
            shipments: [
                { status: "Received", receiveDate: "2026-04-07" },
                { status: "Shipped", receiveDate: null },
            ],
        })).toBe(true);
    });

    it("treats received + cancelled shipments as received", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [
                { status: "Received", receiveDate: "2026-03-04" },
                { status: "Canceled", receiveDate: "2026-03-16" },
            ],
        })).toBe(true);
    });

    it("does NOT trust Completed status without receiveDate (Finale auto-completes on qty match)", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [],
        })).toBe(false);
    });

    it("does NOT trust Completed with in-transit shipments that have no receiveDate", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [
                { status: "Shipped", receiveDate: null },
            ],
        })).toBe(false);
    });

    it("trusts Completed with a shipment that has a past receiveDate (concrete receipt)", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [
                { status: "Shipped", receiveDate: null },
                { status: "Completed", receiveDate: "2026-03-16" },
            ],
        })).toBe(true);
    });

    it("does NOT treat a FUTURE receiveDate as received (Finale plans dates on Committed POs)", () => {
        const future = new Date();
        future.setDate(future.getDate() + 21);
        expect(hasPurchaseOrderReceipt({
            status: "Committed",
            receiveDate: future.toISOString().slice(0, 10),
        })).toBe(false);
    });

    it("does NOT treat a FUTURE shipment receiveDate as received", () => {
        const future = new Date();
        future.setDate(future.getDate() + 10);
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [
                { status: "Completed", receiveDate: future.toISOString().slice(0, 10) },
            ],
        })).toBe(false);
    });

    it("uses the latest known shipment receive date for reporting", () => {
        expect(resolvePurchaseOrderReceiptDate({
            status: "Received",
            receiveDate: "2026-03-27",
            shipments: [
                { status: "Received", receiveDate: "2026-03-16" },
                { status: "Received", receiveDate: "2026-04-06" },
                { status: "Received", receiveDate: "2026-03-20" },
            ],
        })).toBe("2026-04-06");
    });

    it("trusts shipment status Received even when PO.receiveDate is null (124895)", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [
                { status: "Received", receiveDate: "2026-06-12" },
            ],
        })).toBe(true);
    });

    it("trusts shipment status Received without receiveDate", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [
                { status: "Received", receiveDate: null },
            ],
        })).toBe(true);
    });

    it("does NOT trust Completed alone without shipment Received", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [
                { status: "Editable", receiveDate: null },
            ],
        })).toBe(false);
    });
});

describe("isHighConfidenceReceived — Active Purchases exit", () => {
    it("drops on hard receipt", () => {
        expect(isHighConfidenceReceived({
            status: "Received",
            receiveDate: "2026-07-01",
        })).toBe(true);
    });

    it("drops on lifecycle RECEIVED", () => {
        expect(isHighConfidenceReceived({
            status: "Committed",
            lifecycleStage: "RECEIVED",
        })).toBe(true);
    });

    it("drops on accurate matched invoice + past ETA", () => {
        expect(isHighConfidenceReceived({
            status: "Committed",
            matchedInvoiceTotal: 1000,
            matchedInvoiceStatus: "reconciled",
            poTotal: 1000,
            expectedDate: "2026-07-01", // past
        })).toBe(true);
    });

    it("keeps open when invoice amount is off by >2%", () => {
        expect(isHighConfidenceReceived({
            status: "Committed",
            matchedInvoiceTotal: 500,
            matchedInvoiceStatus: "matched",
            poTotal: 1000,
            expectedDate: "2026-07-01",
        })).toBe(false);
    });

    it("keeps unreceived open POs on Active", () => {
        expect(isHighConfidenceReceived({
            status: "Committed",
            receiveDate: null,
            shipments: [],
        })).toBe(false);
    });

    it("drops Completed + accurate invoice even without past ETA", () => {
        expect(isHighConfidenceReceived({
            status: "Completed",
            matchedInvoiceTotal: 2000,
            matchedInvoiceStatus: "paid",
            poTotal: 2000,
        })).toBe(true);
    });

    it("drops on finaleReceiptActivity", () => {
        expect(isHighConfidenceReceived({
            status: "Committed",
            finaleReceiptActivity: true,
        })).toBe(true);
    });
});
