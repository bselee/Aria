import { describe, expect, it } from "vitest";

import {
    shouldAutoCreateDraftPO,
    shouldVendorUseAutomation,
} from "./vendor-automation-policy";

describe("shouldVendorUseAutomation", () => {
    it("allows trusted repeatable vendors", () => {
        expect(shouldVendorUseAutomation("ULINE")).toBe(true);
        expect(shouldVendorUseAutomation("Axiom")).toBe(true);
        expect(shouldVendorUseAutomation("Sustainable Village")).toBe(true);
    });

    it("keeps non-trusted vendors manual by default", () => {
        expect(shouldVendorUseAutomation("Random Vendor")).toBe(false);
    });
});

describe("shouldAutoCreateDraftPO", () => {
    it("allows high-confidence actionable manifests for trusted vendors", () => {
        expect(shouldAutoCreateDraftPO({
            vendorName: "ULINE",
            actionableCount: 3,
            blockedCount: 0,
            highestConfidence: "high",
            cooldownActive: false,
        })).toBe(true);
    });

    it("blocks low-confidence or mostly-held manifests", () => {
        expect(shouldAutoCreateDraftPO({
            vendorName: "ULINE",
            actionableCount: 1,
            blockedCount: 4,
            highestConfidence: "medium",
            cooldownActive: false,
        })).toBe(false);
    });

    it("blocks duplicate auto-drafts while cooldown is active", () => {
        expect(shouldAutoCreateDraftPO({
            vendorName: "Axiom",
            actionableCount: 2,
            blockedCount: 0,
            highestConfidence: "high",
            cooldownActive: true,
        })).toBe(false);
    });
});
