import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock catalog to avoid filesystem reads.
vi.mock("@/lib/command-board/catalog", () => ({
    buildCatalog: vi.fn().mockResolvedValue({
        agents: [],
        skills: [
            { id: "skill:foo", name: "foo-skill", path: "skills/foo", description: "Foo skill" },
            { id: "skill:bar", name: "bar-skill", path: "skills/bar", description: "Bar skill" },
        ],
        workflows: [],
        agentFiles: [],
        references: [],
    }),
}));

// Mock supabase so the registered-tools chain doesn't try a network call.
vi.mock("@/lib/db", () => ({ createClient: () => null }));

import { __resetRegistryForTests, registerTool } from "./tool-registry";
import { listIssueCapabilities } from "./issue-capabilities";

beforeEach(() => {
    __resetRegistryForTests();
    // Seed registry with two tools — one read, one write scoped to ap-reconciler.
    const fakeTool = { description: "fake", inputSchema: {} as any, execute: async () => "ok" } as any;
    registerTool({
        name: "test_finale_lookup",
        description: "look up a SKU",
        category: "finale",
        scope: "read",
        agentScope: [],
        tool: fakeTool,
    });
    registerTool({
        name: "test_finale_update_price",
        description: "update PO line price",
        category: "finale",
        scope: "write",
        agentScope: ["ap-reconciler"],
        tool: fakeTool,
    });
});

describe("listIssueCapabilities", () => {
    it("includes skills, playbooks, and tools as capabilities", async () => {
        const caps = await listIssueCapabilities();
        expect(caps.some(c => c.kind === "skill")).toBe(true);
        expect(caps.some(c => c.kind === "playbook")).toBe(true);
        expect(caps.some(c => c.kind === "tool")).toBe(true);
    });

    it("returns capability objects with required fields", async () => {
        const caps = await listIssueCapabilities();
        for (const c of caps) {
            expect(c.id).toBeTruthy();
            expect(c.kind).toMatch(/^(skill|playbook|tool)$/);
            expect(c.label).toBeTruthy();
            expect(typeof c.safeByDefault).toBe("boolean");
            expect(typeof c.requiresApproval).toBe("boolean");
            expect(Array.isArray(c.handlerScope)).toBe(true);
        }
    });

    it("read tools are marked safeByDefault and not requiresApproval", async () => {
        const caps = await listIssueCapabilities();
        const readTool = caps.find(c => c.id === "tool:test_finale_lookup");
        expect(readTool?.safeByDefault).toBe(true);
        expect(readTool?.requiresApproval).toBe(false);
    });

    it("write tools are NOT safeByDefault and DO require approval", async () => {
        const caps = await listIssueCapabilities();
        const writeTool = caps.find(c => c.id === "tool:test_finale_update_price");
        expect(writeTool?.safeByDefault).toBe(false);
        expect(writeTool?.requiresApproval).toBe(true);
        expect(writeTool?.handlerScope).toEqual(["ap-reconciler"]);
    });

    it("playbooks are marked requiresApproval=true (side-effect path)", async () => {
        const caps = await listIssueCapabilities();
        const pb = caps.filter(c => c.kind === "playbook");
        // Both registered playbooks (apply_pending_migration, restart_stale_pm2_proc)
        // require approval before the runner fires them.
        for (const p of pb) {
            expect(p.requiresApproval).toBe(true);
        }
    });

    it("filtering by handler='ap-reconciler' includes its scoped writes + unrestricted reads", async () => {
        const caps = await listIssueCapabilities({ handler: "ap-reconciler" });
        const ids = caps.map(c => c.id);
        expect(ids).toContain("tool:test_finale_lookup");      // unrestricted read
        expect(ids).toContain("tool:test_finale_update_price"); // scoped write
    });

    it("filtering by handler='will-dashboard' EXCLUDES ap-reconciler-only writes", async () => {
        const caps = await listIssueCapabilities({ handler: "will-dashboard" });
        const ids = caps.map(c => c.id);
        expect(ids).toContain("tool:test_finale_lookup");          // unrestricted read
        expect(ids).not.toContain("tool:test_finale_update_price"); // gated write
    });

    it("output is sorted stably by kind:label", async () => {
        const caps = await listIssueCapabilities();
        const keys = caps.map(c => `${c.kind}:${c.label}`);
        const sorted = [...keys].sort();
        expect(keys).toEqual(sorted);
    });
});
