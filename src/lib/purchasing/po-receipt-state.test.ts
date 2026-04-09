import { describe, expect, it } from "vitest";
import { hasPurchaseOrderReceipt, resolvePurchaseOrderReceiptDate } from "./po-receipt-state";

describe("po receipt state", () => {
    it("treats a committed PO with a receive date as received", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Committed",
            receiveDate: "2026-03-27",
        })).toBe(true);
    });

    it("treats shipment-level received evidence as received when the PO receive date is blank", () => {
        expect(hasPurchaseOrderReceipt({
            status: "Completed",
            receiveDate: null,
            shipments: [
                { status: "Received", receiveDate: "2026-03-24" },
            ],
        })).toBe(true);
    });

    it("does not trust completed alone without any receipt evidence", () => {
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
            status: "Committed",
            receiveDate: "2026-03-27",
            shipments: [
                { status: "Received", receiveDate: "2026-03-16" },
                { status: "Received", receiveDate: "2026-04-06" },
                { status: "Received", receiveDate: "2026-03-20" },
            ],
        })).toBe("2026-04-06");
    });
});
