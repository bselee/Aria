import { describe, expect, it } from "vitest";
import { derivePOLifecycleState, shouldRequestTrackingFollowUp, type POLifecycleEvidenceInput } from "./po-lifecycle-state";

function buildInput(overrides: Partial<POLifecycleEvidenceInput> = {}): POLifecycleEvidenceInput {
    return {
        shippingEvidence: [],
        receiveDate: null,
        completionState: null,
        trackingRequestedAt: null,
        trackingRequestCount: 0,
        lastMovementSummary: null,
        ...overrides,
    };
}

describe("derivePOLifecycleState", () => {
    it("returns draft_created when there is no commit evidence yet", () => {
        expect(derivePOLifecycleState(buildInput())).toBe("draft_created");
    });

    it("returns sent once the PO email has been sent", () => {
        expect(derivePOLifecycleState(buildInput({
            committedAt: "2026-04-09T10:00:00Z",
            poSentAt: "2026-04-09T10:05:00Z",
        }))).toBe("sent");
    });

    it("returns vendor_acknowledged when the vendor has replied but no shipping evidence exists", () => {
        expect(derivePOLifecycleState(buildInput({
            committedAt: "2026-04-09T10:00:00Z",
            poSentAt: "2026-04-09T10:05:00Z",
            vendorAcknowledgedAt: "2026-04-09T13:00:00Z",
        }))).toBe("vendor_acknowledged");
    });

    it("returns in_transit for invoice or shipping-context evidence without trustworthy tracking", () => {
        expect(derivePOLifecycleState(buildInput({
            committedAt: "2026-04-09T10:00:00Z",
            poSentAt: "2026-04-09T10:05:00Z",
            shippingEvidence: [{
                kind: "invoice_shipment",
                source: "ap_invoice",
                happenedAt: "2026-04-10T09:00:00Z",
                summary: "Invoice arrived with freight and shipment context",
                trustworthyTracking: false,
            }],
        }))).toBe("in_transit");
    });

    it("returns moving_with_tracking for trustworthy tracking evidence", () => {
        expect(derivePOLifecycleState(buildInput({
            committedAt: "2026-04-09T10:00:00Z",
            poSentAt: "2026-04-09T10:05:00Z",
            shippingEvidence: [{
                kind: "tracking",
                source: "email_tracking",
                happenedAt: "2026-04-10T09:00:00Z",
                summary: "FedEx 123 is in transit",
                trustworthyTracking: true,
            }],
        }))).toBe("moving_with_tracking");
    });

    it("returns received once receipt evidence exists", () => {
        expect(derivePOLifecycleState(buildInput({
            receiveDate: "2026-04-12",
        }))).toBe("received");
    });

    it("returns ap_follow_up after receipt while AP completion is still pending", () => {
        expect(derivePOLifecycleState(buildInput({
            receiveDate: "2026-04-12",
            completionState: "received_pending_invoice",
        }))).toBe("ap_follow_up");
    });

    it("returns complete only when receipt and AP completion are both done", () => {
        expect(derivePOLifecycleState(buildInput({
            receiveDate: "2026-04-12",
            completionState: "complete",
        }))).toBe("complete");
    });
});

describe("shouldRequestTrackingFollowUp", () => {
    it("returns false before the waiting threshold", () => {
        expect(shouldRequestTrackingFollowUp(buildInput({
            poSentAt: "2026-04-09T10:05:00Z",
        }), new Date("2026-04-10T10:00:00Z"))).toBe(false);
    });

    it("returns true when shipping evidence exists but trustworthy tracking is still missing and no recent ask was sent", () => {
        expect(shouldRequestTrackingFollowUp(buildInput({
            poSentAt: "2026-04-09T10:05:00Z",
            shippingEvidence: [{
                kind: "vendor_eta",
                source: "po_thread_sync",
                happenedAt: "2026-04-11T09:00:00Z",
                summary: "Vendor says shipment is leaving Friday",
                trustworthyTracking: false,
            }],
        }), new Date("2026-04-13T10:00:00Z"))).toBe(true);
    });

    it("returns false when trustworthy tracking already exists", () => {
        expect(shouldRequestTrackingFollowUp(buildInput({
            poSentAt: "2026-04-09T10:05:00Z",
            shippingEvidence: [{
                kind: "tracking",
                source: "email_tracking",
                happenedAt: "2026-04-11T09:00:00Z",
                summary: "UPS 1Z999 is in transit",
                trustworthyTracking: true,
            }],
        }), new Date("2026-04-13T10:00:00Z"))).toBe(false);
    });

    it("returns false when a recent tracking request is still in cooldown", () => {
        expect(shouldRequestTrackingFollowUp(buildInput({
            poSentAt: "2026-04-09T10:05:00Z",
            shippingEvidence: [{
                kind: "invoice_shipment",
                source: "ap_invoice",
                happenedAt: "2026-04-11T09:00:00Z",
                summary: "Invoice arrived with freight",
                trustworthyTracking: false,
            }],
            trackingRequestedAt: "2026-04-12T13:00:00Z",
            trackingRequestCount: 1,
        }), new Date("2026-04-13T10:00:00Z"))).toBe(false);
    });
});
