/**
 * @file    src/lib/purchasing/po-lifecycle.ts
 * @purpose PO lifecycle state machine — tracks every PO through
 *          ORDERED → INVOICED → RECONCILED → RECEIVED → COMPLETED
 * @author  Hermia
 * @created 2026-06-01
 * @deps    @/lib/supabase
 *
 * All functions are best-effort (try/catch, never throw) so they can
 * be safely called from anywhere in the AP pipeline without blocking.
 */

import { createClient } from "@/lib/supabase";

/** Valid lifecycle states */
export const PO_LIFECYCLE_STATES = [
    "ORDERED",
    "INVOICED",
    "RECONCILED",
    "RECEIVED",
    "COMPLETED",
] as const;

export type POLifecycleState = (typeof PO_LIFECYCLE_STATES)[number];

/** Valid state transitions */
const VALID_TRANSITIONS: Record<string, string[]> = {
    ORDERED: ["INVOICED", "RECEIVED"],
    INVOICED: ["RECONCILED", "RECEIVED"],
    RECONCILED: ["RECEIVED", "COMPLETED"],
    RECEIVED: ["RECONCILED", "COMPLETED"],
    COMPLETED: [], // terminal state
};

/**
 * Assert that a state transition is valid.
 * @throws Error if the transition is invalid
 * @internal
 */
export function assetValidTransition(from: string | null, to: string): void {
    const allowed = VALID_TRANSITIONS[from || "ORDERED"];
    if (!allowed || !allowed.includes(to)) {
        throw new Error(
            `Invalid PO lifecycle transition: ${from || "ORDERED"} → ${to}. ` +
            `Allowed from ${from || "ORDERED"}: [${(allowed || []).join(", ")}]`
        );
    }
}

/**
 * Get current lifecycle state for a PO.
 * @returns The current state, or "ORDERED" if no state is recorded
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

        if (error || !data) return "ORDERED";
        return (data.lifecycle_state as POLifecycleState) || "ORDERED";
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
        const supabase = createClient();
        if (!supabase) {
            console.warn(
                `[po-lifecycle] No Supabase client — skipping transition ${poNumber} → ${toState}`
            );
            return;
        }

        // Get current state
        const currentState = await getLifecycleState(poNumber);

        // Validate transition
        try {
            assetValidTransition(currentState, toState);
        } catch (valErr) {
            console.warn(
                `[po-lifecycle] ${(valErr as Error).message} — skipping transition`
            );
            return;
        }

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
        const { error: insertErr } = await supabase
            .from("po_lifecycle_transitions")
            .insert({
                po_number: poNumber,
                from_state: currentState || "ORDERED",
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
            `[po-lifecycle] ${poNumber}: ${currentState || "ORDERED"} → ${toState} (${triggeredBy})`
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
export async function getP̣OLifecycleHistory(
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
            const state = (row.lifecycle_state as string) || "ORDERED";
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