import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClientMock, fromMock, selectMock, eqMock, maybeSingleMock, updateMock, insertMock } = vi.hoisted(() => ({
    createClientMock: vi.fn(),
    fromMock: vi.fn(),
    selectMock: vi.fn(),
    eqMock: vi.fn(),
    maybeSingleMock: vi.fn(),
    updateMock: vi.fn(),
    insertMock: vi.fn(),
}));

vi.mock('../supabase', () => ({
    createClient: createClientMock,
}));

import { scanAxiomDemand } from './axiom-scanner';

describe('scanAxiomDemand', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        selectMock.mockReturnThis();
        eqMock.mockReturnThis();
        maybeSingleMock.mockResolvedValue({ data: null });
        updateMock.mockReturnThis();
        insertMock.mockResolvedValue({ error: null });

        fromMock.mockReturnValue({
            select: selectMock,
            eq: eqMock,
            maybeSingle: maybeSingleMock,
            update: updateMock,
            insert: insertMock,
        });

        createClientMock.mockReturnValue({
            from: fromMock,
        });
    });

    it('queues Axiom SKUs below threshold', async () => {
        const mockFinale = {
            getPurchasingIntelligence: vi.fn().mockResolvedValue([
                {
                    vendorName: 'Axiom Print',
                    items: [
                        {
                            productId: 'LBL-AXIOM-01',
                            productName: 'Axiom Label 01',
                            urgency: 'critical',
                            suggestedQty: 500,
                            dailyRate: 10,
                            adjustedRunwayDays: 5,
                            runwayDays: 5,
                        },
                    ],
                },
            ]),
        };

        const result = await scanAxiomDemand(mockFinale as any);

        expect(result.queuedCount).toBe(1);
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            sku: 'LBL-AXIOM-01',
            status: 'pending',
        }));
    });
});
