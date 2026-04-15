import { describe, expect, it } from 'vitest';
import { computeBuildDemandOracle } from './build-demand-oracle';
import type { BuildRiskReport } from './build-risk';

const makeReport = (overrides: Partial<BuildRiskReport> = {}): BuildRiskReport => ({
  runsOn: new Date().toISOString(),
  asOf: new Date().toISOString(),
  builds: [],
  components: new Map(),
  fgVelocity: new Map(),
  ...overrides,
} as BuildRiskReport);

describe('build-demand-oracle', () => {
  it('uses ComponentDemand.vendorName for oracle grouping', () => {
    const report = makeReport({
      components: new Map([['CMP-001', {
        componentSku: 'CMP-001',
        totalRequiredQty: 20,    // onHand=10 < need=20 → orderQty>0 → in ordersNeededNow
        onHand: 10,
        onOrder: null,
        stockoutDays: null,
        demandQuantity: null,
        consumptionQuantity: null,
        leadTimeDays: 14,
        incomingPOs: [],
        usedIn: new Set<string>(),
        designations: new Set<string>(),
        riskLevel: 'WARNING' as const,
        earliestBuildDate: new Date().toISOString(),
        hasFinaleData: true,
        vendorName: 'BioAg',
        vendorPartyId: 'party-123',
      }]]),
    });
    const oracle = computeBuildDemandOracle(report);
    expect(oracle.ordersNeededNow[0]?.vendorName).toBe('BioAg');
    expect(oracle.ordersNeededNow[0]?.vendorPartyId).toBe('party-123');
  });

  it('falls back to Unknown Vendor for null vendorName', () => {
    const report = makeReport({
      components: new Map([['UNKNOWN-SKU', {
        componentSku: 'UNKNOWN-SKU',
        totalRequiredQty: 20,    // onHand=5 < need=20 → orderQty>0 → in ordersNeededNow
        onHand: 5,
        onOrder: null,
        stockoutDays: null,
        demandQuantity: null,
        consumptionQuantity: null,
        leadTimeDays: 14,
        incomingPOs: [],
        usedIn: new Set<string>(),
        designations: new Set<string>(),
        riskLevel: 'CRITICAL' as const,
        earliestBuildDate: new Date().toISOString(),
        hasFinaleData: true,
        vendorName: null,
        vendorPartyId: null,
      }]]),
    });
    const oracle = computeBuildDemandOracle(report);
    expect(oracle.ordersNeededNow[0]?.vendorName).toBe('Unknown Vendor');
    expect(oracle.ordersNeededNow[0]?.vendorPartyId).toBe(null);
  });
});
