import { describe, expect, it } from "vitest";
import {
    getActivityIntentLabel,
    getNextHumanAction,
    getActivityLink,
} from "./activityWorkflow";

describe("ActivityTerminal helpers", () => {
    it("displays legacy human interaction events as EYES_NEEDED", () => {
        expect(getActivityIntentLabel("HUMAN_INTERACTION")).toBe("EYES_NEEDED");
        expect(getActivityIntentLabel("HUMAN_INTERACT")).toBe("EYES_NEEDED");
        expect(getActivityIntentLabel("EYES_NEEDED")).toBe("EYES_NEEDED");
    });

    it("provides a human next step for email attention events", () => {
        const action = getNextHumanAction({
            kind: "ap",
            row: {
                id: "1",
                created_at: "2026-05-14T14:00:00Z",
                email_from: "Vendor Support <vendor@example.com>",
                email_subject: "Payment question",
                intent: "EYES_NEEDED",
                action_taken: "Left email visible from Vendor Support <vendor@example.com>",
                metadata: { reasonCode: "human_interaction_manual_review" },
                reviewed_at: null,
                reviewed_action: null,
            },
        });

        expect(action).toBe("next: review/reply to email from vendor@example.com");
    });

    it("links attention emails to a Gmail search", () => {
        const link = getActivityLink({
            kind: "ap",
            row: {
                id: "1",
                created_at: "2026-05-14T14:00:00Z",
                email_from: "Vendor Support <vendor@example.com>",
                email_subject: "Payment question",
                intent: "EYES_NEEDED",
                action_taken: "Left email visible from Vendor Support <vendor@example.com>",
                metadata: { gmailMessageId: "abc" },
                reviewed_at: null,
                reviewed_action: null,
            },
        });

        expect(link?.label).toBe("open email");
        expect(link?.href).toContain("mail.google.com");
        expect(link?.href).toContain("from%3Avendor%40example.com");
        expect(link?.href).toContain("Payment%20question");
    });
});
