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
});
