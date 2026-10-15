/**
 * @file    rate-limit-backoff.test.ts
 * @purpose Unit tests for the Finale 429 cooldown policy.
 * @author  Hermia
 * @created 2026-10-15
 */
import { describe, expect, it } from "vitest";
import {
    BASE_COOLDOWN_MS,
    MAX_COOLDOWN_MS,
    nextCooldownMs,
    parseRetryAfterMs,
} from "./rate-limit-backoff";

describe("nextCooldownMs", () => {
    it("starts at the base cooldown and doubles per consecutive 429", () => {
        expect(nextCooldownMs(0)).toBe(BASE_COOLDOWN_MS);
        expect(nextCooldownMs(1)).toBe(BASE_COOLDOWN_MS * 2);
        expect(nextCooldownMs(2)).toBe(BASE_COOLDOWN_MS * 4);
        expect(nextCooldownMs(3)).toBe(BASE_COOLDOWN_MS * 8);
    });

    it("stops doubling and never exceeds the cap", () => {
        expect(nextCooldownMs(4)).toBe(MAX_COOLDOWN_MS);
        expect(nextCooldownMs(50)).toBe(MAX_COOLDOWN_MS);
    });

    it("honours a longer Retry-After from the server", () => {
        expect(nextCooldownMs(0, 30_000)).toBe(30_000);
        // ...but a shorter one does not undercut our own backoff.
        expect(nextCooldownMs(2, 1_000)).toBe(BASE_COOLDOWN_MS * 4);
        // ...and the cap still applies.
        expect(nextCooldownMs(0, 10 * 60_000)).toBe(MAX_COOLDOWN_MS);
    });

    it("treats a missing or null Retry-After as no constraint", () => {
        expect(nextCooldownMs(1, null)).toBe(BASE_COOLDOWN_MS * 2);
        expect(nextCooldownMs(1, undefined)).toBe(BASE_COOLDOWN_MS * 2);
    });

    it("clamps nonsense input instead of going negative or NaN", () => {
        expect(nextCooldownMs(-5)).toBe(BASE_COOLDOWN_MS);
        expect(nextCooldownMs(Number.NaN)).toBe(BASE_COOLDOWN_MS);
    });
});

describe("parseRetryAfterMs", () => {
    const NOW = Date.parse("2026-10-15T12:00:00Z");

    it("reads delta-seconds", () => {
        expect(parseRetryAfterMs("5", NOW)).toBe(5_000);
        expect(parseRetryAfterMs(" 30 ", NOW)).toBe(30_000);
    });

    it("reads an HTTP date relative to now", () => {
        expect(parseRetryAfterMs("Thu, 15 Oct 2026 12:00:20 GMT", NOW)).toBe(20_000);
        // A date in the past means no wait, never a negative one.
        expect(parseRetryAfterMs("Thu, 15 Oct 2026 11:59:00 GMT", NOW)).toBe(0);
    });

    it("returns null when absent or unparseable", () => {
        expect(parseRetryAfterMs(null, NOW)).toBeNull();
        expect(parseRetryAfterMs("", NOW)).toBeNull();
        expect(parseRetryAfterMs("soon", NOW)).toBeNull();
    });
});
