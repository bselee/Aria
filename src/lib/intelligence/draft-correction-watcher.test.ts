/**
 * @file    draft-correction-watcher.test.ts
 * @purpose Unit tests for the draft correction watcher — mockable Gmail + DB.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { watchDraftCorrections } from "./draft-correction-watcher";

const { learnReplyRuleMock } = vi.hoisted(() => ({
    learnReplyRuleMock: vi.fn().mockResolvedValue(undefined),
}));

let dbSelectResult: any = { data: [], error: null };

vi.mock("../db", () => ({
    createClient: vi.fn(() => ({
        from: vi.fn(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    gte: vi.fn(() => ({
                        lt: vi.fn(() => ({
                            order: vi.fn(() => ({
                                limit: vi.fn(() => dbSelectResult),
                            })),
                        })),
                    })),
                })),
            })),
            update: vi.fn(() => ({
                eq: vi.fn(() => Promise.resolve({ error: null })),
            })),
        })),
    })),
}));

vi.mock("./email-reply-rules", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./email-reply-rules")>();
    return {
        ...actual,
        learnReplyRule: (...args: any[]) => learnReplyRuleMock(...args),
    };
});

afterEach(() => {
    vi.clearAllMocks();
});

function draftEvent(overrides: Record<string, any> = {}) {
    return {
        id: 44,
        event_type: "email_draft_prepared",
        subject_id: "gmail-msg-123",
        prediction: {
            action: "draft",
            kind: "routine",
            threadId: "thread-abc",
            replyBody: "Hi Donna,\n\nThanks — I'll follow up shortly.\n\nThanks!",
            draftId: "draft-1",
            firstName: "Donna",
        },
        actual_outcome: {
            fromEmail: "Donna Padilla <donna@crminerals.com>",
            subject: "BuildASoil PO #125180 - CR Minerals",
        },
        ...overrides,
    };
}

describe("watchDraftCorrections", () => {
    it("returns empty when no draft events", async () => {
        dbSelectResult = { data: [], error: null };
        const result = await watchDraftCorrections({} as any, "bill@buildasoil.com");
        expect(result.scanned).toBe(0);
        expect(result.learned).toBe(0);
    });

    it("learns a template rule when Bill edited the draft before sending", async () => {
        dbSelectResult = { data: [draftEvent()], error: null };

        const gmail = {
            users: {
                messages: {
                    list: vi.fn().mockResolvedValue({
                        data: { messages: [{ id: "sent-1", threadId: "thread-abc" }] },
                    }),
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                mimeType: "text/plain",
                                body: { data: Buffer.from("Thanks Donna").toString("base64") },
                            },
                        },
                    }),
                },
            },
        };

        const result = await watchDraftCorrections(gmail, "bill@buildasoil.com");

        expect(result.learned).toBe(1);
        expect(learnReplyRuleMock).toHaveBeenCalledWith(
            expect.objectContaining({
                vendorKey: "crminerals.com",
                context: "po_ack",
                ruleType: "template",
                template: "Thanks {name}",
            }),
        );
    });

    it("confirms unchanged when Bill sent the draft as-is", async () => {
        dbSelectResult = {
            data: [draftEvent({ prediction: {
                action: "draft", kind: "routine", threadId: "thread-abc",
                replyBody: "Thanks!", draftId: "draft-1", firstName: "Donna",
            }})],
            error: null,
        };

        const gmail = {
            users: {
                messages: {
                    list: vi.fn().mockResolvedValue({
                        data: { messages: [{ id: "sent-1", threadId: "thread-abc" }] },
                    }),
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                mimeType: "text/plain",
                                body: { data: Buffer.from("Thanks!").toString("base64") },
                            },
                        },
                    }),
                },
            },
        };

        const result = await watchDraftCorrections(gmail, "bill@buildasoil.com");
        expect(result.confirmed).toBe(1);
        expect(result.learned).toBe(0);
        expect(learnReplyRuleMock).not.toHaveBeenCalled();
    });

    it("learns a no_reply rule when the draft was deleted unsent", async () => {
        dbSelectResult = { data: [draftEvent()], error: null };

        const gmail = {
            users: {
                messages: {
                    list: vi.fn().mockResolvedValue({ data: { messages: [] } }),
                },
                drafts: {
                    get: vi.fn().mockRejectedValue(new Error("404 not found")),
                },
            },
        };

        const result = await watchDraftCorrections(gmail, "bill@buildasoil.com");

        expect(result.noReplyRules).toBe(1);
        expect(learnReplyRuleMock).toHaveBeenCalledWith(
            expect.objectContaining({
                ruleType: "no_reply",
                vendorKey: "crminerals.com",
                context: "po_ack",
            }),
        );
    });

    it("marks pending when no sent reply and the draft still exists", async () => {
        dbSelectResult = { data: [draftEvent()], error: null };

        const gmail = {
            users: {
                messages: {
                    list: vi.fn().mockResolvedValue({ data: { messages: [] } }),
                },
                drafts: {
                    get: vi.fn().mockResolvedValue({ data: { id: "draft-1" } }),
                },
            },
        };

        const result = await watchDraftCorrections(gmail, "bill@buildasoil.com");
        expect(result.pending).toBe(1);
        expect(learnReplyRuleMock).not.toHaveBeenCalled();
    });
});
