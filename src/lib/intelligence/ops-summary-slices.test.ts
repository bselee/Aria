import { describe, expect, it } from 'vitest';

import {
    buildDailyFinaleSlices,
    filterFinaleActivityByDate,
} from './ops-summary-slices';

describe('filterFinaleActivityByDate', () => {
    it('filters records to the requested receiveDate', () => {
        const rows = [
            { orderId: '124424', receiveDate: '2026-03-27T10:00:00Z', supplier: 'Colorado Worm Company' },
            { orderId: '124423', receiveDate: '2026-03-26T10:00:00Z', supplier: 'Miles Filippelli' },
        ];

        const filtered = filterFinaleActivityByDate(rows, 'receiveDate', '2026-03-27');

        expect(filtered).toEqual([rows[0]]);
    });

    it('filters records to the requested orderDate', () => {
        const rows = [
            { orderId: '124547', orderDate: '2026-03-27', supplier: 'Coats Agri-Aloe' },
            { orderId: '124524', orderDate: '2026-03-26', supplier: 'Left Coast Garden Wholesale' },
        ];

        const filtered = filterFinaleActivityByDate(rows, 'orderDate', '2026-03-27');

        expect(filtered).toEqual([rows[0]]);
    });
});

describe('buildDailyFinaleSlices', () => {
    it('keeps week-to-date arrays and derives yesterday-only slices', () => {
        const receivings = [
            { orderId: '124424', receiveDate: '2026-03-27', supplier: 'Colorado Worm Company' },
            { orderId: '124423', receiveDate: '2026-03-26', supplier: 'Miles Filippelli' },
        ];
        const committed = [
            { orderId: '124547', orderDate: '2026-03-27', supplier: 'Coats Agri-Aloe' },
            { orderId: '124524', orderDate: '2026-03-26', supplier: 'Left Coast Garden Wholesale' },
        ];

        const result = buildDailyFinaleSlices({
            finaleReceivingsWtd: receivings,
            finaleCommittedWtd: committed,
            yesterdayIsoDate: '2026-03-27',
        });

        expect(result.finale_receivings_wtd).toEqual(receivings);
        expect(result.finale_receivings_yesterday).toEqual([receivings[0]]);
        expect(result.finale_committed_wtd).toEqual(committed);
        expect(result.finale_committed_yesterday).toEqual([committed[0]]);
    });
});
