/**
 * @file    src/lib/storage/activity-writer.ts
 * @purpose Batched activity log writer backed by local SQLite.
 *          Collects inserts in an in-memory queue and flushes every 30s
 *          or when the batch reaches 20 items, whichever comes first.
 *
 *          Replaces the old Supabase-backed batched writer.
 *          Uses the ap_activity_log table in aria-local.db.
 *
 *          Design: fire-and-forget. Callers never await the flush — they get
 *          a synchronous enqueue and the batch handles SQLite writes in the
 *          background. If writes fail, entries accumulate in memory up to
 *          a cap (200) and are dropped with a console warning.
 *
 * @author  Hermia
 * @created 2026-06-24
 * @updated 2026-07-15 — migrated from Supabase to local SQLite
 * @deps    @/lib/storage/local-db
 */

import { getLocalDb } from "@/lib/storage/local-db";

/** Max entries to hold before dropping (prevents unbounded memory growth). */
const MAX_QUEUE_SIZE = 200;

/** Flush every 30 seconds. */
const FLUSH_INTERVAL_MS = 30_000;

/** Flush immediately when batch reaches this size. */
const BATCH_SIZE = 20;

interface ActivityEntry {
    intent: string;
    action_taken?: string | null;
    email_from?: string | null;
    metadata?: Record<string, unknown> | null;
    reviewed_action?: string | null;
    dismiss_reason?: string | null;
    notes?: string | null;
}

const queue: ActivityEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

/** Ensure the SQLite table exists. Idempotent. */
function ensureTable(): void {
    const db = getLocalDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS ap_activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            intent TEXT NOT NULL,
            action_taken TEXT,
            email_from TEXT,
            metadata TEXT DEFAULT '{}',
            reviewed_action TEXT,
            dismiss_reason TEXT,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
}

function startTimer(): void {
    if (flushTimer) return;
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
        (flushTimer as NodeJS.Timeout).unref();
    }
}

async function flush(): Promise<void> {
    if (flushing || queue.length === 0) return;
    flushing = true;

    const batch = queue.splice(0, queue.length);

    try {
        ensureTable();
        const db = getLocalDb();

        const insert = db.prepare(`
            INSERT INTO ap_activity_log (intent, action_taken, email_from, metadata, reviewed_action, dismiss_reason, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const tx = db.transaction((entries: ActivityEntry[]) => {
            for (const entry of entries) {
                insert.run(
                    entry.intent,
                    entry.action_taken ?? null,
                    entry.email_from ?? null,
                    JSON.stringify(entry.metadata ?? {}),
                    entry.reviewed_action ?? null,
                    entry.dismiss_reason ?? null,
                    entry.notes ?? null,
                );
            }
        });

        tx(batch);
    } catch (err: any) {
        console.error(`[activity-writer] Flush failed (${batch.length} rows): ${err.message}`);
        // Re-queue on failure to avoid data loss
        queue.unshift(...batch);
    } finally {
        flushing = false;
    }
}

/**
 * Enqueue an activity log entry for batched write. Fire-and-forget.
 */
export function writeActivity(entry: ActivityEntry): void {
    if (queue.length >= MAX_QUEUE_SIZE) {
        console.warn(`[activity-writer] Queue full (${MAX_QUEUE_SIZE}) — dropping entry: ${entry.intent}`);
        return;
    }

    queue.push(entry);
    startTimer();

    if (queue.length >= BATCH_SIZE) {
        flush();
    }
}

/**
 * Force an immediate flush. Call during graceful shutdown (SIGTERM/SIGINT).
 */
export async function flushActivityQueue(): Promise<void> {
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
    await flush();
}

/**
 * Returns the current queue depth (for diagnostics).
 */
export function activityQueueDepth(): number {
    return queue.length;
}
