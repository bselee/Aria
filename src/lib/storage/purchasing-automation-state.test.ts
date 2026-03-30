import { describe, expect, it } from "vitest";

import {
    buildPurchasingAutomationStatePayload,
    normalizeVendorAutomationKey,
} from "./purchasing-automation-state";

describe("normalizeVendorAutomationKey", () => {
    it("normalizes vendor names into stable automation keys", () => {
        expect(normalizeVendorAutomationKey(" Sustainable Village ")).toBe("sustainable-village");
        expect(normalizeVendorAutomationKey("ULINE")).toBe("uline");
    });
});

describe("buildPurchasingAutomationStatePayload", () => {
    it("builds a bounded payload with watermarks, constraints, and override memory", () => {
        const payload = buildPurchasingAutomationStatePayload({
            vendorName: "ULINE",
            lastProcessedOrderRef: "205814897",
            cooldownUntil: "2026-03-31T12:00:00.000Z",
            constraints: {
                minimumOrderValue: 150,
                notes: "Avoid tiny orders.",
            },
            overrideMemory: {
                "S-3902": {
                    quantityBias: 500,
                    note: "Will consistently sizes this one up for freight cadence.",
                },
            },
        });

        expect(payload).toMatchObject({
            vendor_key: "uline",
            vendor_name: "ULINE",
            last_processed_order_ref: "205814897",
            cooldown_until: "2026-03-31T12:00:00.000Z",
            constraints: {
                minimumOrderValue: 150,
                notes: "Avoid tiny orders.",
            },
            override_memory: {
                "S-3902": {
                    quantityBias: 500,
                    note: "Will consistently sizes this one up for freight cadence.",
                },
            },
        });
        expect(payload.updated_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
});
