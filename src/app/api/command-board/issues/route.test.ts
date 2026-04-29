import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/intelligence/agent-issue", () => ({
    createOrAdvance: vi.fn(),
}));

import * as agentIssue from "@/lib/intelligence/agent-issue";
import { POST } from "./route";

function makeRequest(body: any): Request {
    return new Request("http://localhost/api/command-board/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
}

describe("POST /api/command-board/issues", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns 503 with no-store header when createOrAdvance returns null", async () => {
        vi.mocked(agentIssue.createOrAdvance).mockResolvedValueOnce(null);
        const res = await POST(makeRequest({ title: "x" }) as never);
        expect(res.status).toBe(503);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("returns 400 + no-store on missing title", async () => {
        const res = await POST(makeRequest({}) as never);
        expect(res.status).toBe(400);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("returns 400 + no-store on invalid JSON body", async () => {
        const req = new Request("http://localhost/api/command-board/issues", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "not json",
        });
        const res = await POST(req as never);
        expect(res.status).toBe(400);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("returns 200 + no-store with the issue when create succeeds", async () => {
        vi.mocked(agentIssue.createOrAdvance).mockResolvedValueOnce({
            id: "new-id",
            title: "x",
            lifecycle_state: "triaging",
            autonomy_state: "working",
            current_handler: null,
            blocker_reason: null,
            next_action: null,
            owner: "aria",
            priority: 2,
            source_table: null,
            source_id: null,
            business_flow_key: "manual:abc",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: null,
            inputs: {},
            outputs: {},
        } as never);
        const res = await POST(makeRequest({ title: "x" }) as never);
        expect(res.status).toBe(200);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        const body = await res.json();
        expect(body.issue.id).toBe("new-id");
    });
});
