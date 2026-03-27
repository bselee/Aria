import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the LLM layer so tests don't hit real APIs
vi.mock("../intelligence/llm", () => ({
    unifiedTextGeneration: vi.fn().mockResolvedValue("Stock for KM106: 240 units on hand."),
    unifiedToolTextGeneration: vi.fn().mockResolvedValue({
        text:         "Here are the recent open purchase orders.",
        providerUsed: "test-provider",
        toolCalls:    ["query_purchase_orders"],
    }),
}));

// Mock Supabase so context fetch doesn't require real DB
vi.mock("../supabase", () => ({
    createClient: vi.fn().mockReturnValue(null),
}));

import { unifiedToolTextGeneration } from "../intelligence/llm";
import { runCopilotTurn } from "./core";

describe("runCopilotTurn", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uses shared tools for normal Q&A from telegram", async () => {
        const result = await runCopilotTurn({
            channel:  "telegram",
            text:     "consumption for KM106",
            threadId: "chat-123",
        });

        expect(result.reply).toBeTruthy();
    });

    it("uses shared tools for normal Q&A from dashboard", async () => {
        const result = await runCopilotTurn({
            channel:  "dashboard",
            text:     "recent open POs",
            threadId: "session-456",
        });

        expect(result.reply).toBe("Here are the recent open purchase orders.");
        expect(result.providerUsed).toBe("test-provider");
        expect(result.toolCalls).toEqual(["query_purchase_orders"]);
        expect(vi.mocked(unifiedToolTextGeneration)).toHaveBeenCalledOnce();
        expect(vi.mocked(unifiedToolTextGeneration).mock.calls[0][0].tools).toHaveProperty("query_purchase_orders");
    });

    it("returns providerUsed field", async () => {
        const result = await runCopilotTurn({
            channel:  "telegram",
            text:     "what is stock for PU102",
            threadId: "chat-123",
        });

        expect(result.providerUsed).toBeTruthy();
    });

    it("returns same reply shape from telegram and dashboard", async () => {
        const tg = await runCopilotTurn({ channel: "telegram",  text: "recent POs", threadId: "t1" });
        const dash = await runCopilotTurn({ channel: "dashboard", text: "recent POs", threadId: "t1" });

        expect(tg.reply).toBeTruthy();
        expect(dash.reply).toBeTruthy();
        expect(typeof tg.reply).toBe("string");
        expect(typeof dash.reply).toBe("string");
    });

    it("accepts pre-built context override for testing", async () => {
        const result = await runCopilotTurn({
            channel:  "telegram",
            text:     "add these to PO",
            threadId: "t1",
            contextOverride: {
                recentArtifacts: [
                    { artifactId: "art1", summary: "ULINE cart", sourceType: "telegram_photo", createdAt: new Date().toISOString() },
                ],
            },
        });

        expect(result.reply).toBeTruthy();
        expect(result.boundArtifactId).toBe("art1");
    });

    it("short-circuits ambiguous writes before the tool-capable LLM path", async () => {
        const result = await runCopilotTurn({
            channel:  "telegram",
            text:     "send that PO",
            threadId: "chat-123",
        });

        expect(result.reply).toContain("specific target");
        expect(result.toolCalls).toEqual([]);
        expect(vi.mocked(unifiedToolTextGeneration)).not.toHaveBeenCalled();
    });
});
