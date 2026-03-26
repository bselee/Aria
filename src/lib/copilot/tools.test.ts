import { describe, expect, it } from "vitest";
import { resolveReadToolRoute, getTool, READ_TOOLS } from "./tools";

describe("READ_TOOLS registry", () => {
    it("includes all expected read tools", () => {
        const names = READ_TOOLS.map(t => t.name);
        expect(names).toContain("lookup_product");
        expect(names).toContain("search_purchase_orders");
        expect(names).toContain("lookup_vendor");
        expect(names).toContain("get_build_risk");
        expect(names).toContain("inspect_artifact");
    });

    it("getTool returns the correct definition by name", () => {
        const tool = getTool("lookup_product");
        expect(tool?.name).toBe("lookup_product");
        expect(tool?.parameters).toBeTruthy();
    });

    it("getTool returns undefined for unknown names", () => {
        expect(getTool("nonexistent_tool")).toBeUndefined();
    });
});

describe("resolveReadToolRoute", () => {
    it("retries once when the first read tool returns no_result", async () => {
        const result = await resolveReadToolRoute({
            text:     "show recent open POs",
            attempts: ["wrong_tool", "search_purchase_orders"],
        });

        expect(result.attemptCount).toBe(2);
        expect(result.resolvedTool).toBe("search_purchase_orders");
    });

    it("stops after one retry on repeated no_result", async () => {
        const result = await resolveReadToolRoute({
            text:     "unknown query",
            attempts: ["wrong_tool_a", "wrong_tool_b", "should_not_reach"],
        });

        // Should stop after 2 attempts max
        expect(result.attemptCount).toBeLessThanOrEqual(2);
        expect(result.failed).toBe(true);
    });

    it("succeeds on first attempt when tool is correct", async () => {
        const result = await resolveReadToolRoute({
            text:     "stock for PU102",
            attempts: ["lookup_product"],
        });

        expect(result.attemptCount).toBe(1);
        expect(result.resolvedTool).toBe("lookup_product");
        expect(result.failed).toBe(false);
    });

    it("read-tool failure never escalates into write behavior", async () => {
        const result = await resolveReadToolRoute({
            text:     "stock for PU102",
            attempts: ["wrong_tool", "also_wrong"],
        });

        // Failed reads must not produce a write action ref
        expect(result.writeActionRef).toBeUndefined();
    });
});
