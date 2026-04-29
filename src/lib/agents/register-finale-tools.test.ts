import { describe, expect, it, beforeEach } from "vitest";
import { __resetRegistryForTests, listTools } from "./tool-registry";
import { ensureFinaleToolsRegistered, __resetFinaleToolsLatchForTests } from "./register-finale-tools";

beforeEach(() => {
    __resetRegistryForTests();
    __resetFinaleToolsLatchForTests();
});

describe("ensureFinaleToolsRegistered", () => {
    it("registers all 9 Finale ops with correct categories + scopes", () => {
        ensureFinaleToolsRegistered();
        const tools = listTools({ category: "finale" });
        expect(tools.map(t => t.name).sort()).toEqual([
            "finale_add_items_to_po",
            "finale_add_order_adjustment",
            "finale_get_order_details",
            "finale_get_order_summary",
            "finale_lookup_product",
            "finale_update_order_adjustment_amount",
            "finale_update_order_item_price",
            "finale_update_product_supplier_price",
            "finale_update_shipment_tracking",
        ]);
    });

    it("read tools are unrestricted (any agent can call)", () => {
        ensureFinaleToolsRegistered();
        const reads = listTools({ category: "finale", scope: "read" });
        expect(reads).toHaveLength(3);
        for (const t of reads) {
            expect(t.agentScope).toEqual([]);
            expect(t.safeForChat).toBe(true);
        }
    });

    it("write tools are gated to ap-reconciler", () => {
        ensureFinaleToolsRegistered();
        const writes = listTools({ category: "finale", scope: "write" });
        expect(writes).toHaveLength(6);
        for (const t of writes) {
            expect(t.agentScope).toEqual(["ap-reconciler"]);
            expect(t.safeForChat).toBe(false);
        }
    });

    it("listTools agentScope filter excludes Finale writes from a non-ap-reconciler caller", () => {
        ensureFinaleToolsRegistered();
        // Will (the human board) calls through dashboard, agent='will-dashboard'.
        // Should NOT see ap-reconciler-scoped writes in his agent surface.
        const willTools = listTools({ agentScope: "will-dashboard" });
        const willToolNames = willTools.map(t => t.name);
        expect(willToolNames).toContain("finale_lookup_product");           // unrestricted read
        expect(willToolNames).not.toContain("finale_update_order_item_price"); // gated write
    });

    it("ap-reconciler agent CAN see all Finale tools (reads + writes)", () => {
        ensureFinaleToolsRegistered();
        const apTools = listTools({ agentScope: "ap-reconciler" });
        const apFinale = apTools.filter(t => t.category === "finale");
        expect(apFinale).toHaveLength(9);
    });

    it("idempotent — second call does not duplicate registrations", () => {
        ensureFinaleToolsRegistered();
        const first = listTools({ category: "finale" }).length;
        ensureFinaleToolsRegistered();
        expect(listTools({ category: "finale" }).length).toBe(first);
    });
});
