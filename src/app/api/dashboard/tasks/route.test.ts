import { beforeEach, describe, expect, it, vi } from "vitest";

const { listTasksMock } = vi.hoisted(() => ({
    listTasksMock: vi.fn(),
}));

vi.mock("@/lib/intelligence/agent-task", () => ({
    listTasks: listTasksMock,
}));

import { GET } from "./route";

function makeRequest(url: string) {
    return {
        nextUrl: new URL(url),
    } as any;
}

describe("dashboard tasks route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listTasksMock.mockResolvedValue([]);
    });

    it("includes recent failed tasks by default when no status filter is provided", async () => {
        const response = await GET(makeRequest("http://localhost/api/dashboard/tasks"));

        expect(response.status).toBe(200);
        expect(listTasksMock).toHaveBeenCalledWith(expect.objectContaining({
            status: undefined,
            includeRecentFailed: true,
        }));
    });

    it("passes an explicit status filter through to listTasks", async () => {
        const response = await GET(makeRequest("http://localhost/api/dashboard/tasks?status=failed"));

        expect(response.status).toBe(200);
        expect(listTasksMock).toHaveBeenCalledWith(expect.objectContaining({
            status: ["FAILED"],
            includeRecentFailed: false,
        }));
    });
});
