/**
 * @file    src/lib/storage/housekeeping.ts
 * @purpose SQLite housekeeping: prune stale records, vacuum, reclaim space.
 *          Called by a daily cron job to keep aria-local.db from growing unbounded.
 *
 *          PRUNING RULES:
 *            - memory_vectors: session-archive namespace older than 90 days
 *            - task_history: rows older than 30 days
 *            - cognitive_rounds: rows older than 90 days
 *            - dedup_cache: expired entries (SQL handles this via expire_at)
 *            - sync_queue: completed/cleaned entries older than 7 days
 *            - po_cache: expired entries
 *            - invoice_cache: expired entries
 *
 * @author  Hermia
 * @created 2026-07-15
 * @deps    @/lib/storage/local-db, fs
 */

import { getLocalDb } from "./local-db";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ── Pruning ─────────────────────────────────────────────────────────────────

interface PruneResult {
    memory_vectors: number;
    task_history: number;
    cognitive_rounds: number;
    sync_queue: number;
    po_cache: number;
    invoice_cache: number;
    total_bytes_reclaimed: number;
}

/**
 * Prune stale records from all SQLite tables.
 * Returns counts of rows removed and estimated bytes reclaimed.
 */
export function pruneStaleRecords(): PruneResult {
    const db = getLocalDb();
    const now = new Date().toISOString();

    const result: PruneResult = {
        memory_vectors: 0,
        task_history: 0,
        cognitive_rounds: 0,
        sync_queue: 0,
        po_cache: 0,
        invoice_cache: 0,
        total_bytes_reclaimed: 0,
    };

    // 1. Prune old session-archive memory vectors (>90 days)
    const memCutoff = new Date(Date.now() - 90 * 86400_000).toISOString();
    const memDeleted = db.prepare(
        `DELETE FROM memory_vectors WHERE namespace = 'session-archive' AND created_at < ?`
    ).run(memCutoff);
    result.memory_vectors = memDeleted.changes;

    // 2. Prune old task history (>30 days)
    const taskCutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    const taskDeleted = db.prepare(
        `DELETE FROM task_history WHERE created_at < ?`
    ).run(taskCutoff);
    result.task_history = taskDeleted.changes;

    // 3. Prune old cognitive rounds (>90 days)
    const cogCutoff = new Date(Date.now() - 90 * 86400_000).toISOString();
    const cogDeleted = db.prepare(
        `DELETE FROM cognitive_rounds WHERE ran_at < ?`
    ).run(cogCutoff);
    result.cognitive_rounds = cogDeleted.changes;

    // 4. Clean up sync_queue completed/failed entries (>7 days)
    const syncCutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
    const syncDeleted = db.prepare(
        `DELETE FROM sync_queue WHERE updated_at < ?`
    ).run(syncCutoff);
    result.sync_queue = syncDeleted.changes;

    // 5. Prune expired PO cache entries
    const poDeleted = db.prepare(
        `DELETE FROM po_cache WHERE expire_at < datetime('now')`
    ).run();
    result.po_cache = poDeleted.changes;

    // 6. Prune expired invoice cache entries
    const invDeleted = db.prepare(
        `DELETE FROM invoice_cache WHERE expire_at < datetime('now')`
    ).run();
    result.invoice_cache = invDeleted.changes;

    // Estimate reclaimed space (rough: 1KB per row average)
    const totalRows = result.memory_vectors + result.task_history + result.cognitive_rounds
        + result.sync_queue + result.po_cache + result.invoice_cache;
    result.total_bytes_reclaimed = totalRows * 1024;

    return result;
}

/**
 * Get database file size.
 */
export function getDbFileSize(): { path: string; sizeBytes: number; sizeMb: string } {
    const dbPath = path.join(process.cwd(), "aria-local.db");
    try {
        const stat = fs.statSync(dbPath);
        return {
            path: dbPath,
            sizeBytes: stat.size,
            sizeMb: (stat.size / 1024 / 1024).toFixed(1) + " MB",
        };
    } catch {
        return { path: dbPath, sizeBytes: 0, sizeMb: "0 MB" };
    }
}

/**
 * Run VACUUM to reclaim free space.
 * Should be called after pruning. Best done when DB is not under heavy write load.
 */
export function vacuumDb(): { freedPages: number } {
    const db = getLocalDb();
    const beforePages = db.pragma("page_count") as number;
    db.exec("VACUUM");
    const afterPages = db.pragma("page_count") as number;
    return { freedPages: beforePages - afterPages };
}

/**
 * Create a local backup of the SQLite database.
 * Uses the `.backup` command which is atomic and safe in WAL mode.
 *
 * @param backupDir - Directory to write backups (default: project_root/backups/)
 * @returns Path to the backup file
 */
export function createLocalBackup(backupDir?: string): string {
    const dbPath = path.join(process.cwd(), "aria-local.db");
    const dir = backupDir || path.join(process.cwd(), "backups");
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const dateStr = new Date().toISOString().split("T")[0];
    const backupPath = path.join(dir, `aria-local-${dateStr}.db`);

    try {
        execSync(`sqlite3 "${dbPath}" ".backup '${backupPath}'"`, {
            timeout: 60_000,
            stdio: ["pipe", "pipe", "pipe"],
        });
        console.log(`[housekeeping] Backup created: ${backupPath}`);
    } catch (err: any) {
        console.error(`[housekeeping] Backup failed: ${err.message}`);
        // Fallback: use Node.js fs copy
        try {
            fs.copyFileSync(dbPath, backupPath);
            console.log(`[housekeeping] Backup created via fs.copy: ${backupPath}`);
        } catch (copyErr: any) {
            console.error(`[housekeeping] Backup copy failed: ${copyErr.message}`);
        }
    }

    return backupPath;
}

/**
 * Prune old backups — keep only the last N days.
 */
export function pruneBackups(retentionDays: number = 7, backupDir?: string): number {
    const dir = backupDir || path.join(process.cwd(), "backups");
    if (!fs.existsSync(dir)) return 0;

    const cutoff = Date.now() - retentionDays * 86400_000;
    let deleted = 0;

    try {
        const files = fs.readdirSync(dir).filter(f => f.startsWith("aria-local-") && f.endsWith(".db"));
        for (const file of files) {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff) {
                fs.unlinkSync(filePath);
                deleted++;
            }
        }
    } catch (err: any) {
        console.warn(`[housekeeping] Backup pruning failed: ${err.message}`);
    }

    return deleted;
}
