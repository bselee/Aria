import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    createClientMock,
    fromMock,
    selectMock,
    eqMock,
    maybeSingleMock,
    updateMock,
    insertMock,
    assessGroupsMock,
} = vi.hoisted(() => ({
    createClientMock: vi.fn(),
    fromMock: vi.fn(),
    selectMock: vi.fn(),
    eqMock: vi.fn(),
    maybeSingleMock: vi.fn(),
    updateMock: vi.fn(),
    insertMock: vi.fn(),
    assessGroupsMock: vi.fn(),
}));

vi.mock('../supabase', () => ({
    createClient: createClientMock,
}));

vi.mock('./assessment-service', () => ({
    assessPurchasingGroups: assessGroupsMock,
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

        assessGroupsMock.mockReturnValue({
            groups: [{
                vendorName: 'Axiom Print',
                vendorPartyId: 'party-axiom',
                urgency: 'critical',
                items: [{
                    item: {
                        productId: 'LBL-AXIOM-01',
                        productName: 'Axiom Label 01',
                        dailyRate: 10,
                        adjustedRunwayDays: 5,
                        runwayDays: 5,
                        unitPrice: 0.25,
                        orderIncrementQty: null,
                        isBulkDelivery: false,
                    },
                    assessment: {
                        decision: 'order',
                        recommendedQty: 500,
                    },
                }],
            }],
            actionableLines: [],
            blockedLines: [],
            vendorSummaries: [],
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

    it('does not queue held or manual-review lines', async () => {
        assessGroupsMock.mockReturnValue({
            groups: [{
                vendorName: 'Axiom Print',
                vendorPartyId: 'party-axiom',
                urgency: 'warning',
                items: [{
                    item: {
                        productId: 'LBL-HOLD-01',
                        productName: 'Held Label',
                        dailyRate: 1,
                        adjustedRunwayDays: 45,
                        runwayDays: 45,
                        unitPrice: 0.5,
                        orderIncrementQty: null,
                        isBulkDelivery: false,
                    },
                    assessment: {
                        decision: 'hold',
                        recommendedQty: 0,
                    },
                }],
            }],
            actionableLines: [],
            blockedLines: [],
            vendorSummaries: [],
        });

        const mockFinale = {
            getPurchasingIntelligence: vi.fn().mockResolvedValue([
                {
                    vendorName: 'Axiom Print',
                    items: [],
                },
            ]),
        };

        const result = await scanAxiomDemand(mockFinale as any);

        expect(result.queuedCount).toBe(0);
        expect(insertMock).not.toHaveBeenCalled();
    });
});
