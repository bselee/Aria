import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, fromMock, createClientMock } = vi.hoisted(() => ({
    insertMock: vi.fn().mockResolvedValue(undefined),
    fromMock: vi.fn(),
    createClientMock: vi.fn(),
}));

vi.mock("../supabase", () => ({
    createClient: createClientMock,
}));

import { logChatMessage } from "./chat-logger";

describe("logChatMessage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fromMock.mockReturnValue({ insert: insertMock });
        createClientMock.mockReturnValue({ from: fromMock });
    });

    it("writes null metadata when no metadata or thread id is provided", async () => {
        await logChatMessage({
            source: "telegram",
            role: "user",
            content: "hello",
        });

        expect(fromMock).toHaveBeenCalledWith("sys_chat_logs");
        expect(insertMock).toHaveBeenCalledWith({
            source: "telegram",
            role: "user",
            content: "hello",
            metadata: null,
        });
    });

    it("merges thread id into metadata when present", async () => {
        await logChatMessage({
            source: "telegram",
            role: "assistant",
            content: "reply",
            threadId: "chat-42",
            metadata: { from: "dashboard" },
        });

        expect(insertMock).toHaveBeenCalledWith({
            source: "telegram",
            role: "assistant",
            content: "reply",
            metadata: {
                from: "dashboard",
                thread_id: "chat-42",
            },
        });
    });
});
