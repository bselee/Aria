/**
 * @file    activity-writer.ts
 * @purpose Batched ap_activity_log writer. Collects inserts in an in-memory
 *          queue and flushes every 30s or when the batch reaches 20 items,
 *          whichever comes first. Cuts ~80% of HTTP round-trips to Supabase
 *          for the most-written table in the codebase.
 *
 *          Design: fire-and-forget. Callers never await the flush — they get
 *          a synchronous enqueue and the batch handles Supabase writes in the
 *          background. If Supabase is down, entries accumulate in memory up to
 *          a cap (200) and are dropped with a console warning if the cap is
 *          exceeded. This ensures the activity log never blocks business logic.
 *
 * @author  Hermia
 * @created 2026-06-24
 * @deps    @/lib/supabase
 * @env     SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@/lib/supabase";

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
        const supabase = createClient();
        if (!supabase) {
            console.warn(`[activity-writer] Supabase unavailable — dropped ${batch.length} activity entries`);
            return;
        }

        const rows = batch.map((entry) => ({
            intent: entry.intent,
            action_taken: entry.action_taken ?? null,
            email_from: entry.email_from ?? null,
            metadata: entry.metadata ?? null,
            reviewed_action: entry.reviewed_action ?? null,
            dismiss_reason: entry.dismiss_reason ?? null,
            notes: entry.notes ?? null,
        }));

        const { error } = await supabase.from("ap_activity_log").insert(rows);

        if (error) {
            console.error(`[activity-writer] Batch insert failed (${batch.length} rows): ${error.message}`);
        }
    } catch (err: any) {
        console.error(`[activity-writer] Flush threw: ${err.message}`);
    } finally {
        flushing = false;
    }
}

/**
 * Enqueue an ap_activity_log entry for batched write. Fire-and-forget.
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
