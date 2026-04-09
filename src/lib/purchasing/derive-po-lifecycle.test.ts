import { describe, test, expect } from 'vitest';
import { derivePOLifecycleState, shouldRequestTrackingFollowUp, type POLifecycleState, type POLifecycleResult } from './derive-po-lifecycle';

describe('derivePOLifecycleState', () => {
    test('returns sent state for minimal input', () => {
        const result = derivePOLifecycleState({ id: 'PO-12345' });
        expect(result.state).toBe('sent');
    });

    test('returns sent state for empty ID', () => {
        const result = derivePOLifecycleState({ id: '' });
        expect(result.state).toBe('sent');
    });

    test('evidence contains computedAt ISO timestamp', () => {
        const result = derivePOLifecycleState({ id: 'PO-001' });
        expect(result.evidence.computedAt).toBeDefined();
        expect(new Date(result.evidence.computedAt).getTime()).not.toBeNaN();
    });

    test('evidence uses provided sentDate when available', () => {
        const result = derivePOLifecycleState({ id: 'PO-002', sentDate: '2026-01-15T10:00:00Z' });
        expect(result.evidence.sentDate).toBe('2026-01-15T10:00:00Z');
    });

    test('evidence defaults sentDate to computedAt when not provided', () => {
        const result = derivePOLifecycleState({ id: 'PO-003' });
        expect(result.evidence.sentDate).toBe(result.evidence.computedAt);
    });

    test('return type satisfies POLifecycleResult shape', () => {
        const result: POLifecycleResult = derivePOLifecycleState({ id: 'PO-005' });
        expect(result).toHaveProperty('state');
        expect(result).toHaveProperty('evidence');
    });

    test('all lifecycle state values are valid strings', () => {
        const validStates: POLifecycleState[] = [
            'sent',
            'vendor_acknowledged',
            'tracking_unavailable',
            'moving_with_tracking',
            'ap_follow_up',
        ];
        const result = derivePOLifecycleState({ id: 'PO-006' });
        expect(validStates).toContain(result.state);
    });

    // State path: moving_with_tracking
    test('returns moving_with_tracking when vendor acked and tracking present', () => {
        const result = derivePOLifecycleState({
            id: 'PO-100',
            hasVendorAck: true,
            hasTracking: true,
            trackingNumbers: ['1Z999AA10123456784'],
            acknowledgmentDate: '2026-04-01T12:00:00Z',
        });
        expect(result.state).toBe('moving_with_tracking');
        expect(result.evidence.trackingNumbers).toEqual(['1Z999AA10123456784']);
        expect(result.evidence.acknowledgmentDate).toBe('2026-04-01T12:00:00Z');
    });

    // State path: vendor_acknowledged
    test('returns vendor_acknowledged when vendor acked but no tracking', () => {
        const result = derivePOLifecycleState({
            id: 'PO-200',
            hasVendorAck: true,
            hasTracking: false,
            acknowledgmentDate: '2026-04-02T09:00:00Z',
        });
        expect(result.state).toBe('vendor_acknowledged');
        expect(result.evidence.acknowledgmentDate).toBe('2026-04-02T09:00:00Z');
        expect(result.evidence.trackingNumbers).toBeUndefined();
    });

    // State path: ap_follow_up
    test('returns ap_follow_up when invoice present but no tracking or ack', () => {
        const result = derivePOLifecycleState({
            id: 'PO-300',
            hasInvoice: true,
            hasTracking: false,
            hasVendorAck: false,
        });
        expect(result.state).toBe('ap_follow_up');
        expect(result.evidence.apFollowUpReason).toBe('invoice_received_without_tracking_or_acknowledgment');
    });

    test('does not return ap_follow_up when tracking exists', () => {
        const result = derivePOLifecycleState({
            id: 'PO-301',
            hasInvoice: true,
            hasTracking: true,
            hasVendorAck: false,
        });
        expect(result.state).not.toBe('ap_follow_up');
    });

    test('does not return ap_follow_up when vendor ack exists', () => {
        const result = derivePOLifecycleState({
            id: 'PO-302',
            hasInvoice: true,
            hasTracking: false,
            hasVendorAck: true,
        });
        expect(result.state).not.toBe('ap_follow_up');
    });

    // State path: tracking_unavailable
    test('returns tracking_unavailable when follow-up sent and no ack', () => {
        const result = derivePOLifecycleState({
            id: 'PO-400',
            hasVendorAck: false,
            followUpSentAt: '2026-04-05T14:00:00Z',
        });
        expect(result.state).toBe('tracking_unavailable');
        expect(result.evidence.followUpSentAt).toBe('2026-04-05T14:00:00Z');
    });

    test('vendor_acknowledged takes priority over tracking_unavailable', () => {
        const result = derivePOLifecycleState({
            id: 'PO-401',
            hasVendorAck: true,
            followUpSentAt: '2026-04-05T14:00:00Z',
        });
        expect(result.state).toBe('vendor_acknowledged');
    });

    // State path: sent (default)
    test('returns sent when no signals present', () => {
        const result = derivePOLifecycleState({
            id: 'PO-500',
            hasVendorAck: false,
            hasTracking: false,
        });
        expect(result.state).toBe('sent');
    });

    test('returns sent when only sentDate provided', () => {
        const result = derivePOLifecycleState({
            id: 'PO-501',
            sentDate: '2026-04-01T08:00:00Z',
        });
        expect(result.state).toBe('sent');
        expect(result.evidence.sentDate).toBe('2026-04-01T08:00:00Z');
    });

    // Evidence accumulation
    test('evidence includes all provided tracking numbers', () => {
        const result = derivePOLifecycleState({
            id: 'PO-600',
            hasTracking: true,
            hasVendorAck: true,
            trackingNumbers: ['1Z999AA10123456784', '794644790132'],
        });
        expect(result.evidence.trackingNumbers).toHaveLength(2);
    });

    test('evidence includes followUpSentAt when provided', () => {
        const result = derivePOLifecycleState({
            id: 'PO-601',
            followUpSentAt: '2026-04-06T10:00:00Z',
        });
        expect(result.evidence.followUpSentAt).toBe('2026-04-06T10:00:00Z');
    });

    test('moving_with_tracking takes priority over tracking_unavailable', () => {
        const result = derivePOLifecycleState({
            id: 'PO-700',
            hasVendorAck: true,
            hasTracking: true,
            followUpSentAt: '2026-04-05T14:00:00Z',
        });
        expect(result.state).toBe('moving_with_tracking');
    });
});

describe('shouldRequestTrackingFollowUp', () => {
    test('allows first follow-up when vendor has not acked', () => {
        expect(shouldRequestTrackingFollowUp(0, 0, false)).toBe(true);
    });

    test('blocks follow-up after 2 requests with no evidence', () => {
        expect(shouldRequestTrackingFollowUp(2, 0, false)).toBe(false);
    });

    test('blocks follow-up after 2 requests with no evidence even with ack', () => {
        expect(shouldRequestTrackingFollowUp(2, 0, true)).toBe(false);
    });

    test('allows follow-up when acked but no tracking evidence yet (count < 2)', () => {
        expect(shouldRequestTrackingFollowUp(1, 0, true)).toBe(true);
    });

    test('blocks follow-up when shipping evidence exists', () => {
        expect(shouldRequestTrackingFollowUp(0, 1, true)).toBe(false);
    });
});
