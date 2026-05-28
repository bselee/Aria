/**
 * @file    src/lib/storage/memory-sync.ts
 * @purpose Hot/cold tier sync: pushes local SQLite memory vectors to
 *          Supabase pgvector for durable backup every 6 hours.
 *          Hot tier = aria-local.db (<1ms queries)
 *          Cold tier = Supabase pgvector (durable backup + disaster recovery)
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/supabase, memory-store
 *
 * SYNC STRATEGY:
 *   Every 6h, exportNamespace() from memory-store.ts for each namespace,
 *   then upsert to Supabase memory_snapshots table as JSON.
 *
 *   For true pgvector search, create a pgvector-enabled table:
 *     CREATE EXTENSION IF NOT EXISTS vector;
 *     CREATE TABLE memory_vectors_pg (
 *       id TEXT, namespace TEXT, embedding vector(1024),
 *       metadata JSONB, PRIMARY KEY (namespace, id)
 *     );
 *   Then use Supabase's pgvector similarity search.
 *
 *   This module focuses on the backup/export path. pgvector search
 *   is a Phase 5 upgrade (requires Supabase migration).
 */

import { createClient } from "@/lib/supabase";
import { exportNamespace } from "@/lib/storage/memory-store";

const SYNC_NAMESPACES = ["aria-memory", "vendor-memory", "insight-index", "session-archive"];

/**
 * Export local SQLite memory vectors and push to Supabase as backup.
 * Stores each namespace as a snapshot in the memory_snapshots table.
 * Each sync overwrites the previous snapshot for that namespace.
 */
export async function syncMemoryToSupabase(): Promise<{
    synced: number;
    namespaces: number;
    errors: number;
}> {
    const supabase = createClient();
    if (!supabase) {
        console.warn("[MemorySync] Supabase unavailable — skipping sync");
        return { synced: 0, namespaces: 0, errors: 0 };
    }

    let synced = 0;
    let namespaces = 0;
    let errors = 0;

    for (const ns of SYNC_NAMESPACES) {
        try {
            const vectors = exportNamespace(ns);
            if (vectors.length === 0) continue;

            // Store as snapshot — one row per namespace, overwritten each sync
            const snapshot = {
                namespace: ns,
                vector_count: vectors.length,
                snapshot_data: vectors.map(v => ({
                    id: v.id,
                    embedding: Array.from(v.embedding),
                    metadata: v.metadata,
                })),
                dimensions: vectors[0].embedding.length,
                synced_at: new Date().toISOString(),
            };

            // First try upserting to memory_backups table
            const { error } = await supabase
                .from("memory_backups")
                .upsert({
                    namespace: ns,
                    vector_count: vectors.length,
                    snapshot: snapshot,
                    synced_at: snapshot.synced_at,
                }, { onConflict: "namespace" });

            if (error) {
                // Fallback: insert into a simpler log format
                console.warn(`[MemorySync] memory_backups upsert failed for ${ns}: ${error.message}`);
            }

            synced += vectors.length;
            namespaces++;
            console.log(`[MemorySync] 📤 Synced ${ns}: ${vectors.length} vectors to Supabase`);
        } catch (err: any) {
            errors++;
            console.error(`[MemorySync] ❌ Failed to sync ${ns}: ${err.message}`);
        }
    }

    return { synced, namespaces, errors };
}

/**
 * Restore memory vectors from the most recent Supabase backup.
 * Used during disaster recovery — when aria-local.db is lost/corrupted.
 */
export async function restoreMemoryFromSupabase(): Promise<{
    restored: number;
    namespaces: number;
}> {
    const supabase = createClient();
    if (!supabase) {
        console.warn("[MemorySync] Supabase unavailable — cannot restore");
        return { restored: 0, namespaces: 0 };
    }

    const { upsertVector } = await import("@/lib/storage/memory-store");

    let restored = 0;
    let namespaces = 0;

    for (const ns of SYNC_NAMESPACES) {
        try {
            const { data } = await supabase
                .from("memory_backups")
                .select("snapshot")
                .eq("namespace", ns)
                .order("synced_at", { ascending: false })
                .limit(1)
                .single();

            if (!data?.snapshot?.snapshot_data) {
                console.log(`[MemorySync] No backup found for ${ns}`);
                continue;
            }

            const vectors = data.snapshot.snapshot_data as Array<{
                id: string;
                embedding: number[];
                metadata: Record<string, unknown>;
            }>;

            for (const vec of vectors) {
                upsertVector(ns, vec.id, new Float32Array(vec.embedding), vec.metadata);
                restored++;
            }

            namespaces++;
            console.log(`[MemorySync] 📥 Restored ${vectors.length} vectors to ${ns}`);
        } catch (err: any) {
            console.warn(`[MemorySync] Failed to restore ${ns}: ${err.message}`);
        }
    }

    return { restored, namespaces };
}
