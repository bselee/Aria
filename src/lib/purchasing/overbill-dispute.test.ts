/**
 * @file    overbill-dispute.test.ts
 * @purpose Tests for the overbill hold flow and the vendor draft voice.
 */
import { describe, it, expect } from "vitest";
import { overbillDraftBody, shouldAutoResolve } from "./overbill-dispute";

describe("overbillDraftBody", () => {
    it("uses Bill's verbatim voice — grace first, no figures in the email", () => {
        const body = overbillDraftBody();
        expect(body).toBe(
            "Hey- Noticed the delivery did not match up with the invoice. What would you like to do?",
        );
        // The numbers stay in the dispute record, never in the email.
        expect(body).not.toMatch(/\$|PO \d/);
    });

    it("is short with no em or double dashes (Bill voice)", () => {
        const body = overbillDraftBody();
        expect(body.split(/\s+/).length).toBeLessThanOrEqual(45);
        expect(body).not.toMatch(/—|--/);
    });
});

describe("shouldAutoResolve", () => {
    const heldAt = "2026-10-28T10:00:00.000Z";

    it("resolves when a later bill lands at or below the delivered value", () => {
        const d = shouldAutoResolve(
            { poNumber: "PO-1", receivedValue: 1000, createdAt: heldAt },
            [{ total: 1000, createdAt: "2026-10-29T09:00:00.000Z" }],
        );
        expect(d.resolve).toBe(true);
        expect(d.reason).toContain("auto");
    });

    it("never resolves on a later bill that still exceeds the delivery", () => {
        const d = shouldAutoResolve(
            { poNumber: "PO-1", receivedValue: 1000, createdAt: heldAt },
            [{ total: 1500, createdAt: "2026-10-29T09:00:00.000Z" }],
        );
        expect(d.resolve).toBe(false);
    });

    it("refuses a later bill whose quantities do not match what was delivered", () => {
        const d = shouldAutoResolve(
            { poNumber: "PO-1", receivedValue: 1000, receivedQtySum: 50, createdAt: heldAt },
            [{ total: 600, createdAt: "2026-10-29T09:00:00.000Z", quantitySum: 20 }],
        );
        expect(d.resolve).toBe(false);
    });

    it("resolves when the later bill's quantities equal the delivered sum", () => {
        const d = shouldAutoResolve(
            { poNumber: "PO-1", receivedValue: 1000, receivedQtySum: 50, createdAt: heldAt },
            [{ total: 1000, createdAt: "2026-10-29T09:00:00.000Z", quantitySum: 50 }],
        );
        expect(d.resolve).toBe(true);
    });

    it("falls back to total-only when one side has no quantities", () => {
        const d = shouldAutoResolve(
            { poNumber: "PO-1", receivedValue: 1000, receivedQtySum: 50, createdAt: heldAt },
            [{ total: 1000, createdAt: "2026-10-29T09:00:00.000Z", quantitySum: null }],
        );
        expect(d.resolve).toBe(true);
    });

    it("ignores bills that predate the hold", () => {
        const d = shouldAutoResolve(
            { poNumber: "PO-1", receivedValue: 1000, createdAt: heldAt },
            [
                { total: 500, createdAt: "2026-10-27T09:00:00.000Z" },
                { total: 800, createdAt: "2026-10-26T09:00:00.000Z" },
            ],
        );
        expect(d.resolve).toBe(false);
    });
});
