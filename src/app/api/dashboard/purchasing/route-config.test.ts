import { describe, expect, it } from "vitest";

import { resolvePurchasingCacheTtlMs } from "./route-config";

describe("dashboard purchasing route config", () => {
    it("defaults cache TTL to 6 hours", () => {
        expect(resolvePurchasingCacheTtlMs(undefined)).toBe(6 * 60 * 60 * 1000);
        expect(resolvePurchasingCacheTtlMs("")).toBe(6 * 60 * 60 * 1000);
    });

    it("accepts a valid env override in hours", () => {
        expect(resolvePurchasingCacheTtlMs("4")).toBe(4 * 60 * 60 * 1000);
        expect(resolvePurchasingCacheTtlMs("5")).toBe(5 * 60 * 60 * 1000);
    });

    it("clamps invalid values back to the safe 4-6 hour band", () => {
        expect(resolvePurchasingCacheTtlMs("2")).toBe(6 * 60 * 60 * 1000);
        expect(resolvePurchasingCacheTtlMs("12")).toBe(6 * 60 * 60 * 1000);
        expect(resolvePurchasingCacheTtlMs("nope")).toBe(6 * 60 * 60 * 1000);
    });
});
