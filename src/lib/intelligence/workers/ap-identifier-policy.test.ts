import { describe, expect, it } from "vitest";
import {
    getAPHumanInteractionPolicy,
    getAPMissingPdfPolicy,
    getInvoiceInboxPolicy,
} from "./ap-identifier-policy";

describe("getInvoiceInboxPolicy", () => {
    it("queues AP inbox invoices for Bill.com processing", () => {
        expect(getInvoiceInboxPolicy("ap")).toEqual({
            queueForBillCom: true,
            addLabels: [],
            removeLabels: ["INBOX", "UNREAD"],
            activityNote: "Queued for Bill.com forward",
            reasonCode: "queued_for_billcom",
        });
    });

    it("keeps default inbox invoices visible without adding a follow-up label", () => {
        expect(getInvoiceInboxPolicy("default")).toEqual({
            queueForBillCom: false,
            addLabels: [],
            removeLabels: [],
            activityNote: "Invoice detected on default inbox - not forwarded to Bill.com; left visible for review",
            reasonCode: "invoice_non_ap_inbox",
        });
    });
});

describe("getAPHumanInteractionPolicy", () => {
    it("keeps AP inbox human interactions visible without adding a follow-up label", () => {
        expect(getAPHumanInteractionPolicy("ap")).toEqual({
            queueForBillCom: false,
            addLabels: [],
            removeLabels: [],
            activityNote: "Human interaction detected on ap inbox - left visible for manual AP review",
            reasonCode: "human_interaction_manual_review",
        });
    });
});

describe("getAPMissingPdfPolicy", () => {
    it("keeps AP invoice intents visible when the PDF is missing without adding a follow-up label", () => {
        expect(getAPMissingPdfPolicy("ap", "INVOICE")).toEqual({
            queueForBillCom: false,
            addLabels: [],
            removeLabels: [],
            activityNote: "No PDF attachment found on INVOICE in ap inbox - left visible for manual review",
            reasonCode: "missing_pdf_manual_review",
        });
    });
});
