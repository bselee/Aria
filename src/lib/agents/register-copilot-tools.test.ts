import { describe, expect, it, beforeEach, vi } from "vitest";

// Stub the underlying copilot tools module so we don't drag in supabase /
// finale clients during this unit test.
vi.mock("@/lib/copilot/tools", () => ({
    READ_TOOL_NAMES: [
        "lookup_product",
        "get_consumption",
        "query_vendors",
        "query_invoices",
        "query_purchase_orders",
        "build_risk_analysis",
        "inspect_artifact",
        "scrape_purchasing_dashboard",
    ] as const,
    getSharedReadTools: () => ({
        lookup_product: { description: "look up a Finale SKU", inputSchema: {} as any, execute: async () => "ok" },
        get_consumption: { description: "get BOM consumption", inputSchema: {} as any, execute: async () => "ok" },
        query_vendors: { description: "query vendors", inputSchema: {} as any, execute: async () => "ok" },
        query_invoices: { description: "query invoices", inputSchema: {} as any, execute: async () => "ok" },
        query_purchase_orders: { description: "query POs", inputSchema: {} as any, execute: async () => "ok" },
        build_risk_analysis: { description: "build risk", inputSchema: {} as any, execute: async () => "ok" },
        inspect_artifact: { description: "inspect artifact", inputSchema: {} as any, execute: async () => "ok" },
        scrape_purchasing_dashboard: { description: "scrape purchasing", inputSchema: {} as any, execute: async () => "ok" },
    }),
}));

vi.mock("@/lib/supabase", () => ({ createClient: () => null }));

import { __resetRegistryForTests, listTools } from "./tool-registry";
import { ensureCopilotToolsRegistered, __resetRegistrationLatchForTests } from "./register-copilot-tools";

beforeEach(() => {
    __resetRegistryForTests();
    __resetRegistrationLatchForTests();
});

describe("ensureCopilotToolsRegistered", () => {
    it("registers all 8 read tools with correct metadata", () => {
        ensureCopilotToolsRegistered();
        const tools = listTools();
        expect(tools).toHaveLength(8);
        // All marked read-scope, all unrestricted, all safeForChat.
        for (const t of tools) {
            expect(t.scope).toBe("read");
            expect(t.agentScope).toEqual([]);
            expect(t.safeForChat).toBe(true);
        }
    });

    it("groups tools into the right categories", () => {
        ensureCopilotToolsRegistered();
        const cats = new Set(listTools().map(t => t.category));
        expect(cats.has("finale")).toBe(true);
        expect(cats.has("supabase")).toBe(true);
        expect(cats.has("build")).toBe(true);
        expect(cats.has("scraping")).toBe(true);
    });

    it("is idempotent — second call no-ops, no duplicate registrations", () => {
        ensureCopilotToolsRegistered();
        const first = listTools();
        ensureCopilotToolsRegistered();
        const second = listTools();
        expect(second.length).toBe(first.length);
    });

    it("preserves description text from the underlying tool", () => {
        ensureCopilotToolsRegistered();
        const lp = listTools().find(t => t.name === "lookup_product");
        expect(lp?.description).toContain("Finale");
    });
});
