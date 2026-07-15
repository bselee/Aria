/**
 * @file    reconciliation-outcomes.ts
 * @purpose Best-effort structured outcome writes for the AP reconciliation pipeline.
 *          Each terminal outcome in the reconciler/ap-agent writes one row here,
 *          parallel to (never replacing) the existing ap_activity_log writes.
 *
 * NEVER THROWS. All errors are swallowed with console.warn so existing pipeline
 * behaviour is completely unaffected by a Supabase failure or missing env vars.
 *
 * Phase 1a Task 3 — runtime observability namespace.
 */

import { createClient } from "@/lib/db";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReconciliationOutcome =
    | "auto_applied"       // reconciler auto-applied changes within thresholds
    | "pending_approval"   // enqueued for dashboard / Telegram approval
    | "approved_by_user"   // Will approved a pending proposal
    | "rejected_by_user"   // Will rejected a pending proposal
    | "expired"            // pending approval hit 24h TTL with no decision
    | "match_failed"       // invoice arrived but no PO match found
    | "rejected_10x"       // ≥10× magnitude guardrail blocked the write
    | "rejected_invariant"; // subtotal mismatch or price-reasonableness check failed

export interface OutcomeWrite {
    /** UUID — reuse the ReconciliationRun.id when present; otherwise a fresh UUID */
    runId: string;
    outcome: ReconciliationOutcome;
    invoiceId?: string;
    poId?: string;
    vendorName?: string;
    /** Small JSON payload: price_delta_pct, total_impact, match_signals, etc. */
    outcomeMeta?: Record<string, unknown>;
    durationMs?: number;
    /**
     * Set to new Date() for terminal-on-write outcomes:
     *   auto_applied, match_failed, rejected_10x, rejected_invariant,
     *   approved_by_user, rejected_by_user, expired
     * Leave undefined for pending_approval (resolved later).
     */
    resolvedAt?: Date;
}

// ── Writer ────────────────────────────────────────────────────────────────────

/**
 * Best-effort write to `reconciliation_outcomes`. NEVER throws.
 *
 * If Supabase is unavailable, env vars are missing, or the insert fails,
 * this function logs with console.warn and returns silently.
 * `ap_activity_log` remains the primary source of truth for audit.
 */
export async function writeReconciliationOutcome(write: OutcomeWrite): Promise<void> {
    try {
        const db = createClient();
        if (!db) {
            // Supabase not configured — silently no-op
            return;
        }

        const { error } = await db.from("reconciliation_outcomes").insert({
            run_id:       write.runId,
            invoice_id:   write.invoiceId ?? null,
            po_id:        write.poId ?? null,
            vendor_name:  write.vendorName ?? null,
            outcome:      write.outcome,
            outcome_meta: write.outcomeMeta ?? null,
            duration_ms:  write.durationMs ?? null,
            resolved_at:  write.resolvedAt?.toISOString() ?? null,
        });

        if (error) {
            console.warn(`[reconciliation-outcomes] insert failed (${write.outcome}): ${error.message}`);
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[reconciliation-outcomes] unexpected error (${write.outcome}): ${msg}`);
    }
}

export async function resolvePendingReconciliationOutcomeBySource(input: {
    sourceActivityLogId: string;
    resolution: "approved_by_user" | "rejected_by_user" | "expired";
    resolvedAt?: Date;
}): Promise<void> {
    try {
        const db = createClient();
        if (!db) return;

        const { error } = await db
            .from("reconciliation_outcomes")
            .update({
                resolved_at: (input.resolvedAt ?? new Date()).toISOString(),
            })
            .eq("outcome", "pending_approval")
            .contains("outcome_meta", { source_activity_log_id: input.sourceActivityLogId })
            .is("resolved_at", null);

        if (error) {
            console.warn(`[reconciliation-outcomes] resolve pending failed (${input.sourceActivityLogId}): ${error.message}`);
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[reconciliation-outcomes] resolve pending unexpected error (${input.sourceActivityLogId}): ${msg}`);
    }
}
