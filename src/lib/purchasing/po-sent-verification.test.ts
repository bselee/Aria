import { describe, expect, it } from "vitest";

import { derivePOSentVerification } from "./po-sent-verification";

describe("derivePOSentVerification", () => {
    it("verifies a sent PO from a native send row", () => {
        const result = derivePOSentVerification({
            poNumber: "124790",
            purchaseOrder: {},
            sendRows: [{ sent_at: "2026-05-01T12:00:00.000Z" }],
            hasTracking: false,
        });

        expect(result).toMatchObject({
            verified: true,
            sentAt: "2026-05-01T12:00:00.000Z",
            source: "po_send",
        });
    });

    it("does not treat a commit-only po_sends row as sent verification", () => {
        const result = derivePOSentVerification({
            poNumber: "124790",
            purchaseOrder: {},
            sendRows: [{ committed_at: "2026-05-01T12:00:00.000Z", sent_at: null }],
            hasTracking: false,
        });

        expect(result).toMatchObject({
            verified: false,
            sentAt: null,
            source: null,
        });
    });

    it("verifies a sent PO from tracking evidence even when send evidence is missing", () => {
        const result = derivePOSentVerification({
            poNumber: "124790",
            purchaseOrder: { po_sent_at: null },
            sendRows: [],
            hasTracking: true,
        });

        expect(result).toMatchObject({
            verified: true,
            source: "tracking",
        });
        expect(result.evidence.some((entry) => entry.type === "tracking")).toBe(true);
    });

    it("uses vendor reply evidence as sent verification", () => {
        const result = derivePOSentVerification({
            poNumber: "124790",
            purchaseOrder: {
                vendor_acknowledged_at: "2026-05-02T09:15:00.000Z",
                vendor_ack_source: "gmail_thread",
            },
            sendRows: [],
            hasTracking: false,
        });

        expect(result).toMatchObject({
            verified: true,
            sentAt: "2026-05-02T09:15:00.000Z",
            source: "vendor_reply",
        });
    });

    it("keeps the PO unverified when no evidence exists", () => {
        const result = derivePOSentVerification({
            poNumber: "124790",
            purchaseOrder: {},
            sendRows: [],
            hasTracking: false,
        });

        expect(result).toMatchObject({
            verified: false,
            sentAt: null,
            source: null,
        });
    });
});
