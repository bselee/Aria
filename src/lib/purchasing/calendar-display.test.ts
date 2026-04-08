import { describe, expect, it } from "vitest";
import { derivePurchasingLifecycle } from "./calendar-lifecycle";
import {
    addCalendarDays,
    buildPurchasingCalendarEvent,
    buildPurchasingCalendarEventDescription,
    buildPurchasingCalendarEventTitle,
    buildTrackingEntries,
    formatCalendarDate,
    shouldSyncPurchasingCalendarEvent,
} from "./calendar-display";

describe("purchasing calendar display", () => {
    it("formats date-only PO values without timezone drift", () => {
        expect(formatCalendarDate("2026-04-16")).toBe("Apr 16, 2026");
        expect(addCalendarDays("2026-04-01", 14)).toBe("2026-04-15");
    });

    it("builds clean teammate-facing event text without mojibake or html tags", () => {
        const lifecycle = derivePurchasingLifecycle("committed");
        const title = buildPurchasingCalendarEventTitle({
            orderId: "124584",
            vendorName: "Biochar Solutions, llc",
        }, lifecycle);
        const description = buildPurchasingCalendarEventDescription({
            po: {
                orderId: "124584",
                orderDate: "2026-04-01",
                sentAt: "2026-04-03T16:45:00Z",
                receiveDate: null,
                items: [{ productId: "BC105L", quantity: 52 }],
                finaleUrl: "https://finale.example/po/124584",
            },
            expectedDate: "2026-04-15",
            leadProvenance: "14d default",
            trackingEntries: [],
            lifecycle,
        });

        expect(title).toBe("🔴 PO #124584 - Biochar Solutions, llc");
        expect(description).toContain("Sent: Apr 3, 2026");
        expect(description).toContain("Expected: Apr 15, 2026 (14d default)");
        expect(description).toContain("Tracking: Awaiting Tracking");
        expect(description).toContain("Items: BC105L x 52");
        expect(description).toContain("Receipt: Not Yet Received");
        expect(description).toContain("Finale PO: https://finale.example/po/124584");
        expect(description).not.toMatch(/[Ãâð]/);
        expect(description).not.toContain("<a");
        expect(description).not.toContain("<b>");
    });

    it("includes tracking urls and status when available", () => {
        const trackingEntries = buildTrackingEntries(["ups:::1Z999"], new Map([
            ["ups:::1Z999", {
                category: "in_transit",
                display: "Out for delivery",
                public_url: "https://track.example/1Z999",
            }],
        ]));

        const lifecycle = derivePurchasingLifecycle("committed");
        const event = buildPurchasingCalendarEvent({
            po: {
                orderId: "124585",
                vendorName: "Vendor",
                orderDate: "2026-04-02",
                receiveDate: null,
                items: [{ productId: "SPL101", quantity: 10 }],
                finaleUrl: "https://finale.example/po/124585",
            },
            lifecycle,
            expectedDate: "2026-04-16",
            leadProvenance: "14d default",
            trackingEntries,
            eventDate: "2026-04-16",
        });

        expect(event.description).toContain("- ups 1Z999 (Out for delivery)");
        expect(event.description).toContain("https://track.example/1Z999");
    });

    it("forces a resync when the rendered content changes even if tracking and status do not", () => {
        expect(shouldSyncPurchasingCalendarEvent(
            { status: "open", last_tracking: "", event_signature: "old" },
            { status: "open", trackingHash: "", signature: "new" },
        )).toBe(true);

        expect(shouldSyncPurchasingCalendarEvent(
            { status: "open", last_tracking: "", event_signature: "same" },
            { status: "open", trackingHash: "", signature: "same" },
        )).toBe(false);
    });
});
