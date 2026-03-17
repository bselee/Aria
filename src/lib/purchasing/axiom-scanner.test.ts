import { scanAxiomDemand } from './axiom-scanner';
import { createClient } from '../supabase';

jest.mock('../supabase', () => ({
    createClient: jest.fn()
}));

const mockSupabaseQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null }),
    update: jest.fn().mockReturnThis(),
    insert: jest.fn().mockResolvedValue({ error: null })
};

describe('scanAxiomDemand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (createClient as jest.Mock).mockReturnValue({
            from: jest.fn().mockReturnValue(mockSupabaseQuery)
        });
    });

    it('should identify Axiom SKUs below threshold and queue them', async () => {
        const mockFinale = {
            getPurchasingIntelligence: jest.fn().mockResolvedValue([
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
                            runwayDays: 5
                        }
                    ]
                }
            ])
        };

        const result = await scanAxiomDemand(mockFinale as any);
        expect(result.queuedCount).toBe(1);
        expect(mockSupabaseQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
            sku: 'LBL-AXIOM-01',
            status: 'pending'
        }));
    });
});
