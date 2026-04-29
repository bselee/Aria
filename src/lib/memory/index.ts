/**
 * @file    src/lib/memory/index.ts
 * @purpose Memory Manager facade — Phase 3 of the path-forward plan
 *          (docs/plans/2026-04-29-aria-state-and-path-forward.md). Single
 *          API hides four fragmented patterns:
 *
 *            namespace = "aria-memory"     → general operational memory (Pinecone)
 *            namespace = "vendor-memory"   → vendor handling patterns (Pinecone, separate index ns)
 *            namespace = "kaizen-memory"   → corrections / learnings (Supabase + Pinecone hybrid)
 *            namespace = "dropship-memory" → dropship pending invoices (in-memory + Supabase)
 *
 *          Backend stays unchanged — this file dispatches to the existing
 *          implementations under the hood. No data migration. The win is
 *          that AP-pipeline code imports ONE thing instead of three.
 *
 *          Phase 3 migrates AP path callers; other call sites can migrate
 *          opportunistically as files are touched.
 */

import { remember as pineconeRemember, recall as pineconeRecall, type Memory, type MemoryCategory, type MemorySearchResult } from "@/lib/intelligence/memory";
import { storeVendorPattern, getVendorPattern, type VendorPattern } from "@/lib/intelligence/vendor-memory";
import { withToolAudit, type ToolAuditContext } from "@/lib/agents/tool-registry";

export type MemoryNamespace = "aria-memory" | "vendor-memory" | "kaizen-memory" | "dropship-memory";

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Store a value in the named memory namespace. Each namespace has its own
 * shape; the value type is `unknown` here and the dispatcher routes to
 * the appropriate backend.
 *
 * Audit context (optional) lets callers attribute the write to an agent +
 * issue so it lands in the same task_history ledger that tool calls do.
 */
export async function put(
    namespace: "aria-memory",
    value: Memory,
    audit?: ToolAuditContext,
): Promise<string>;
export async function put(
    namespace: "vendor-memory",
    value: VendorPattern,
    audit?: ToolAuditContext,
): Promise<void>;
export async function put(
    namespace: MemoryNamespace,
    value: Memory | VendorPattern,
    audit?: ToolAuditContext,
): Promise<string | void> {
    const ctx = audit ?? { agent: "memory-manager" };
    if (namespace === "aria-memory") {
        return withToolAudit(
            "memory_put_aria",
            ctx,
            { category: (value as Memory).category, contentPreview: ((value as Memory).content ?? "").slice(0, 60) },
            () => pineconeRemember(value as Memory),
        );
    }
    if (namespace === "vendor-memory") {
        return withToolAudit(
            "memory_put_vendor",
            ctx,
            { vendor: (value as VendorPattern).vendor },
            () => storeVendorPattern(value as VendorPattern),
        );
    }
    throw new Error(`memory.put: namespace '${namespace}' not yet wired in the facade`);
}

/**
 * Read a value by key/identifier from the named namespace. Today the only
 * keyed lookup we have is vendor patterns (key = vendor name).
 */
export async function get(
    namespace: "vendor-memory",
    key: string,
    audit?: ToolAuditContext,
): Promise<VendorPattern | null>;
export async function get(
    namespace: MemoryNamespace,
    key: string,
    audit?: ToolAuditContext,
): Promise<unknown> {
    const ctx = audit ?? { agent: "memory-manager" };
    if (namespace === "vendor-memory") {
        return withToolAudit(
            "memory_get_vendor",
            ctx,
            { vendor: key },
            () => getVendorPattern(key),
        );
    }
    throw new Error(`memory.get: namespace '${namespace}' does not support keyed get`);
}

/**
 * Semantic-similarity query on the named namespace. Today aria-memory is
 * the only namespace that exposes vector search.
 */
export async function query(
    namespace: "aria-memory",
    text: string,
    options?: { category?: MemoryCategory; topK?: number; minScore?: number },
    audit?: ToolAuditContext,
): Promise<MemorySearchResult[]>;
export async function query(
    namespace: MemoryNamespace,
    text: string,
    options?: { category?: MemoryCategory; topK?: number; minScore?: number },
    audit?: ToolAuditContext,
): Promise<MemorySearchResult[]> {
    const ctx = audit ?? { agent: "memory-manager" };
    if (namespace === "aria-memory") {
        return withToolAudit(
            "memory_query_aria",
            ctx,
            { textPreview: text.slice(0, 60), topK: options?.topK ?? 5, category: options?.category },
            () => pineconeRecall(text, options),
        );
    }
    throw new Error(`memory.query: namespace '${namespace}' does not support semantic query`);
}

// ── Re-exports for convenience ──────────────────────────────────────────────
export type { Memory, MemoryCategory, MemorySearchResult } from "@/lib/intelligence/memory";
export type { VendorPattern } from "@/lib/intelligence/vendor-memory";

// ── Convenience namespace bundle ────────────────────────────────────────────
// Lets callers write `import { memory } from "@/lib/memory"; memory.put(...)`
// when they prefer a single import for ergonomic clarity.
export const memory = { put, get, query };
