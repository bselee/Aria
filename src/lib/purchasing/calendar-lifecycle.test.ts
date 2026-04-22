import { describe, expect, it } from "vitest";
import {
    RECEIVED_CALENDAR_RETENTION_DAYS,
    RECEIVED_DASHBOARD_RETENTION_DAYS,
    daysSinceDate,
    derivePurchasingLifecycle,
    getPurchasingEventDate,
    shouldKeepReceivedPurchase,
} from "./calendar-lifecycle";

describe("calendar lifecycle", () => {
    it("marks fully delivered tracking as delivered awaiting receipt", () => {
        const lifecycle = derivePurchasingLifecycle("committed", [
            { category: "delivered", display: "Delivered Mar 30" },
            { category: "delivered", display: "Delivered Mar 30" },
        ]);

        expect(lifecycle.calendarStatus).toBe("delivered");
        expect(lifecycle.statusLabel).toBe("Delivered - Awaiting Receipt");
        expect(lifecycle.colorId).toBe("5");
    });

    it("keeps received purchases only within the configured retention windows", () => {
        const now = new Date("2026-03-30T12:00:00Z");

        expect(shouldKeepReceivedPurchase("2026-03-18", RECEIVED_CALENDAR_RETENTION_DAYS, now)).toBe(true);
        expect(shouldKeepReceivedPurchase("2026-03-15", RECEIVED_CALENDAR_RETENTION_DAYS, now)).toBe(false);
        expect(shouldKeepReceivedPurchase("2026-03-27", RECEIVED_DASHBOARD_RETENTION_DAYS, now)).toBe(true);
        expect(shouldKeepReceivedPurchase("2026-03-26", RECEIVED_DASHBOARD_RETENTION_DAYS, now)).toBe(false);
    });

    it("moves received events onto the actual receive date", () => {
        const lifecycle = derivePurchasingLifecycle("committed", [], "received_pending_invoice", "2026-03-25", "2026-03-30T08:15:00Z");
        expect(getPurchasingEventDate("2026-03-25", "2026-03-30T08:15:00Z", lifecycle)).toBe("2026-03-30");
    });

    it("computes date age in Denver-calendar days", () => {
        const now = new Date("2026-03-30T23:00:00Z");
        expect(daysSinceDate("2026-03-29T01:00:00Z", now)).toBe(1);
    });

    it("shows received but incomplete POs as a green received state", () => {
        const lifecycle = derivePurchasingLifecycle("completed", [], "received_pending_invoice");
        expect(lifecycle.isReceived).toBe(true);
        expect(lifecycle.colorId).toBe("2");
        expect(lifecycle.statusLabel).toBe("Received");
    });

    it("does not show completed+complete POs as received without actual receipt evidence", () => {
        // completionState === 'complete' means AP pipeline done, NOT physically received
        // A PO should only show as Received if hasPurchaseOrderReceipt returns true
        const lifecycle = derivePurchasingLifecycle("completed", [], "complete");
        expect(lifecycle.isReceived).toBe(false);
        expect(lifecycle.colorId).toBe("8"); // awaiting_tracking grey
    });

    it("shows received_pending_invoice as received (actual receipt exists)", () => {
        // This has isReceivedCompletionState = true, showing as received
        const lifecycle = derivePurchasingLifecycle("completed", [], "received_pending_invoice");
        expect(lifecycle.colorId).toBe("2");
        expect(lifecycle.statusLabel).toBe("Received");
    });

    it("does not infer received from completed alone without receipt evidence", () => {
        const lifecycle = derivePurchasingLifecycle("completed", [], null, "2026-03-25", null);
        expect(lifecycle.isReceived).toBe(false);
        expect(lifecycle.calendarStatus).toBe("past_due");
        expect(lifecycle.statusLabel).toBe("Past Due - Needs Review");
    });
});
