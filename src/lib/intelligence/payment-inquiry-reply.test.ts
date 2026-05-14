import { describe, expect, it, afterEach } from "vitest";
import { pickTemplate, autoReplyEnabled } from "./payment-inquiry-reply";

describe("pickTemplate", () => {
    it("returns one of the five templates", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 200; i++) seen.add(pickTemplate());
        // With 200 tries across 5 templates, we should see at least 3 distinct
        // (deterministic only in the limit; this catches "always returns same").
        expect(seen.size).toBeGreaterThanOrEqual(3);
    });

    it("returns short non-robotic strings without templated boilerplate", () => {
        for (let i = 0; i < 20; i++) {
            const t = pickTemplate();
            expect(t.length).toBeLessThan(280);
            expect(t).not.toMatch(/dear (sir|madam)/i);
            expect(t).not.toMatch(/your inquiry has been received/i);
            expect(t).not.toMatch(/accounts payable system/i);
        }
    });

    it("every template mentions the Friday payment cycle", () => {
        // Vendors need a real expectation, not a hollow ack. The Friday
        // reference gives them concrete timing without naming a date.
        const seen = new Set<string>();
        for (let i = 0; i < 200; i++) seen.add(pickTemplate());
        for (const t of seen) {
            expect(t.toLowerCase()).toMatch(/friday/);
        }
    });
});

describe("autoReplyEnabled", () => {
    const original = process.env.PAYMENT_INQUIRY_AUTOREPLY_ENABLED;
    afterEach(() => {
        if (original === undefined) delete process.env.PAYMENT_INQUIRY_AUTOREPLY_ENABLED;
        else process.env.PAYMENT_INQUIRY_AUTOREPLY_ENABLED = original;
    });

    it("defaults to false", () => {
        delete process.env.PAYMENT_INQUIRY_AUTOREPLY_ENABLED;
        expect(autoReplyEnabled()).toBe(false);
    });

    it("accepts true/1/on (case-insensitive)", () => {
        for (const v of ["true", "TRUE", "1", "on", "On"]) {
            process.env.PAYMENT_INQUIRY_AUTOREPLY_ENABLED = v;
            expect(autoReplyEnabled()).toBe(true);
        }
    });

    it("rejects false/0/off and arbitrary strings", () => {
        for (const v of ["false", "0", "off", "no", "maybe"]) {
            process.env.PAYMENT_INQUIRY_AUTOREPLY_ENABLED = v;
            expect(autoReplyEnabled()).toBe(false);
        }
    });
});
