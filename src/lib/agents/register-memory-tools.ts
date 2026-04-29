/**
 * @file    register-memory-tools.ts
 * @purpose Phase 3: register Memory Manager facade operations with the
 *          Aria-wide tool registry so semantic memory ops show in the
 *          catalog and route through `withToolAudit` (the facade itself
 *          wraps each call already, but the registry needs the metadata
 *          for /api/command-board/tools).
 */

import { registerTool } from "./tool-registry";

let registered = false;

export function ensureMemoryToolsRegistered(): void {
    if (registered) return;

    registerTool({
        name: "memory_put_aria",
        description: "Store a value in the aria-memory namespace (general operational memory).",
        category: "memory",
        scope: "write",
        agentScope: [], // any agent may write to its own observations
    });
    registerTool({
        name: "memory_query_aria",
        description: "Semantic-similarity query against aria-memory.",
        category: "memory",
        scope: "read",
        agentScope: [],
    });
    registerTool({
        name: "memory_put_vendor",
        description: "Store a vendor handling pattern (vendor-memory namespace).",
        category: "memory",
        scope: "write",
        agentScope: [],
    });
    registerTool({
        name: "memory_get_vendor",
        description: "Look up a vendor handling pattern by vendor name.",
        category: "memory",
        scope: "read",
        agentScope: [],
    });

    registered = true;
}

/** TEST ONLY — reset the idempotency latch. */
export function __resetMemoryToolsLatchForTests(): void {
    registered = false;
}
