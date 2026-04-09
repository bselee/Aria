import { describe, test, expect } from 'vitest';
import { derivePOLifecycleState, type POLifecycleState, type POLifecycleResult } from './derive-po-lifecycle';

describe('derivePOLifecycleState', () => {
    test('returns sent state for any PO ID', () => {
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

    test('evidence has correct shape with no extra fields', () => {
        const result = derivePOLifecycleState({ id: 'PO-004' });
        const keys = Object.keys(result.evidence).sort();
        expect(keys).toEqual(['computedAt', 'sentDate']);
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
});
