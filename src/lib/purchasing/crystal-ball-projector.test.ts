import { describe, it, expect } from 'vitest';
import { computeProjections } from './crystal-ball-projector';

describe('crystal-ball-projector computeProjections', () => {
    it('should return correct projection values when stock is fully positive and no stockout happens', () => {
        const input = {
            stockOnHand: 1000,
            stockOnOrder: 0,
            dailyRate: 2,
            leadTimeDays: 14,
            openPOs: []
        };
        
        const res = computeProjections(input);
        expect(res).toHaveLength(7);
        
        // 10 days out projection: 1000 - (10 * 2) = 980
        const p10 = res.find(p => p.daysOut === 10);
        expect(p10?.projectedStock).toBe(980);
        expect(p10?.consumed).toBe(20);
        expect(p10?.needsOrder).toBe(false);
        expect(p10?.orderByDate).toBeNull();
    });

    it('should handle zero daily rate velocity without dividing by zero', () => {
        const input = {
            stockOnHand: 50,
            stockOnOrder: 0,
            dailyRate: 0,
            leadTimeDays: 14,
            openPOs: []
        };
        
        const res = computeProjections(input);
        expect(res.every(p => p.projectedStock === 50)).toBe(true);
        expect(res.every(p => !p.needsOrder)).toBe(true);
        expect(res.every(p => p.orderByDate === null)).toBe(true);
    });

    it('should detect a deficit and compute an order-by date correctly', () => {
        // Stock on hand 100, burns at 10/day -> stockout in 10 days.
        // Lead time is 14 days -> order date should be 4 days in the past (today - 4 days).
        const input = {
            stockOnHand: 100,
            stockOnOrder: 0,
            dailyRate: 10,
            leadTimeDays: 14,
            openPOs: []
        };
        
        const res = computeProjections(input);
        
        // At day 30, we have deficit.
        const p30 = res.find(p => p.daysOut === 30);
        expect(p30?.needsOrder).toBe(true);
        expect(p30?.orderByDate).toBeDefined();
        
        if (p30?.orderByDate) {
            const expectedDate = new Date();
            expectedDate.setDate(expectedDate.getDate() + (10 - 14)); // Stockout day 10 - 14d lead time = -4d
            const expectedStr = expectedDate.toISOString().split('T')[0];
            expect(p30.orderByDate).toBe(expectedStr);
        }
    });

    it('should credit incoming POs only after their expected arrival date', () => {
        const today = new Date();
        const poArrivalDate = new Date(today);
        poArrivalDate.setDate(poArrivalDate.getDate() + 20); // Arrives in 20 days
        
        const input = {
            stockOnHand: 100,
            stockOnOrder: 500,
            dailyRate: 5,
            leadTimeDays: 10,
            openPOs: [
                {
                    orderId: 'PO-TEST',
                    quantity: 500,
                    orderDate: today.toISOString(),
                    expectedDate: poArrivalDate.toISOString()
                }
            ]
        };
        
        const res = computeProjections(input);
        
        // At day 10, PO has not arrived yet. Stock = 100 - (10 * 5) = 50.
        const p10 = res.find(p => p.daysOut === 10);
        expect(p10?.projectedStock).toBe(50);
        expect(p10?.incoming).toBe(0);
        
        // At day 30, PO has arrived. Stock = 100 + 500 - (30 * 5) = 450.
        const p30 = res.find(p => p.daysOut === 30);
        expect(p30?.projectedStock).toBe(450);
        expect(p30?.incoming).toBe(500);
    });
});
