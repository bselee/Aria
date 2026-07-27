/**
 * @file    resolve-status.test.ts
 * @purpose Unit tests for the invoice-queue status resolver.
 *          Pure logic — no DB, no Next.js, no network.
 * @author  Hermia
 */
import { describe, expect, it } from 'vitest';
import { resolveStatus } from './resolve-status';

describe('resolveStatus', () => {
    // ── Explicit statuses (regression guard) ──────────────────────────────────

    it('returns auto_approved for matched_approved status', () => {
        expect(resolveStatus('matched_approved', null, null)).toBe('auto_approved');
    });

    it('returns auto_approved when action_taken contains "applied"', () => {
        expect(resolveStatus('received', 'applied', null)).toBe('auto_approved');
    });

    it('returns auto_approved when action_taken contains "auto-approv"', () => {
        expect(resolveStatus('received', 'auto-approved', null)).toBe('auto_approved');
    });

    it('returns needs_approval for matched_review status', () => {
        expect(resolveStatus('matched_review', null, null)).toBe('needs_approval');
    });

    it('returns needs_approval when action_taken contains "pending"', () => {
        expect(resolveStatus('received', 'pending review', null)).toBe('needs_approval');
    });

    it('returns rejected when action_taken contains "rejected"', () => {
        expect(resolveStatus('received', 'rejected - no match', null)).toBe('rejected');
    });

    it('returns duplicate for duplicate status', () => {
        expect(resolveStatus('duplicate', null, null)).toBe('duplicate');
    });

    it('returns duplicate when action_taken contains "duplicate"', () => {
        expect(resolveStatus('received', 'duplicate invoice', null)).toBe('duplicate');
    });

    it('returns unmatched when status is "unmatched"', () => {
        expect(resolveStatus('unmatched', null, null)).toBe('unmatched');
    });

    it('returns unmatched when action_taken contains "no match"', () => {
        expect(resolveStatus('received', 'no match found', null)).toBe('unmatched');
    });

    // ── metadata verdict overrides ────────────────────────────────────────────

    it('defers to metadata.verdict short_shipment_hold', () => {
        expect(resolveStatus('received', null, { verdict: 'short_shipment_hold' })).toBe('short_shipment_hold');
    });

    it('defers to metadata.verdict auto_approve', () => {
        expect(resolveStatus('received', null, { verdict: 'auto_approve' })).toBe('auto_approved');
    });

    it('defers to metadata.verdict needs_approval', () => {
        expect(resolveStatus('received', null, { verdict: 'needs_approval' })).toBe('needs_approval');
    });

    it('defers to metadata.overallVerdict when verdict not set', () => {
        expect(resolveStatus('received', null, { overallVerdict: 'rejected' })).toBe('rejected');
    });

    it('prefers metadata.overallVerdict over verdict', () => {
        expect(resolveStatus('received', null, { overallVerdict: 'rejected', verdict: 'auto_approve' })).toBe('rejected');
    });

    // ── THE BUG FIX: po_number presence ───────────────────────────────────────

    it('returns matched_unreconciled when po_number is present and no other branch matches (status=received)', () => {
        // This is the core fix: an invoice with a po_number but status='received'
        // should NOT be labelled 'unmatched'
        expect(resolveStatus('received', null, null, '124977')).toBe('matched_unreconciled');
    });

    it('returns unmatched when po_number is absent and no other branch matches (status=received)', () => {
        // This is the genuine NO-PO case — no po_number means truly unmatched
        expect(resolveStatus('received', null, null, null)).toBe('unmatched');
    });

    it('returns unmatched when po_number is empty string', () => {
        expect(resolveStatus('received', null, null, '')).toBe('unmatched');
    });

    it('returns matched_unreconciled for whitespace-padded po_number', () => {
        expect(resolveStatus('received', null, null, '  124977  ')).toBe('matched_unreconciled');
    });

    it('returns matched_unreconciled for po_number "none" string (edge case from data)', () => {
        // Some invoices have po_number='none' as a sentinel value
        expect(resolveStatus('received', null, null, 'none')).toBe('matched_unreconciled');
    });

    it('still returns auto_approved when po_number present but status takes priority', () => {
        // Explicit statuses should still take priority over po_number
        expect(resolveStatus('matched_approved', null, null, 'PO123')).toBe('auto_approved');
    });

    it('still returns duplicate when po_number present', () => {
        expect(resolveStatus('duplicate', null, null, 'PO123')).toBe('duplicate');
    });

    it('still returns unmatched via action_taken even with po_number', () => {
        // Action-based explicit unmatched should still win
        expect(resolveStatus('received', 'no match found', null, 'PO123')).toBe('unmatched');
    });

    it('still defers to metadata verdict even with po_number', () => {
        expect(resolveStatus('received', null, { verdict: 'rejected' }, 'PO123')).toBe('rejected');
    });

    // ── Edge cases ────────────────────────────────────────────────────────────

    it('handles null invoiceStatus gracefully', () => {
        expect(resolveStatus(null, null, null, null)).toBe('unmatched');
    });

    it('handles null actionTaken gracefully', () => {
        expect(resolveStatus('received', null, null, null)).toBe('unmatched');
    });

    it('handles undefined metadata gracefully', () => {
        // The function signature defaults metadata to null, so this is fine
        expect(resolveStatus('received', null, null, null)).toBe('unmatched');
    });

    it('case-insensitive matching for invoiceStatus', () => {
        expect(resolveStatus('MATCHED_APPROVED', null, null)).toBe('auto_approved');
        expect(resolveStatus('DUPLICATE', null, null)).toBe('duplicate');
    });

    it('case-insensitive matching for actionTaken', () => {
        expect(resolveStatus('received', 'PENDING REVIEW', null)).toBe('needs_approval');
        expect(resolveStatus('received', 'No Match Found', null)).toBe('unmatched');
    });
});
