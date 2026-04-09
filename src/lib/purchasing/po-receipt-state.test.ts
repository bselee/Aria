import { describe, expect, it } from "vitest";
import { hasPurchaseOrderReceipt, resolvePurchaseOrderReceiptDate } from "./po-receipt-state";

describe("po receipt state", () => {
    it("treats status 'received' as received", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Received",
            receiveDate: "2026-03-27",
        })).toBe(true);
    });

    it("does not treat committed with receive date alone as received", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Committed",
            receiveDate: "2026-03-27",
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

    it("does not trust completed alone without shipments", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [],
        })).toBe(false);
    });

    it("does not trust completed with only in-transit shipments", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [
                { status: "Shipped", receiveDate: null },
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
});
