import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleDashboardSendMock } = vi.hoisted(() => ({
    handleDashboardSendMock: vi.fn(),
}));

vi.mock("@/lib/copilot/channels/dashboard", () => ({
    handleDashboardSend: handleDashboardSendMock,
}));

import { POST } from "./route";

describe("dashboard send route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        handleDashboardSendMock.mockResolvedValue({
            reply: "Recent open POs fetched.",
            providerUsed: "test-provider",
            toolCalls: [],
            actionRefs: [],
        });
    });

    it("rejects blank messages before reaching the copilot core", async () => {
        const response = await POST(
            new Request("http://localhost/api/dashboard/send", {
                method: "POST",
                body: JSON.stringify({ message: "   " }),
                headers: { "Content-Type": "application/json" },
            }),
        );

        expect(response.status).toBe(400);
        expect(handleDashboardSendMock).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toEqual({ error: "message required" });
    });

    it("delegates normal Q&A to the shared dashboard adapter", async () => {
        const response = await POST(
            new Request("http://localhost/api/dashboard/send", {
                method: "POST",
                body: JSON.stringify({ message: "recent open POs" }),
                headers: { "Content-Type": "application/json" },
            }),
        );

        expect(response.status).toBe(200);
        expect(handleDashboardSendMock).toHaveBeenCalledWith({ message: "recent open POs" });
        await expect(response.json()).resolves.toEqual({ reply: "Recent open POs fetched." });
    });

    it("passes through an explicit dashboard thread id", async () => {
        const response = await POST(
            new Request("http://localhost/api/dashboard/send", {
                method: "POST",
                body: JSON.stringify({ message: "recent open POs", threadId: "session-42" }),
                headers: { "Content-Type": "application/json" },
            }),
        );

        expect(response.status).toBe(200);
        expect(handleDashboardSendMock).toHaveBeenCalledWith({
            message: "recent open POs",
            threadId: "session-42",
        });
    });
});
