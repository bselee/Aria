/**
 * @file    email-response-policy.test.ts
 * @purpose Lock draft-never-send policy for reviewable mail.
 */
import { describe, expect, it } from "vitest";
import {
    composeRoutineDraftBody,
    resolveEmailResponsePolicy,
} from "./email-response-policy";

describe("resolveEmailResponsePolicy", () => {
    it("never allows auto-send on routine PO/tracking", () => {
        const p = resolveEmailResponsePolicy({
            intent: "ROUTINE_INFO",
            isPurchaseThread: true,
        });
        expect(p.allowAutoSend).toBe(false);
        expect(p.createDraft).toBe(true);
        expect(p.action).toBe("DRAFT_ROUTINE");
        expect(p.labels).toContain("Draft Ready");
    });

    it("archives promo with no draft", () => {
        const p = resolveEmailResponsePolicy({ intent: "PROMOTIONAL" });
        expect(p.action).toBe("ARCHIVE");
        expect(p.createDraft).toBe(false);
        expect(p.allowAutoSend).toBe(false);
    });

    it("opportunity = draft + task, never send", () => {
        const p = resolveEmailResponsePolicy({ intent: "VENDOR_OPPORTUNITY" });
        expect(p.action).toBe("DRAFT_OPPORTUNITY");
        expect(p.allowAutoSend).toBe(false);
        expect(p.createDraft).toBe(true);
        expect(p.openResponseTask).toBe(true);
    });

    it("human escalate = draft stub + task, never send", () => {
        const p = resolveEmailResponsePolicy({ intent: "REQUIRES_HUMAN" });
        expect(p.action).toBe("ESCALATE_HUMAN");
        expect(p.allowAutoSend).toBe(false);
        expect(p.createDraft).toBe(true);
        expect(p.openResponseTask).toBe(true);
    });

    it("silent when already in conversation", () => {
        const p = resolveEmailResponsePolicy({
            intent: "ROUTINE_INFO",
            buildasoilAlreadyRepliedInThread: true,
        });
        expect(p.action).toBe("SILENT");
        expect(p.createDraft).toBe(false);
    });
});

describe("composeRoutineDraftBody", () => {
    it("is more specific than bare received thanks for shipping", () => {
        const body = composeRoutineDraftBody({
            from: "Cooper <cooper@example.com>",
            subject: "BuildASoil PO # 125165",
            bodyText: "This will ship Monday. ETA Friday.",
        });
        expect(body.toLowerCase()).not.toMatch(/^received, thank you/);
        expect(body).toMatch(/Cooper/);
        expect(body).toMatch(/ship|thanks/i);
        expect(body).not.toMatch(/BuildASoil Purchasing/);
    });

    it("simple restock confirm is just Thanks! style", () => {
        const body = composeRoutineDraftBody({
            from: "cs@herbsnow.com",
            subject: "Re: order",
            bodyText: "Sounds good! I'll send over an invoice as soon as we're restocked.\n\nBest regards,\nCari",
        });
        expect(body.toLowerCase()).toMatch(/thanks/);
        expect(body.toLowerCase()).not.toMatch(/looking into/);
        expect(body).not.toMatch(/BuildASoil Purchasing/);
    });
});
