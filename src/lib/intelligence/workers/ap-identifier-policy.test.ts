import { describe, expect, it } from "vitest";
import { getInvoiceInboxPolicy } from "./ap-identifier-policy";

describe("getInvoiceInboxPolicy", () => {
    it("queues AP inbox invoices for Bill.com processing", () => {
        expect(getInvoiceInboxPolicy("ap")).toEqual({
            queueForBillCom: true,
            addLabels: [],
            removeLabels: ["INBOX", "UNREAD"],
            activityNote: "Queued for Bill.com forward",
        });
    });

    it("keeps default inbox invoices visible and flags them for human follow-up", () => {
        expect(getInvoiceInboxPolicy("default")).toEqual({
            queueForBillCom: false,
            addLabels: ["Follow Up"],
            removeLabels: [],
            activityNote: "Invoice detected on default inbox — not forwarded to Bill.com; left visible for review",
        });
    });
});
