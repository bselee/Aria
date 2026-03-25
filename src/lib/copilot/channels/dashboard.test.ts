import { describe, expect, it, vi } from "vitest";

vi.mock("../../intelligence/llm", () => ({
    unifiedTextGeneration: vi.fn().mockResolvedValue("Here are the recent open POs."),
}));
vi.mock("../../supabase", () => ({
    createClient: vi.fn().mockReturnValue(null),
}));

import { handleDashboardSend } from "./dashboard";

describe("handleDashboardSend", () => {
    it("routes dashboard chat through the shared copilot core", async () => {
        const result = await handleDashboardSend({ message: "recent open POs" });
        expect(result.reply).toBeTruthy();
    });

    it("returns channel=dashboard in the result", async () => {
        const result = await handleDashboardSend({ message: "build risk today" });
        expect(result.channel).toBe("dashboard");
    });

    it("passes sessionId as threadId to the core", async () => {
        const result = await handleDashboardSend({
            message:   "what is stock for PU102",
            sessionId: "session-abc",
        });
        expect(result.reply).toBeTruthy();
    });
});
