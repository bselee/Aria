import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    anthropicCreateMock,
    recallMock,
    supabaseState,
} = vi.hoisted(() => ({
    anthropicCreateMock: vi.fn(),
    recallMock: vi.fn(),
    supabaseState: {
        tasks: [] as Array<Record<string, any>>,
        updates: [] as Array<Record<string, any>>,
    },
}));

vi.mock("os", () => ({
    default: {
        freemem: () => 8 * 1024 * 1024 * 1024,
    },
}));

vi.mock("../anthropic", () => ({
    getAnthropicClient: () => ({
        messages: {
            create: anthropicCreateMock,
        },
    }),
}));

vi.mock("./memory", () => ({
    recall: recallMock,
}));

vi.mock("../db", () => ({
    createClient: () => ({
        from: (table: string) => {
            if (table !== "nightshift_queue") {
                throw new Error(`Unexpected table ${table}`);
            }

            return {
                select: () => ({
                    eq: () => ({
                        gt: () => ({
                            order: () => ({
                                limit: async () => ({ data: supabaseState.tasks, error: null }),
                            }),
                        }),
                    }),
                }),
                update: (values: Record<string, unknown>) => {
                    supabaseState.updates.push(values);
                    const query: any = {
                        eq: () => query,
                        lt: async () => ({ data: null, error: null }),
                        select: async () => ({ data: [{ id: "task-1" }], error: null }),
                    };
                    return query;
                },
                delete: () => ({
                    lt: async () => ({ data: null, error: null }),
                }),
            };
        },
    }),
}));

import { runNightshiftLoop } from "./nightshift-agent";

describe("runNightshiftLoop", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        supabaseState.tasks = [
            {
                id: "task-1",
                gmail_message_id: "gmail-1",
                task_type: "email_classification",
                payload: {
                    from_email: "promo@example.com",
                    subject: "Spring deals",
                    body_snippet: "Save now on supplies",
                },
            },
        ];
        supabaseState.updates = [];
        recallMock.mockResolvedValue([]);
        anthropicCreateMock.mockResolvedValue({
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        classification: "ADVERTISEMENT",
                        confidence: 0.99,
                        reasoning: "marketing email",
                    }),
                },
            ],
        });
        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("local llm must not be called");
        }));
    });

    it("classifies pending email tasks with Haiku without calling a local LLM", async () => {
        await runNightshiftLoop();

        expect(fetch).not.toHaveBeenCalled();
        expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    });
});
