import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the supabase client so withToolAudit can be exercised without a DB.
const insertMock = vi.fn().mockResolvedValue({ error: null });
const supabaseMock = {
    from: vi.fn().mockReturnValue({ insert: insertMock }),
};
vi.mock("@/lib/db", () => ({ createClient: () => supabaseMock }));

import {
    registerTool,
    listTools,
    getTool,
    withToolAudit,
    __resetRegistryForTests,
    type RegisteredTool,
} from "./tool-registry";

const fakeTool = {
    description: "fake tool",
    inputSchema: { type: "object", properties: {} } as any,
    execute: async () => "ok",
} as unknown as RegisteredTool["tool"];

beforeEach(() => {
    __resetRegistryForTests();
    insertMock.mockClear();
    supabaseMock.from.mockClear();
});

describe("registerTool / getTool", () => {
    it("stores and retrieves by name", () => {
        registerTool({
            name: "lookup_product",
            description: "look up a product",
            category: "finale",
            scope: "read",
            agentScope: [],
            tool: fakeTool,
        });
        const got = getTool("lookup_product");
        expect(got?.name).toBe("lookup_product");
        expect(got?.category).toBe("finale");
    });

    it("re-registering overwrites (idempotent for hot reload)", () => {
        registerTool({ name: "x", description: "v1", category: "system", scope: "read", agentScope: [], tool: fakeTool });
        registerTool({ name: "x", description: "v2", category: "system", scope: "read", agentScope: [], tool: fakeTool });
        expect(getTool("x")?.description).toBe("v2");
    });

    it("rejects empty names", () => {
        expect(() => registerTool({ name: "", description: "x", category: "system", scope: "read", agentScope: [], tool: fakeTool }))
            .toThrow(/name is required/);
    });
});

describe("listTools", () => {
    beforeEach(() => {
        registerTool({ name: "a", description: "", category: "finale", scope: "read", agentScope: [], tool: fakeTool });
        registerTool({ name: "b", description: "", category: "finale", scope: "write", agentScope: ["ap-agent"], tool: fakeTool });
        registerTool({ name: "c", description: "", category: "supabase", scope: "read", agentScope: [], tool: fakeTool });
    });

    it("returns all tools sorted by category then name", () => {
        const list = listTools();
        expect(list.map(t => t.name)).toEqual(["a", "b", "c"]);
    });

    it("filters by category", () => {
        expect(listTools({ category: "supabase" }).map(t => t.name)).toEqual(["c"]);
    });

    it("filters by scope", () => {
        expect(listTools({ scope: "write" }).map(t => t.name)).toEqual(["b"]);
    });

    it("agentScope filter respects unrestricted (empty array) tools", () => {
        // Agent 'ap-agent' should see: 'a' + 'c' (unrestricted) + 'b' (explicitly scoped).
        expect(listTools({ agentScope: "ap-agent" }).map(t => t.name)).toEqual(["a", "b", "c"]);
        // Agent 'will' should see: 'a' + 'c' (unrestricted) but NOT 'b'.
        expect(listTools({ agentScope: "will" }).map(t => t.name)).toEqual(["a", "c"]);
    });

    it("safeForChat is true for read scope only", () => {
        const list = listTools();
        expect(list.find(t => t.name === "a")?.safeForChat).toBe(true);
        expect(list.find(t => t.name === "b")?.safeForChat).toBe(false);
    });

    it("does not leak the tool descriptor in list output (catalog-safe)", () => {
        const list = listTools();
        for (const t of list) {
            expect(t).not.toHaveProperty("tool");
        }
    });
});

describe("withToolAudit", () => {
    it("emits a success event with duration on resolved fn", async () => {
        const result = await withToolAudit(
            "lookup_product",
            { agent: "ap-reconciler", issueId: "iss-1" },
            { sku: "BLM209" },
            async () => "result",
        );
        expect(result).toBe("result");
        expect(insertMock).toHaveBeenCalledTimes(1);
        const row = insertMock.mock.calls[0][0];
        expect(row.event_type).toBe("tool_call");
        expect(row.status).toBe("success");
        expect(row.agent_name).toBe("ap-reconciler");
        expect(row.issue_id).toBe("iss-1");
        expect(row.input_summary).toContain("lookup_product");
        expect(row.input_summary).toContain("sku=");
    });

    it("emits a failure event and re-throws on rejected fn", async () => {
        await expect(
            withToolAudit(
                "x",
                { agent: "ap-agent" },
                { foo: "bar" },
                async () => { throw new Error("boom"); },
            )
        ).rejects.toThrow("boom");
        expect(insertMock).toHaveBeenCalledTimes(1);
        const row = insertMock.mock.calls[0][0];
        expect(row.status).toBe("failure");
        expect(row.output_summary).toContain("boom");
    });

    it("audit failure does not break the call (best-effort)", async () => {
        insertMock.mockRejectedValueOnce(new Error("db down"));
        // Should still resolve normally
        await expect(
            withToolAudit("x", { agent: "ap-agent" }, {}, async () => "ok")
        ).resolves.toBe("ok");
    });

    it("truncates long string args in the summary (no log spam)", async () => {
        const huge = "x".repeat(200);
        await withToolAudit("t", { agent: "x" }, { val: huge }, async () => 1);
        const row = insertMock.mock.calls[0][0];
        // Truncated to 32 chars per arg
        expect(row.input_summary.length).toBeLessThan(120);
    });
});
