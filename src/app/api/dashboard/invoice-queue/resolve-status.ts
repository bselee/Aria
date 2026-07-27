/**
 * @file    resolve-status.ts
 * @purpose Canonical display-status resolver for the invoice-queue dashboard.
 *          Extracted so it can be unit-tested without booting the Next.js route.
 *
 *          The critical rule: an invoice WITH a po_number must NEVER be reported
 *          as 'unmatched' ("NO PO"). The po_number is authoritative proof that
 *          PO matching already succeeded — the invoice is matched but awaiting
 *          reconciliation processing.
 *
 * @author  Hermia
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ResolvedStatus =
    | 'auto_approved'
    | 'needs_approval'
    | 'rejected'
    | 'duplicate'
    | 'unmatched'
    | 'short_shipment_hold'
    | 'matched_unreconciled';

// ── Resolver ──────────────────────────────────────────────────────────────────

/**
 * Map raw invoice `status` + most recent activity log action_taken
 * to a canonical display status.
 *
 * @param invoiceStatus  - The `vendor_invoices.status` column value.
 * @param actionTaken    - The most recent `ap_activity_log.action_taken` value (if any).
 * @param metadata       - The most recent `ap_activity_log.metadata` JSON object (if any).
 * @param poNumber       - The invoice's `po_number` column. When present and truthy,
 *                         the invoice IS matched to a PO and MUST NOT be classified
 *                         as 'unmatched' — this is the core fix for the false-positive
 *                         "NO PO" reporting bug.
 * @returns A canonical display status string.
 */
export function resolveStatus(
    invoiceStatus: string | null,
    actionTaken: string | null,
    metadata: Record<string, unknown> | null = null,
    poNumber: string | null = null,
): ResolvedStatus {
    const verdict = metadata?.overallVerdict ?? metadata?.verdict ?? null;
    if (verdict === 'short_shipment_hold') {
        return 'short_shipment_hold';
    }
    if (verdict === 'needs_approval') {
        return 'needs_approval';
    }
    if (verdict === 'auto_approve' || verdict === 'auto_approved') {
        return 'auto_approved';
    }
    if (verdict === 'rejected') {
        return 'rejected';
    }
    if (verdict === 'duplicate') {
        return 'duplicate';
    }

    const a = (actionTaken ?? '').toLowerCase();
    const s = (invoiceStatus ?? '').toLowerCase();

    // Explicit invoice statuses from reconciler
    if (s === 'matched_approved' || a.includes('applied') || a.includes('auto-approv')) {
        return 'auto_approved';
    }
    if (s === 'matched_review' || a.includes('pending') || a.includes('flagged') || a.includes('approval')) {
        return 'needs_approval';
    }
    if (a.includes('rejected') || a.includes('reject')) {
        return 'rejected';
    }
    if (s === 'duplicate' || a.includes('duplicate') || a.includes('already processed')) {
        return 'duplicate';
    }
    // Default: unmatched if no PO was found
    if (s === 'unmatched' || a.includes('no match') || a.includes('unmatched') || a.includes('dropship')) {
        return 'unmatched';
    }

    // ── PO-number guard (the core fix) ───────────────────────────────────────
    // An invoice with a po_number is authoritatively matched to a PO. Even when
    // the reconciler hasn't processed it yet (status='received', reconciled_at=NULL),
    // it must NEVER be labelled "NO PO". Map it as matched-but-unreconciled so
    // the dashboard accurately reflects PO-assignment status without over-reporting
    // the unmatched count.
    if (poNumber && poNumber.trim().length > 0) {
        return 'matched_unreconciled';
    }

    // Forwarded to Bill.com but no reconciliation result yet
    return 'unmatched';
}

/**
 * Check whether a resolved status belongs to the "needs attention" group.
 */
export function isPendingStatus(status: ResolvedStatus): boolean {
    return status === 'needs_approval' || status === 'short_shipment_hold';
}
