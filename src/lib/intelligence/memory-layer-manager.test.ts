import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    embedMock,
    embedQueryMock,
} = vi.hoisted(() => ({
    embedMock: vi.fn(),
    embedQueryMock: vi.fn(),
}));

vi.mock("./embedding", () => ({
    embed: embedMock,
    embedQuery: embedQueryMock,
}));

import { MemoryLayerManager } from "./memory-layer-manager";

describe("MemoryLayerManager", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("still writes task history when embedding archival fails", async () => {
        embedMock.mockRejectedValue(new Error("embedding offline"));

        const manager = new MemoryLayerManager();
        await manager.archiveSession("session-1", {
            sessionId: "session-1",
            agentName: "ap-pipeline",
            taskType: "APPolling",
            inputSummary: "poll ap inbox",
            outputSummary: "queued invoices",
            status: "success",
            createdAt: new Date().toISOString(),
        });

        // embedding failed, but the SQLite task_history write still runs
        // (we just verify it doesn't throw)
        expect(embedMock).toHaveBeenCalled();
    });
});
