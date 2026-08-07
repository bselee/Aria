/**
 * @file    src/lib/storage/po-cache-change.ts
 * @purpose Pure change-detection for po-finale-sync. Decide whether a Finale
 *          PO snapshot differs from the local po_cache row enough to warrant
 *          enqueueSync. Keeps the cron handler free of re-enqueue floods.
 * @author  Hermia
 * @created 2026-08-07
 * @deps    none (pure)
 * @env     none
 */

/** Minimal cache shape needed for change detection. */
export interface POCacheChangeFields {
    status: string | null;
    total_amount: number;
    line_items: string;
    lifecycle_state: string | null;
    estimated_eta: string | null;
    updated_at: string | null;
}

/**
 * Returns true when the Finale snapshot differs from the cached row
 * (or when no cache row exists). False means skip enqueueSync.
 *
 * @param existing - Current po_cache row, or null if missing/expired
 * @param incoming - Normalized fields from Finale
 */
export function poCacheNeedsEnqueue(
    existing: POCacheChangeFields | null | undefined,
    incoming: POCacheChangeFields,
): boolean {
    if (!existing) return true;
    return (
        existing.status !== incoming.status ||
        existing.total_amount !== incoming.total_amount ||
        existing.line_items !== incoming.line_items ||
        existing.lifecycle_state !== incoming.lifecycle_state ||
        existing.estimated_eta !== incoming.estimated_eta ||
        existing.updated_at !== incoming.updated_at
    );
}
