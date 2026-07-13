/**
 * @file    lead-time-enricher.ts
 * @purpose Corrects the lead-time anchor used in getVendorLeadTimeHistory().
 *
 * Finale's `orderDate` field is the PO creation date — the moment a draft is
 * saved in Finale. For POs that sit in draft for a day or more before being
 * emailed, this inflates the apparent lead time by the draft-hold duration.
 *
 * This module queries our Supabase `purchase_orders` table for the
 * `po_sent_verified_at` timestamp — the moment the PO email was confirmed sent.
 * When available for a given PO number, that timestamp is a more accurate
 * lead-time anchor than `orderDate`.
 *
 * Usage:
 *   const sentAtMap = await loadPOSentTimestamps(180);
 *   // Then for each PO: use sentAtMap.get(poNumber) ?? finaleOrderDate
 *
 * @author  Aria
 * @created 2026-05-20
 * @updated 2026-05-20
 * @deps    @/lib/supabase
 */

import { createClient } from '@/lib/db';

/**
 * Loads a map of PO number → po_sent_verified_at (ISO string) for all POs
 * whose `po_sent_verified_at` falls within the last `daysBack` days.
 *
 * Used by getVendorLeadTimeHistory() to correct the lead-time anchor from
 * Finale's `orderDate` (draft creation) to actual send time.
 *
 * Returns an empty Map when Supabase is unavailable — callers fall back to
 * Finale `orderDate` automatically.
 *
 * @param daysBack  Look-back window in days. Matches the window used by
 *                  getVendorLeadTimeHistory() (default: 365).
 */
export async function loadPOSentTimestamps(daysBack = 365): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const db = createClient();
    if (!db) return map;

    try {
        const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();
        const { data, error } = await db
            .from('purchase_orders')
            .select('po_number, po_sent_verified_at')
            .not('po_sent_verified_at', 'is', null)
            .gte('po_sent_verified_at', since);

        if (error || !data) {
            console.warn('[lead-time-enricher] PostgREST query failed:', error?.message);
            return map;
        }

        for (const row of data as Array<{ po_number: string; po_sent_verified_at: string }>) {
            if (row.po_number && row.po_sent_verified_at) {
                map.set(row.po_number, row.po_sent_verified_at);
            }
        }
    } catch (err: any) {
        console.warn('[lead-time-enricher] Unexpected error:', err.message);
    }

    return map;
}

/**
 * Given a Finale `orderDate` and a `po_sent_verified_at` map, returns the
 * best available anchor date for this PO.
 *
 * Preference: po_sent_verified_at (verified email send) → orderDate (Finale draft).
 *
 * @param finaleOrderDate   ISO date string from Finale GraphQL (`orderDate` field)
 * @param poNumber          Finale PO number to look up in the sent-timestamp map
 * @param sentAtMap         Pre-loaded map from loadPOSentTimestamps()
 */
export function resolveLeadTimeAnchor(
    finaleOrderDate: string,
    poNumber: string | undefined,
    sentAtMap: Map<string, string>,
): string {
    if (poNumber) {
        const sentAt = sentAtMap.get(poNumber);
        if (sentAt) return sentAt;
    }
    return finaleOrderDate;
}
