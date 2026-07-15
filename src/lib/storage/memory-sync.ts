/**
 * @file    src/lib/storage/memory-sync.ts
 * @purpose SQLite is the sole store for memory vectors. No cloud backup.
 *          This module exists for local housekeeping: export/import between
 *          SQLite instances, stats, and integrity checks.
 *
 *          The hot tier is aria-local.db (<1ms queries).
 *          There is no cold tier — SQLite IS the durable store.
 *
 *          WAL journal ensures crash recovery. The memory-backup cron
 *          (if enabled) uses sqlite3 .backup for file-level snapshots.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @updated 2026-07-15 — removed all Supabase references. SQLite is sole store.
 * @deps    src/lib/storage/memory-store
 * @env     none (uses aria-local.db only)
 */

import { exportNamespace, upsertVector } from "@/lib/storage/memory-store";

const SYNC_NAMESPACES = ["aria-memory", "vendor-memory", "insight-index", "session-archive"];

/**
 * Log current vector counts per namespace for monitoring.
 * Replaces the old syncMemoryToSupabase() — no cloud dependency.
 */
export function logMemoryStats(): { namespace: string; count: number }[] {
    const results: { namespace: string; count: number }[] = [];
    for (const ns of SYNC_NAMESPACES) {
        try {
            const vectors = exportNamespace(ns);
            results.push({ namespace: ns, count: vectors.length });
            console.log(`[MemorySync] 📊 ${ns}: ${vectors.length} vectors in SQLite`);
        } catch (err: any) {
            console.error(`[MemorySync] ❌ Failed to read ${ns}: ${err.message}`);
        }
    }
    return results;
}

/**
 * Restore memory vectors from a local JSON backup file.
 * Used during disaster recovery when aria-local.db is lost/corrupted.
 * The backup file is a JSON array of { namespace, id, embedding: number[], metadata }.
 *
 * @param backupPath - Absolute path to the JSON backup file
 * @returns Object with restored count per namespace
 */
export async function restoreFromBackup(
    backupPath: string
): Promise<{ restored: number; namespaces: number }> {
    const fs = await import("fs");
    let restored = 0;
    let namespaces = 0;

    try {
        const content = fs.readFileSync(backupPath, "utf-8");
        const vectors = JSON.parse(content) as Array<{
            namespace: string;
            id: string;
            embedding: number[];
            metadata: Record<string, unknown>;
        }>;

        const nsSet = new Set<string>();
        for (const vec of vectors) {
            if (!vec.namespace || !vec.id) continue;
            upsertVector(vec.namespace, vec.id, new Float32Array(vec.embedding), vec.metadata);
            restored++;
            nsSet.add(vec.namespace);
        }
        namespaces = nsSet.size;

        console.log(`[MemorySync] 📥 Restored ${restored} vectors across ${namespaces} namespaces from ${backupPath}`);
    } catch (err: any) {
        console.error(`[MemorySync] ❌ Restore from backup failed: ${err.message}`);
    }

    return { restored, namespaces };
}
