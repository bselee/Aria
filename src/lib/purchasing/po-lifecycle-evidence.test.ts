import { describe, expect, it } from "vitest";
import {
    appendShippingEvidence,
    findLatestTrustworthyTrackingEvidence,
    summarizeMovementUpdate,
    type POShippingEvidence,
} from "./po-lifecycle-evidence";

describe("appendShippingEvidence", () => {
    it("deduplicates repeated evidence from the same source and summary", () => {
        const existing: POShippingEvidence[] = [{
            kind: "vendor_eta",
            source: "po_thread_sync",
            happenedAt: "2026-04-10T09:00:00Z",
            summary: "Vendor ETA Apr 15",
            trustworthyTracking: false,
        }];

        const merged = appendShippingEvidence(existing, {
            kind: "vendor_eta",
            source: "po_thread_sync",
            happenedAt: "2026-04-10T09:00:00Z",
            summary: "Vendor ETA Apr 15",
            trustworthyTracking: false,
        });

        expect(merged).toHaveLength(1);
    });
});

describe("findLatestTrustworthyTrackingEvidence", () => {
    it("returns the newest trustworthy tracking-style evidence", () => {
        const latest = findLatestTrustworthyTrackingEvidence([
            {
                kind: "vendor_eta",
                source: "po_thread_sync",
                happenedAt: "2026-04-10T09:00:00Z",
                summary: "Vendor ETA Apr 15",
                trustworthyTracking: false,
            },
            {
                kind: "tracking",
                source: "email_tracking",
                happenedAt: "2026-04-11T09:00:00Z",
                summary: "FedEx in transit",
                trustworthyTracking: true,
            },
            {
                kind: "tracking",
                source: "po_thread_sync",
                happenedAt: "2026-04-12T12:00:00Z",
                summary: "FedEx out for delivery",
                trustworthyTracking: true,
            },
        ]);

        expect(latest?.summary).toBe("FedEx out for delivery");
    });
});

describe("summarizeMovementUpdate", () => {
    it("returns a new summary only when trusted movement materially changes", () => {
        const movement = summarizeMovementUpdate(
            "FedEx in transit",
            {
                kind: "tracking",
                source: "email_tracking",
                happenedAt: "2026-04-12T12:00:00Z",
                summary: "FedEx out for delivery",
                trustworthyTracking: true,
            },
        );

        expect(movement).toBe("FedEx out for delivery");
    });

    it("returns null when the movement summary has not changed", () => {
        const movement = summarizeMovementUpdate(
            "FedEx out for delivery",
            {
                kind: "tracking",
                source: "email_tracking",
                happenedAt: "2026-04-12T12:00:00Z",
                summary: "FedEx out for delivery",
                trustworthyTracking: true,
            },
        );

        expect(movement).toBeNull();
    });
});
