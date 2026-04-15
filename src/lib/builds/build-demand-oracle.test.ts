import { describe, expect, it } from 'vitest';
import { computeBuildDemandOracle, computeOracleStatus } from './build-demand-oracle';
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
        totalRequiredQty: 20,
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
        totalRequiredQty: 20,
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

  it('chains FG dailyRate * 7 * qtyPerFg for weeks 5-12', () => {
    // FG-001 built qty=10 → totalRequiredQty=20 means 2 units CMP per 1 unit FG
    // fgVelocity.dailyRate=2 units FG/day → 14 units FG/wk
    // weekly CMP demand = 14 * 2 = 28
    const report = makeReport({
      builds: [{
        sku: 'FG-001',
        quantity: 10,
        buildDate: new Date().toISOString(),
        originalEvent: '',
        confidence: 1,
        designation: 'SOIL' as const,
        eventId: null,
        calendarId: null,
      }],
      fgVelocity: new Map([['FG-001', {
        dailyRate: 2,
        stockOnHand: 100,
        daysOfFinishedStock: 50,
        openDemandQty: 0,
      }]]),
      components: new Map([['CMP-001', {
        componentSku: 'CMP-001',
        totalRequiredQty: 20,   // 2 CMP per FG × 10 FG = 20 total
        onHand: 100,
        onOrder: null,
        stockoutDays: null,
        demandQuantity: null,
        consumptionQuantity: null,
        leadTimeDays: 14,
        incomingPOs: [],
        usedIn: new Set(['FG-001']),
        designations: new Set<string>(),
        riskLevel: 'OK' as const,
        earliestBuildDate: new Date().toISOString(),
        hasFinaleData: true,
        vendorName: 'BioAg',
        vendorPartyId: 'p1',
      }]]),
    });
    const oracle = computeBuildDemandOracle(report);
    const comp = oracle.twelveWeekForecast[0]?.components[0];
    // dailyRate=2, qtyPerFg=20/10=2 → 2*7*2 = 28 per week
    expect(comp?.weeklyNeedW158).toBe(28);
    expect(comp?.weeklyNeedW1912).toBe(28);
  });

  describe('computeOracleStatus', () => {
    it('returns ORDER NOW when totalSupply < wk14Need', () => {
      // onHand=5, incomingPO=0, wk14Need=20 → supply=5 < 20
      expect(computeOracleStatus(5, 0, 20, 20, 20)).toBe('ORDER NOW');
    });

    it('returns REORDER SOON when wk1-4 covered but wk5-8 shortfall', () => {
      // onHand=20, incomingPO=0, wk14Need=20 (covered), wk58Need=30, wk912Need=30
      // supplyAfterWk4 = 20-20 = 0 < 30
      expect(computeOracleStatus(20, 0, 20, 30, 30)).toBe('REORDER SOON');
    });

    it('returns REORDER SOON when wk1-8 covered but wk9-12 shortfall', () => {
      // onHand=50, incomingPO=0, wk14Need=20, wk58Need=30, wk912Need=40
      // supplyAfterWk4 = 50-20 = 30 ≥ 30 ✓
      // supplyAfterWk8 = 30-30 = 0 < 40
      expect(computeOracleStatus(50, 0, 20, 30, 40)).toBe('REORDER SOON');
    });

    it('returns COVERED when supply covers through week 12', () => {
      // onHand=100, incomingPO=0, wk14Need=20, wk58Need=30, wk912Need=40
      // supplyAfterWk4 = 100-20 = 80 ≥ 30 ✓
      // supplyAfterWk8 = 80-30 = 50 ≥ 40 ✓
      expect(computeOracleStatus(100, 0, 20, 30, 40)).toBe('COVERED');
    });
  });
});
