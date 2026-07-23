/**
 * @file    src/lib/intelligence/dropship-store-v2.ts
 * @purpose Persistent dropship invoice store using agent_task table.
 *          Replaces the in-memory Map with 48h TTL that was lost on
 *          PM2 restart. Survives crashes, deploys, and OOM restarts.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/db
 *
 * BACKGROUND:
 *   ap-agent.ts currently uses an in-memory Map to hold unmatched invoices
 *   pending dropship forwarding. On PM2 restart, the Map is lost and
 *   Will never sees the Telegram notification to manually forward.
 *
 *   This module persists dropship entries to agent_task with type='dropship_pending'.
 *   The existing agent_task infrastructure handles dedup (incrementOrCreate),
 *   TTL tracking via closes_when (deadline kind), and Telegram visibility.
 *
 * TABLE: agent_task (existing — no new migration needed)
 *   sourceTable: 'dropship_pending'
 *   sourceId: gmail_message_id (guaranteed unique per email)
 *   type: 'dropship_pending'
 *   goal: description of the vendor + invoice
 *   status: PENDING (needs Will to forward) → COMPLETED (forwarded)
 *   inputs: { vendorName, invoiceNumber, gmailMessageId, subject, pdfAttachmentId }
 */

import { createClient } from "@/lib/db";

const supabase = createClient();

export interface DropshipEntry {
    vendorName: string;
    invoiceNumber: string;
    gmailMessageId: string;
    subject: string;
    pdfAttachmentId?: string;
    receivedAt: string;
}

/**
 * Store an unmatched invoice as a persistent dropship entry.
 * Idempotent — uses incrementOrCreate to dedup on gmail_message_id.
 */
export async function storeDropship(entry: DropshipEntry): Promise<string | null> {
    const db = createClient();
    if (!db) {
        console.warn("[DropshipStore] Supabase unavailable — dropship entry lost");
        return null;
    }

    try {
        const { agentTask } = await import("@/lib/intelligence/agent-task");

        const task = await agentTask.incrementOrCreate({
            sourceTable: "dropship_pending",
            sourceId: entry.gmailMessageId,
            type: "dropship_pending",
            goal: `Dropship invoice from ${entry.vendorName}: ${entry.invoiceNumber || "unknown #"} — needs manual forward to Bill.com`,
            status: "PENDING",
            owner: "will",
            priority: 5,
            inputs: {
                vendorName: entry.vendorName,
                invoiceNumber: entry.invoiceNumber,
                gmailMessageId: entry.gmailMessageId,
                subject: entry.subject,
                pdfAttachmentId: entry.pdfAttachmentId || null,
                receivedAt: entry.receivedAt,
            },
        });

        console.log(`[DropshipStore] 📦 Stored dropship: ${entry.vendorName} (${entry.gmailMessageId})`);
        return task?.id || null;
    } catch (err: any) {
        console.error(`[DropshipStore] Failed to store: ${err.message}`);
        return null;
    }
}

/**
 * Mark a dropship as forwarded (completed).
 */
export async function completeDropship(gmailMessageId: string): Promise<void> {
    const db = createClient();
    if (!db) return;

    try {
        const { agentTask } = await import("@/lib/intelligence/agent-task");
        await agentTask.updateBySource("dropship_pending", gmailMessageId, {
            status: "COMPLETED",
        });
        console.log(`[DropshipStore] ✅ Completed dropship: ${gmailMessageId}`);
    } catch (err: any) {
        console.warn(`[DropshipStore] Failed to complete: ${err.message}`);
    }
}

/**
 * Get pending dropship entries (for Telegram /tasks view).
 */
export async function getPendingDropships(): Promise<DropshipEntry[]> {
    const db = createClient();
    if (!db) return [];

    try {
        const { data } = await supabase
            .from("agent_task")
            .select("inputs")
            .eq("source_table", "dropship_pending")
            .eq("status", "PENDING")
            .order("created_at", { ascending: false })
            .limit(50);

        if (!data) return [];

        return (data as any[]).map(row => {
            const inputs = row.inputs as Record<string, any>;
            return {
                vendorName: inputs.vendorName || "Unknown",
                invoiceNumber: inputs.invoiceNumber || "",
                gmailMessageId: inputs.gmailMessageId || "",
                subject: inputs.subject || "",
                pdfAttachmentId: inputs.pdfAttachmentId || undefined,
                receivedAt: inputs.receivedAt || "",
            };
        });
    } catch (err: any) {
        console.warn(`[DropshipStore] Failed to list pending: ${err.message}`);
        return [];
    }
}

/**
 * Check if a specific Gmail message has already been processed as a dropship.
 * Used by ap-agent.ts dedup check before re-processing on crash+repoll.
 */
export async function hasDropship(gmailMessageId: string): Promise<boolean> {
    const db = createClient();
    if (!db) return false;

    try {
        const { count } = await supabase
            .from("agent_task")
            .select("*", { count: "exact", head: true })
            .eq("source_table", "dropship_pending")
            .eq("source_id", gmailMessageId);

        return (count ?? 0) > 0;
    } catch {
        return false;
    }
}
