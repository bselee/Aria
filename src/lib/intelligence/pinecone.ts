/**
 * @file    pinecone.ts
 * @purpose Email/document context audit log. Function name + signature preserved
 *          for backward compatibility with existing callers (attachment-handler,
 *          memory-cmds, ops-manager). Writes to Supabase `email_context_log`
 *          (was: Pinecone email-embeddings index with 768d dummy vectors —
 *          replaced 2026-05-03 because non-vector dedup/audit is the wrong
 *          workload for Pinecone).
 *
 *          For semantic memory (remember/recall), see memory.ts → gravity-memory
 *          (1024d, real vector search).
 */

import { createClient } from "@/lib/supabase";

export async function indexOperationalContext(
    id?: string,
    text?: string,
    metadata?: Record<string, unknown>,
): Promise<void> {
    // Tolerant of missing args — there is one cron call site (ops-manager.ts:584)
    // that invokes this with no arguments. Previously that threw TypeError on
    // text.slice(0, 8000) and was silently swallowed by the caller's try/catch.
    if (!id) {
        return;
    }

    const supabase = createClient();
    if (!supabase) {
        console.warn("⚠️ Supabase client unavailable, skipping email_context_log upsert.");
        return;
    }

    const truncated = typeof text === "string" ? text.slice(0, 8000) : null;
    const now = new Date().toISOString();

    try {
        const { error } = await supabase.from("email_context_log").upsert(
            {
                id,
                text: truncated,
                metadata: metadata ?? {},
                indexed_at: now,
                updated_at: now,
            },
            { onConflict: "id" },
        );
        if (error) {
            console.error(`email_context_log upsert error [${id}]:`, error.message);
            return;
        }
        console.log(`📝 Logged email context [${id}] to email_context_log.`);
    } catch (err: any) {
        console.error("email_context_log error:", err?.message ?? err);
    }
}
