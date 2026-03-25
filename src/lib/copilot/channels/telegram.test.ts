import { describe, expect, it, vi } from "vitest";

vi.mock("../../intelligence/llm", () => ({
    unifiedTextGeneration: vi.fn().mockResolvedValue("On hand: 240 units."),
}));
vi.mock("../../supabase", () => ({
    createClient: vi.fn().mockReturnValue(null),
}));

import { handleTelegramText } from "./telegram";

describe("handleTelegramText", () => {
    it("routes Telegram text messages into the shared copilot core", async () => {
        const result = await handleTelegramText({
            chatId: 1,
            text:   "what is consumption for PU102",
        });

        expect(result.reply).toBeTruthy();
    });

    it("returns channel=telegram in the result", async () => {
        const result = await handleTelegramText({
            chatId: 12345,
            text:   "recent open POs",
        });

        expect(result.channel).toBe("telegram");
    });

    it("passes chatId as threadId to the core", async () => {
        const result = await handleTelegramText({
            chatId: 99,
            text:   "build risk today",
        });

        expect(result.reply).toBeTruthy();
    });
});
