/**
 * @file    src/lib/intelligence/email-queue-status.ts
 * @purpose Canonical status vocabulary + update helper for email_inbox_queue.
 *          Fixes the historical bug where ACK only flipped processed_by_ack and
 *          left status stuck at 'unprocessed' forever.
 * @author  Hermia
 * @created 2026-08-05
 * @deps    @/lib/db
 */

import { createClient } from "../db";

/**
 * Terminal / lifecycle statuses for email_inbox_queue.
 * Retention historically only cared about completed/failed; body retention
 * trigger was dropped 2026-07-30, so these are free for triage reporting.
 */
export type EmailQueueStatus =
    | "unprocessed"
    | "processing"
    | "promotional"
    | "system_noise"
    | "completed"
    | "needs_response"
    | "invoice_queued"
    | "skipped"
    | "failed";

export interface MarkEmailQueueArgs {
    id: string;
    status: EmailQueueStatus;
    /** Defaults to acknowledgement-agent */
    processedBy?: string;
    processedByAck?: boolean;
    errorMessage?: string | null;
}

/**
 * Persist a lifecycle outcome on an email_inbox_queue row.
 * Always stamps updated_at. Safe no-op if DB is unavailable.
 */
export async function markEmailQueueOutcome(args: MarkEmailQueueArgs): Promise<void> {
    const db = createClient();
    if (!db) return;

    const payload: Record<string, unknown> = {
        status: args.status,
        processed_by: args.processedBy ?? "acknowledgement-agent",
        updated_at: new Date().toISOString(),
    };

    if (args.processedByAck !== undefined) {
        payload.processed_by_ack = args.processedByAck;
    }

    if (args.errorMessage !== undefined) {
        payload.error_message = args.errorMessage;
    }

    const { error } = await db
        .from("email_inbox_queue")
        .update(payload)
        .eq("id", args.id);

    if (error) {
        console.warn(`[email-queue-status] mark failed id=${args.id}: ${error.message}`);
    }
}
