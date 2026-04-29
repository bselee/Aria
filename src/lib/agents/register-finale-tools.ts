/**
 * @file    register-finale-tools.ts
 * @purpose Registers Finale Inventory operations with the Aria-wide tool
 *          registry. Phase 2 of the path-forward plan
 *          (docs/plans/2026-04-29-aria-state-and-path-forward.md):
 *          make the registry load-bearing for the AP pipeline.
 *
 *          Reads (lookupProduct, getOrderSummary, getOrderDetails) are
 *          unrestricted. Writes are gated to specific agents via
 *          agentScope so a stray bot tool can't mutate Finale.
 *
 *          These registrations are metadata-only — `tool` field is
 *          omitted because the actual Finale calls are typed methods on
 *          `FinaleClient`, not AI-SDK invocable tools. The registry
 *          provides the catalog (visible at /api/command-board/tools)
 *          and the audit configuration; the call sites still call
 *          `client.method()` inside a `withToolAudit` wrapper.
 */

import { registerTool } from "./tool-registry";

let registered = false;

export function ensureFinaleToolsRegistered(): void {
    if (registered) return;

    // ── Reads (unrestricted) ────────────────────────────────────────────────
    registerTool({
        name: "finale_lookup_product",
        description: "Look up a single SKU in Finale (stock, supplier, cost, open POs).",
        category: "finale",
        scope: "read",
        agentScope: [],
    });
    registerTool({
        name: "finale_get_order_summary",
        description: "Fetch a Finale PO header (vendor, status, item count, total).",
        category: "finale",
        scope: "read",
        agentScope: [],
    });
    registerTool({
        name: "finale_get_order_details",
        description: "Fetch full Finale PO detail including shipment URLs.",
        category: "finale",
        scope: "read",
        agentScope: [],
    });

    // ── Writes (gated to AP reconciler) ─────────────────────────────────────
    // Only `ap-reconciler` (and dashboard `will-dashboard`) may invoke these.
    // The dashboard reconciliation-action route also touches these via
    // applyReconciliation but uses the `ap-reconciler` agent identity for
    // audit consistency.
    registerTool({
        name: "finale_add_items_to_po",
        description: "Append line items to an existing Finale PO (Guard 0.5 populate path).",
        category: "finale",
        scope: "write",
        agentScope: ["ap-reconciler"],
    });
    registerTool({
        name: "finale_update_order_item_price",
        description: "Update a single line-item price on a Finale PO.",
        category: "finale",
        scope: "write",
        agentScope: ["ap-reconciler"],
    });
    registerTool({
        name: "finale_update_product_supplier_price",
        description: "Update the underlying SKU supplier base price (so future POs use it).",
        category: "finale",
        scope: "write",
        agentScope: ["ap-reconciler"],
    });
    registerTool({
        name: "finale_add_order_adjustment",
        description: "Add a fee adjustment (freight/tax/tariff/labor/discount) to a Finale PO.",
        category: "finale",
        scope: "write",
        agentScope: ["ap-reconciler"],
    });
    registerTool({
        name: "finale_update_order_adjustment_amount",
        description: "Update an existing fee adjustment amount on a Finale PO.",
        category: "finale",
        scope: "write",
        agentScope: ["ap-reconciler"],
    });
    registerTool({
        name: "finale_update_shipment_tracking",
        description: "Update shipment tracking number / ship date / carrier note on a Finale PO.",
        category: "finale",
        scope: "write",
        agentScope: ["ap-reconciler"],
    });

    registered = true;
}

/** TEST ONLY — reset the idempotency latch. */
export function __resetFinaleToolsLatchForTests(): void {
    registered = false;
}
