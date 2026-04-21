import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    createSupabaseClientMock,
    embedMock,
    embedQueryMock,
    pineconeNamespaceMock,
} = vi.hoisted(() => ({
    createSupabaseClientMock: vi.fn(),
    embedMock: vi.fn(),
    embedQueryMock: vi.fn(),
    pineconeNamespaceMock: {
        upsert: vi.fn(),
        query: vi.fn(),
    },
}));

vi.mock("@supabase/supabase-js", () => ({
    createClient: createSupabaseClientMock,
}));

vi.mock("./embedding", () => ({
    embed: embedMock,
    embedQuery: embedQueryMock,
}));

vi.mock("@pinecone-database/pinecone", () => ({
    Pinecone: class {
        index() {
            return {
                namespace: () => pineconeNamespaceMock,
            };
        }
    },
}));

import { MemoryLayerManager } from "./memory-layer-manager";

describe("MemoryLayerManager", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
        process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    });

    it("still writes task history when Pinecone archival fails", async () => {
        const insertMock = vi.fn().mockResolvedValue({ error: null });
        createSupabaseClientMock.mockReturnValue({
            from: vi.fn(() => ({
                insert: insertMock,
            })),
        });
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

        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            agent_name: "ap-pipeline",
            task_type: "APPolling",
            status: "success",
        }));
    });
});
