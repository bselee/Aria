import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeadTimeService } from './lead-time-service';
import { finaleClient } from '../finale/client';
import { createClient } from '../db';

vi.mock('../finale/client', () => ({
    finaleClient: {
        getVendorLeadTimeDistribution: vi.fn(),
        getVendorLeadTimeHistory: vi.fn(),
    },
}));
vi.mock('../db', () => ({
    createClient: vi.fn(),
}));

describe('LeadTimeService.getForVendor — case-insensitive vendor median match', () => {
    it('matches a mixed-case vendor name against the cache (case-sensitivity regression)', async () => {
        const svc = new LeadTimeService();
        // Seed the median cache directly (bypass warmCache's Finale call).
        (svc as any).cache = new Map([['Rootwise Soil Dynamics', 13]]);
        (svc as any).cacheAt = Date.now();
        (svc as any).policyCache = new Map();
        (svc as any).policyCacheAt = Date.now();

        const result = await svc.getForVendor('Rootwise Soil Dynamics', 'RWBP105');
        expect(result.days).toBe(13);
        expect(result.provenance).toBe('vendor_median');
    });
});

describe('LeadTimeService.getDistribution — persisted stats fallback', () => {
    beforeEach(() => {
        vi.mocked(finaleClient.getVendorLeadTimeDistribution).mockReturnValue(new Map());
        vi.mocked(createClient).mockReturnValue(null as any);
    });

    it('returns null when in-memory empty and no DB fallback', async () => {
        const svc = new LeadTimeService();
        (svc as any).cache = new Map();
        (svc as any).cacheAt = Date.now();
        vi.mocked(createClient).mockReturnValue(null as any);
        const dist = await svc.getDistribution('Rootwise Soil Dynamics');
        expect(dist).toBeNull();
    });

    it('falls back to persisted vendor_lead_time_stats when in-memory has <5 samples', async () => {
        const svc = new LeadTimeService();
        (svc as any).cache = new Map();
        (svc as any).cacheAt = Date.now();
        // In-memory has Rootwise with n=4 (<5 → not returned from in-memory).
        vi.mocked(finaleClient.getVendorLeadTimeDistribution).mockReturnValue(
            new Map([['Rootwise Soil Dynamics', { p50: 13, p90: 18, sampleCount: 4 }]]),
        );
        // DB returns 16 samples p90=25.
        const dbStub = {
            from: () => ({
                select: () => ({
                    not: () => ({
                        gte: () => ({
                            then: (cb: any) => cb({ data: [{ vendor_name: 'Rootwise Soil Dynamics', sample_count: 16, p50_days: 17, p90_days: 25 }], error: null }),
                        }),
                    }),
                }),
            }),
        };
        vi.mocked(createClient).mockReturnValue(dbStub as any);

        const dist = await svc.getDistribution('Rootwise Soil Dynamics');
        expect(dist).not.toBeNull();
        expect(dist!.p90).toBe(25);
        expect(dist!.sampleCount).toBe(16);
    });
});
