/**
 * @file    delivered-unreceived.test.ts
 * @purpose Thresholds for delivered-but-unreceived lag flags.
 */
import { describe, expect, it } from "vitest";
import {
    DELIVERED_ESCALATE_HOURS,
    DELIVERED_FLAG_HOURS,
    earliestDeliveredAt,
    formatReceiptLagBadge,
    hoursSinceDelivered,
    receiptLagLevel,
} from "./delivered-unreceived";

describe("delivered-unreceived thresholds", () => {
    it("exports 24h flag and 48h escalate", () => {
        expect(DELIVERED_FLAG_HOURS).toBe(24);
        expect(DELIVERED_ESCALATE_HOURS).toBe(48);
    });

    it("hoursSinceDelivered floors whole hours", () => {
        const now = Date.parse("2026-04-05T12:00:00.000Z");
        expect(hoursSinceDelivered("2026-04-04T12:00:00.000Z", now)).toBe(24);
        expect(hoursSinceDelivered("2026-04-03T12:00:00.000Z", now)).toBe(48);
        expect(hoursSinceDelivered(null, now)).toBeNull();
    });

    it("receiptLagLevel bands", () => {
        expect(receiptLagLevel(0)).toBe("ok");
        expect(receiptLagLevel(23)).toBe("ok");
        expect(receiptLagLevel(24)).toBe("flag");
        expect(receiptLagLevel(47)).toBe("flag");
        expect(receiptLagLevel(48)).toBe("escalate");
        expect(receiptLagLevel(100)).toBe("escalate");
        expect(receiptLagLevel(null)).toBe("ok");
    });

    it("earliestDeliveredAt picks min delivered_at among delivered legs", () => {
        expect(
            earliestDeliveredAt([
                { status_category: "in_transit", delivered_at: null },
                { status_category: "delivered", delivered_at: "2026-04-05T10:00:00.000Z" },
                { status_category: "delivered", delivered_at: "2026-04-04T08:00:00.000Z" },
            ]),
        ).toBe("2026-04-04T08:00:00.000Z");
    });

    it("formatReceiptLagBadge labels", () => {
        expect(formatReceiptLagBadge(12, "ok")).toMatch(/need receive/i);
        expect(formatReceiptLagBadge(30, "flag")).toBe("DELIVERED 30h · need receive");
        expect(formatReceiptLagBadge(55, "escalate")).toBe("DELIVERED 55h · OVERDUE receive");
    });
});
