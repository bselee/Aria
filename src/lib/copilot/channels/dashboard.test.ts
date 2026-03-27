import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../intelligence/chat-logger", () => ({
    logChatMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core", () => ({
    runCopilotTurn: vi.fn().mockResolvedValue({
        reply: "Recent open POs fetched.",
        providerUsed: "test-provider",
        toolCalls: [],
        actionRefs: [],
    }),
}));

import { runCopilotTurn } from "../core";
import { handleDashboardSend } from "./dashboard";

describe("handleDashboardSend", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("routes dashboard chat through the shared copilot core", async () => {
        const result = await handleDashboardSend({ message: "recent open POs" });

        expect(runCopilotTurn).toHaveBeenCalledWith({
            channel: "dashboard",
            text: "recent open POs",
            threadId: "dashboard",
        });
        expect(result.reply).toBeTruthy();
    });
});
