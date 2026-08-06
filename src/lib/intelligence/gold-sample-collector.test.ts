/**
 * @file    gold-sample-collector.test.ts
 * @purpose Unit tests for gold-sample collector — mockable Gmail + DB.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { collectGoldSamples } from "./gold-sample-collector";

const { recordFeedbackMock } = vi.hoisted(() => ({
    recordFeedbackMock: vi.fn().mockResolvedValue(undefined),
}));

// Return value for the final .limit() call
let dbLimitResult: any = { data: [], error: null };

vi.mock("../db", () => ({
    createClient: vi.fn(() => ({
        from: vi.fn(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    gte: vi.fn(() => ({
                        lt: vi.fn(() => ({
                            order: vi.fn(() => ({
                                limit: vi.fn(() => dbLimitResult),
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

vi.mock("./feedback-loop", () => ({
    recordFeedback: (...args: any[]) => recordFeedbackMock(...args),
}));

afterEach(() => {
    vi.clearAllMocks();
});

describe("collectGoldSamples", () => {
    it("returns empty when DB has no draft events", async () => {
        // Mock the select→from→eq→gte→lt→order→limit chain
        dbLimitResult = { data: [], error: null };

        const gmail = {} as any;
        const result = await collectGoldSamples(gmail, "bill@buildasoil.com");

        expect(result.scanned).toBe(0);
        expect(result.goldCollected).toBe(0);
    });

    it("collects a gold sample when Bill sent in the thread", async () => {
        // Return one draft event
        const draftEvent = {
            id: 44,
            event_type: "email_draft_prepared",
            subject_id: "gmail-msg-123",
            prediction: {
                action: "draft",
                kind: "opportunity",
                threadId: "thread-abc",
                replyBody: "Draft body that Bill will edit.",
                draftId: "draft-1",
            },
            actual_outcome: {
                fromEmail: "jessica@ambiochar.com",
            },
        };
        const limitMock = vi.fn().mockResolvedValue({ data: [draftEvent], error: null });
        dbLimitResult = { data: [draftEvent], error: null };

        // Mock Gmail: Bill sent a reply
        const gmail = {
            users: {
                messages: {
                    list: vi.fn().mockResolvedValue({
                        data: {
                            messages: [
                                { id: "sent-1", threadId: "thread-abc" },
                                { id: "sent-2", threadId: "other-thread" },
                            ],
                        },
                    }),
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                mimeType: "text/plain",
                                body: { data: Buffer.from("Final sent body.").toString("base64") },
                            },
                        },
                    }),
                },
            },
        };

        const result = await collectGoldSamples(gmail, "bill@buildasoil.com");

        expect(result.goldCollected).toBe(1);
        expect(recordFeedbackMock).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: "email_gold_sample",
                prediction: expect.objectContaining({
                    draftBody: "Draft body that Bill will edit.",
                    sentBody: "Final sent body.",
                }),
            }),
        );
    });

    it("marks noReplyYet when Bill has not sent in thread", async () => {
        const draftEvent = {
            id: 45,
            event_type: "email_draft_prepared",
            subject_id: "gmail-msg-456",
            prediction: {
                action: "draft",
                kind: "routine",
                threadId: "thread-pending",
                replyBody: "Waiting.",
            },
            actual_outcome: { fromEmail: "shipping@vendor.com" },
        };
        dbLimitResult = { data: [draftEvent], error: null };

        const gmail = {
            users: {
                messages: {
                    list: vi.fn().mockResolvedValue({
                        data: { messages: [] },
                    }),
                },
            },
        };

        const result = await collectGoldSamples(gmail, "bill@buildasoil.com");

        expect(result.noReplyYet).toBe(1);
        expect(result.goldCollected).toBe(0);
    });
});
