import { describe, expect, it } from "vitest";

import {
    buildVendorProfiles,
    summarizeThreadCommunication,
    type POEmailRecord,
} from "./po-correlator";

describe("summarizeThreadCommunication", () => {
    it("detects when buildasoil already replied after a vendor response", () => {
        const summary = summarizeThreadCommunication([
            {
                payload: {
                    headers: [{ name: "From", value: "Bill Selee <bill.selee@buildasoil.com>" }],
                },
            },
            {
                payload: {
                    headers: [{ name: "From", value: "Ben Arends <barends@jabbspe.com>" }],
                },
            },
            {
                payload: {
                    headers: [{ name: "From", value: "Bill Selee <bill.selee@buildasoil.com>" }],
                },
            },
        ]);

        expect(summary.vendorReplyCount).toBe(1);
        expect(summary.buildasoilReplyCount).toBe(2);
        expect(summary.buildasoilRepliedAfterVendor).toBe(true);
        expect(summary.lastActor).toBe("buildasoil");
    });
});

describe("buildVendorProfiles", () => {
    it("tracks whether BuildASoil usually acknowledges vendor PO replies", () => {
        const records: POEmailRecord[] = [
            {
                messageId: "1",
                threadId: "t1",
                poNumber: "124564",
                vendorName: "JABB",
                vendorEmail: "barends@jabbspe.com",
                sentDate: "2026-03-30T10:00:00Z",
                subject: "PO 124564",
                vendorReplied: true,
                threadMessageCount: 3,
                trackingNumbers: [],
                snippet: "",
                buyerAcknowledgedVendorReply: true,
            },
            {
                messageId: "2",
                threadId: "t2",
                poNumber: "124565",
                vendorName: "JABB",
                vendorEmail: "barends@jabbspe.com",
                sentDate: "2026-03-29T10:00:00Z",
                subject: "PO 124565",
                vendorReplied: true,
                threadMessageCount: 2,
                trackingNumbers: [],
                snippet: "",
                buyerAcknowledgedVendorReply: false,
            },
        ];

        const profiles = buildVendorProfiles(records);

        expect(profiles).toHaveLength(1);
        expect(profiles[0].buyerAcknowledgementPattern).toBe("mixed");
        expect(profiles[0].buyerAcknowledgedVendorReplyCount).toBe(1);
        expect(profiles[0].vendorReplyCount).toBe(2);
    });
});
