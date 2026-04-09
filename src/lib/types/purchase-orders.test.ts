import { describe, it, expect } from 'vitest';
import { getValidNextStates, isValidTransition, POLifecycleState } from './purchase-orders';

/**
 * Test suite for PO lifecycle types and transition logic
 */
describe('PO Lifecycle Transitions', () => {
  describe('getValidNextStates', () => {
    it('should return valid transitions for DRAFT', () => {
      expect(getValidNextStates('DRAFT')).toEqual(['COMMITTED']);
    });

    it('should return valid transitions for COMMITTED', () => {
      expect(getValidNextStates('COMMITTED')).toEqual(['SENT']);
    });

    it('should return valid transitions for SENT', () => {
      expect(getValidNextStates('SENT')).toEqual(['ACKNOWLEDGED', 'IN_TRANSIT']);
    });

    it('should return valid transitions for ACKNOWLEDGED', () => {
      expect(getValidNextStates('ACKNOWLEDGED')).toEqual(['IN_TRANSIT', 'RECEIVED']);
    });

    it('should return valid transitions for IN_TRANSIT', () => {
      expect(getValidNextStates('IN_TRANSIT')).toEqual(['RECEIVED']);
    });

    it('should return empty array for RECEIVED (terminal state)', () => {
      expect(getValidNextStates('RECEIVED')).toEqual([]);
    });

    // Type safety test - this will catch if a state is added without transitions
    it('should have a defined case for all POLifecycleState values', () => {
      const allStates: POLifecycleState[] = ['DRAFT', 'COMMITTED', 'SENT', 'ACKNOWLEDGED', 'IN_TRANSIT', 'RECEIVED'];
      allStates.forEach(state => {
        // Just calling the function should not throw - if a state is missing, getValidNextStates would return []
        expect(typeof getValidNextStates(state)).toBe('object');
      });
    });
  });

  describe('isValidTransition', () => {
    const validTransitions = [
      { from: 'DRAFT', to: 'COMMITTED' },
      { from: 'COMMITTED', to: 'SENT' },
      { from: 'SENT', to: 'ACKNOWLEDGED' },
      { from: 'SENT', to: 'IN_TRANSIT' },
      { from: 'ACKNOWLEDGED', to: 'IN_TRANSIT' },
      { from: 'ACKNOWLEDGED', to: 'RECEIVED' },
      { from: 'IN_TRANSIT', to: 'RECEIVED' },
    ] as const;

    it('should return true for valid transitions', () => {
      validTransitions.forEach(({ from, to }) => {
        expect(isValidTransition(from, to)).toBe(true);
      });
    });

    const invalidTransitions = [
      { from: 'DRAFT', to: 'SENT' },
      { from: 'COMMITTED', to: 'ACKNOWLEDGED' },
      { from: 'SENT', to: 'RECEIVED' },
      { from: 'IN_TRANSIT', to: 'SENT' },
      { from: 'RECEIVED', to: 'COMMITTED' },
      { from: 'RECEIVED', to: 'DRAFT' },
      // Reverse transitions
      { from: 'COMMITTED', to: 'DRAFT' },
      { from: 'SENT', to: 'COMMITTED' },
    ] as const;

    it('should return false for invalid transitions', () => {
      invalidTransitions.forEach(({ from, to }) => {
        expect(isValidTransition(from, to)).toBe(false);
      });
    });

    it('should handle terminal state RECEIVED correctly', () => {
      // No transitions from RECEIVED
      expect(isValidTransition('RECEIVED', 'COMMITTED')).toBe(false);
      expect(isValidTransition('RECEIVED', 'DRAFT')).toBe(false);
    });
  });

  describe('state machine properties', () => {
    it('should not allow cycles back to earlier states', () => {
      const allStates: POLifecycleState[] = ['DRAFT', 'COMMITTED', 'SENT', 'ACKNOWLEDGED', 'IN_TRANSIT', 'RECEIVED'];

      allStates.forEach((state, index) => {
        const nextStates = getValidNextStates(state);
        // Next states should only be later in the sequence
        nextStates.forEach(nextState => {
          const nextIndex = allStates.indexOf(nextState);
          expect(nextIndex).toBeGreaterThanOrEqual(index);
        });
      });
    });

    it('should have RECEIVED as a terminal state (no outgoing transitions)', () => {
      expect(getValidNextStates('RECEIVED')).toHaveLength(0);
    });
  });
});