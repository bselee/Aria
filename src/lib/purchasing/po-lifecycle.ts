/**
 * @file    src/lib/purchasing/po-lifecycle.ts
 * @purpose PO lifecycle state machine — tracks every PO through
 *          REVIEW → SENT → ACKNOWLEDGED → INVOICED → RECONCILED → RECEIVED → COMPLETED
 *          Plus CANCELLED as a terminal state.
 *          ORDERED is retained as a legacy alias for data compatibility.
 * @author  Hermia
 * @created 2026-06-01
 * @updated 2026-06-01 (added REVIEW, SENT, ACKNOWLEDGED, CANCELLED dispatch stages)
 * @deps    @/lib/db
 *
 * All functions are best-effort (try/catch, never throw) so they can
 * @deps    @/lib/db
 */

import { createClient } from "@/lib/db";
import { getLocalDb } from "@/lib/storage/local-db";

/** Valid lifecycle states */
export const PO_LIFECYCLE_STATES = [
    "ORDERED",        // legacy — kept for backward-compat with existing data
    "REVIEW",         // draft created in Finale, awaiting human review
    "SENT",           // PO dispatched to vendor via email
    "ACKNOWLEDGED",   // vendor replied confirming receipt
    "INVOICED",       // invoice received and matched
    "RECONCILED",     // invoice lines reconciled against PO
    "RECEIVED",       // goods received (partial or full)
    "COMPLETED",      // all done
    "CANCELLED",      // PO cancelled — terminal
] as const;

export type POLifecycleState = (typeof PO_LIFECYCLE_STATES)[number];

/** Initial state for new POs (replaces legacy ORDERED) */
export const INITIAL_LIFECYCLE_STATE = "REVIEW";

/**
 * Valid state transitions.
 * Backward compatibility: ORDERED maps to same children as REVIEW
 * so existing POs with legacy state can still progress.
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
    // Legacy backward compat
    ORDERED: ["INVOICED", "RECEIVED", "CANCELLED"],
    // Dispatch stages
    REVIEW: ["SENT", "INVOICED", "RECEIVED", "CANCELLED"],
    SENT: ["ACKNOWLEDGED", "INVOICED", "RECEIVED"],
    ACKNOWLEDGED: ["INVOICED", "RECEIVED"],
    // Invoice / fulfillment pipeline
    INVOICED: ["RECONCILED", "RECEIVED"],
    RECONCILED: ["RECEIVED", "COMPLETED"],
    RECEIVED: ["RECONCILED", "COMPLETED"],
    COMPLETED: [], // terminal state
    CANCELLED: [], // terminal state
};

/** Fallback if state is missing or null */
function resolveState(state: string | null): string {
    return state || INITIAL_LIFECYCLE_STATE;
}

/**
 * Assert that a state transition is valid.
 * @throws Error if the transition is invalid
 * @internal
 */
export function assertValidTransition(from: string | null, to: string): void {
    const resolved = resolveState(from);
    const allowed = VALID_TRANSITIONS[resolved];
    if (!allowed || !allowed.includes(to)) {
        throw new Error(
            `Invalid PO lifecycle transition: ${resolved} → ${to}. ` +
            `Allowed from ${resolved}: [${(allowed || []).join(", ")}]`
        );
    }
}

/**
 * Get current lifecycle state for a PO.
 * @returns The current state, or REVIEW if no state is recorded
 */
export async function getLifecycleState(
    poNumber: string
): Promise<POLifecycleState | null> {
    try {
        const supabase = createClient();
        if (!supabase) return null;

        const { data, error } = await supabase
            .from("purchase_orders")
            .select("lifecycle_state")
            .eq("po_number", poNumber)
            .single();

        if (error || !data) return INITIAL_LIFECYCLE_STATE as POLifecycleState;
        return (data.lifecycle_state as POLifecycleState) || INITIAL_LIFECYCLE_STATE as POLifecycleState;
    } catch (err) {
        console.warn(
            `[po-lifecycle] Failed to get state for PO ${poNumber}:`,
            (err as Error).message
        );
        return null;
    }
}

/**
 * Transition a PO to a new lifecycle state.
 * Writes to both purchase_orders.lifecycle_state AND po_lifecycle_transitions.
 * Always best-effort — never throws.
 *
 * @param poNumber - Finale PO number
 * @param toState - Target state
 * @param triggeredBy - Who/what triggered this transition (e.g. "ap-agent", "reconciler")
 * @param metadata - Optional extra context (invoice ID, reconciliation verdict, etc.)
 */
export async function transitionLifecycleState(
    poNumber: string,
    toState: POLifecycleState,
    triggeredBy: string,
    metadata?: Record<string, unknown>
): Promise<void> {
    try {
        // Phase 1: Write to local SQLite FIRST — crash-safe write-ahead log
        // If process crashes after this write but before Supabase, the transition
        // is recoverable from local DB on next boot.
        let currentState: string | null = INITIAL_LIFECYCLE_STATE;
        try {
            const db = getLocalDb();
            const existing = db.prepare(
                `SELECT lifecycle_state FROM po_lifecycle_cache WHERE po_number = ?`
            ).get(poNumber) as { lifecycle_state: string } | undefined;
            if (existing) currentState = existing.lifecycle_state;

            // Silent skip: already in the target state
            if (currentState === toState) return;

            // Validate transition
            try {
                assertValidTransition(currentState, toState);
            } catch (valErr) {
                console.warn(
                    `[po-lifecycle] ${(valErr as Error).message} — skipping transition`
                );
                return;
            }

            const now = new Date().toISOString();
            db.prepare(
                `INSERT OR REPLACE INTO po_lifecycle_cache (po_number, lifecycle_state, last_transitioned_at, triggered_by)
                 VALUES (?, ?, ?, ?)`
            ).run(poNumber, toState, now, triggeredBy);
        } catch (localErr) {
            console.warn(
                `[po-lifecycle] Local SQLite write failed for PO ${poNumber}:`,
                (localErr as Error).message
            );
            // Continue to Supabase anyway — local write is best-effort
        }

        // Phase 2: Write to Supabase (durable remote storage)
        const supabase = createClient();
        if (!supabase) {
            console.warn(
                `[po-lifecycle] No Supabase client — skipping transition ${poNumber} → ${toState}`
            );
            return; // Local SQLite write already done above — state is safe
        }

        // Validation already passed in Phase 1 (local SQLite write) — skip duplicate
        const now = new Date().toISOString();

        // Update purchase_orders
        const { error: updateErr } = await supabase
            .from("purchase_orders")
            .update({
                lifecycle_state: toState,
                updated_at: now,
            })
            .eq("po_number", poNumber);

        if (updateErr) {
            console.warn(
                `[po-lifecycle] Failed to update purchase_orders for PO ${poNumber}:`,
                updateErr.message
            );
        }

        // Insert transition audit log
        const resolvedFrom = resolveState(currentState);
        const { error: insertErr } = await supabase
            .from("po_lifecycle_transitions")
            .insert({
                po_number: poNumber,
                from_state: resolvedFrom,
                to_state: toState,
                transitioned_at: now,
                triggered_by: triggeredBy,
                metadata: metadata || null,
                invoice_id: (metadata?.invoiceId as string) || null,
            });

        if (insertErr) {
            console.warn(
                `[po-lifecycle] Failed to log transition for PO ${poNumber}:`,
                insertErr.message
            );
        }

        console.log(
            `[po-lifecycle] ${poNumber}: ${resolvedFrom} → ${toState} (${triggeredBy})`
        );
    } catch (err) {
        console.warn(
            `[po-lifecycle] Unexpected error transitioning PO ${poNumber}:`,
            (err as Error).message
        );
    }
}

/**
 * Get the last N transition events for a PO.
 */
export async function getPOLifecycleHistory(
    poNumber: string,
    limit: number = 10
): Promise<Array<Record<string, unknown>> | null> {
    try {
        const supabase = createClient();
        if (!supabase) return null;

        const { data, error } = await supabase
            .from("po_lifecycle_transitions")
            .select("*")
            .eq("po_number", poNumber)
            .order("transitioned_at", { ascending: false })
            .limit(limit);

        if (error) {
            console.warn(
                `[po-lifecycle] Failed to fetch history for PO ${poNumber}:`,
                error.message
            );
            return null;
        }

        return data;
    } catch (err) {
        console.warn(
            `[po-lifecycle] Unexpected error fetching history for PO ${poNumber}:`,
            (err as Error).message
        );
        return null;
    }
}

/**
 * Get a summary of lifecycle states across all POs.
 * Returns counts per state.
 */
export async function getLifecycleSummary(): Promise<
    Record<string, number> | null
> {
    try {
        const supabase = createClient();
        if (!supabase) return null;

        const { data, error } = await supabase
            .from("purchase_orders")
            .select("lifecycle_state");

        if (error || !data) return null;

        const counts: Record<string, number> = {};
        for (const row of data) {
            const state = (row.lifecycle_state as string) || INITIAL_LIFECYCLE_STATE;
            counts[state] = (counts[state] || 0) + 1;
        }
        return counts;
    } catch (err) {
        console.warn(
            `[po-lifecycle] Failed to get lifecycle summary:`,
            (err as Error).message
        );
        return null;
    }
}