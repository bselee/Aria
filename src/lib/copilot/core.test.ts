import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the LLM layer so tests don't hit real APIs
vi.mock("../intelligence/llm", () => ({
    unifiedTextGeneration: vi.fn().mockResolvedValue("Stock for KM106: 240 units on hand."),
}));

// Mock Supabase so context fetch doesn't require real DB
vi.mock("../supabase", () => ({
    createClient: vi.fn().mockReturnValue(null),
}));

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

        expect(result.reply).toBeTruthy();
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
});
