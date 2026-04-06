import { describe, expect, it } from "vitest";

import {
    isSlackAutoDraftPOEnabled,
    resolveSlackPollInterval,
} from "./watchdog-config";

describe("watchdog-config", () => {
    it("defaults the Slack poll interval to 180 seconds", () => {
        expect(resolveSlackPollInterval(undefined)).toBe(180);
        expect(resolveSlackPollInterval("")).toBe(180);
    });

    it("accepts a valid explicit Slack poll interval", () => {
        expect(resolveSlackPollInterval("60")).toBe(60);
        expect(resolveSlackPollInterval("15")).toBe(15);
    });

    it("defaults auto draft PO creation to disabled", () => {
        expect(isSlackAutoDraftPOEnabled(undefined)).toBe(false);
        expect(isSlackAutoDraftPOEnabled("")).toBe(false);
        expect(isSlackAutoDraftPOEnabled("false")).toBe(false);
    });

    it("only enables auto draft PO creation for explicit true-like values", () => {
        expect(isSlackAutoDraftPOEnabled("true")).toBe(true);
        expect(isSlackAutoDraftPOEnabled("1")).toBe(true);
        expect(isSlackAutoDraftPOEnabled("yes")).toBe(true);
    });
});
