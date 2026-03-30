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
        expect(lifecycle.titleEmoji).toBe("🟡");
    });

    it("keeps received purchases only within the configured retention windows", () => {
        const now = new Date("2026-03-30T12:00:00Z");

        expect(shouldKeepReceivedPurchase("2026-03-18", RECEIVED_CALENDAR_RETENTION_DAYS, now)).toBe(true);
        expect(shouldKeepReceivedPurchase("2026-03-15", RECEIVED_CALENDAR_RETENTION_DAYS, now)).toBe(false);
        expect(shouldKeepReceivedPurchase("2026-03-27", RECEIVED_DASHBOARD_RETENTION_DAYS, now)).toBe(true);
        expect(shouldKeepReceivedPurchase("2026-03-26", RECEIVED_DASHBOARD_RETENTION_DAYS, now)).toBe(false);
    });

    it("moves received events onto the actual receive date", () => {
        const lifecycle = derivePurchasingLifecycle("completed");
        expect(getPurchasingEventDate("2026-03-25", "2026-03-30T08:15:00Z", lifecycle)).toBe("2026-03-30");
    });

    it("computes date age in Denver-calendar days", () => {
        const now = new Date("2026-03-30T23:00:00Z");
        expect(daysSinceDate("2026-03-29T01:00:00Z", now)).toBe(1);
    });
});
