/**
 * @file    overbill-grace.test.ts
 * @purpose Tests for the same-day overbill grace window.
 */
import { describe, it, expect } from "vitest";
import { isSameDenverDay, overbillGracePending } from "./overbill-grace";

const now = new Date("2026-10-28T16:00:00.000-06:00"); // Denver local

describe("isSameDenverDay", () => {
    it("true for a timestamp on the same Denver day", () => {
        expect(isSameDenverDay("2026-10-28T10:27:00.000-06:00", now)).toBe(true);
        expect(isSameDenverDay("2026-10-28T08:00:00.000Z", now)).toBe(true); // 2am Denver
    });

    it("false for a prior day", () => {
        expect(isSameDenverDay("2026-10-27T23:59:59.000-06:00", now)).toBe(false);
    });

    it("false for missing or unparseable timestamps", () => {
        expect(isSameDenverDay(null, now)).toBe(false);
        expect(isSameDenverDay(undefined, now)).toBe(false);
        expect(isSameDenverDay("garbage", now)).toBe(false);
    });
});

describe("overbillGracePending", () => {
    it("holds the flag when the receipt is stamped today", () => {
        expect(overbillGracePending("2026-10-28T14:00:00.000-06:00", now)).toBe(true);
    });

    it("releases the flag once the day has passed", () => {
        expect(overbillGracePending("2026-10-27T14:00:00.000-06:00", now)).toBe(false);
    });
});
