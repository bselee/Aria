import { describe, it, expect } from 'vitest';
import { computeComponentBurnRates, classifyUrgency, mergeIntoGroups } from './bom-demand';

describe('computeComponentBurnRates', () => {
    it('sums burn rate across multiple FGs sharing a component', () => {
        const fgVelocities = [
            { sku: 'LIGHT-MIX', name: 'Light Mix', dailySalesRate: 10, bom: [{ componentSku: 'PERLITE', quantity: 2 }, { componentSku: 'COMPOST', quantity: 5 }] },
            { sku: 'CRAFT-LITE', name: 'Craft Lite', dailySalesRate: 5, bom: [{ componentSku: 'PERLITE', quantity: 3 }] },
        ];
        const result = computeComponentBurnRates(fgVelocities);
        // PERLITE: 10*2 + 5*3 = 35/day
        expect(result.get('PERLITE')!.totalBurnRate).toBe(35);
        expect(result.get('PERLITE')!.feedsFinishedGoods).toHaveLength(2);
        // COMPOST: 10*5 = 50/day
        expect(result.get('COMPOST')!.totalBurnRate).toBe(50);
        expect(result.get('COMPOST')!.feedsFinishedGoods).toHaveLength(1);
    });

    it('captures qtyPerUnit per FG so callers can compute buildsWorth themselves', () => {
        const fgVelocities = [
            { sku: 'LIGHT-MIX', name: 'Light Mix', dailySalesRate: 10, bom: [{ componentSku: 'PERLITE', quantity: 2 }] },
            { sku: 'CRAFT-LITE', name: 'Craft Lite', dailySalesRate: 5, bom: [{ componentSku: 'PERLITE', quantity: 3 }] },
        ];
        const result = computeComponentBurnRates(fgVelocities);
        const perlite = result.get('PERLITE')!;
        const byFg = new Map(perlite.feedsFinishedGoods.map(fg => [fg.sku, fg.qtyPerUnit]));
        expect(byFg.get('LIGHT-MIX')).toBe(2);
        expect(byFg.get('CRAFT-LITE')).toBe(3);
    });
});

describe('classifyUrgency', () => {
    it('returns critical when runway < lead time', () => {
        expect(classifyUrgency(10, 14)).toBe('critical');
    });
    it('returns warning when runway < lead time + 30', () => {
        expect(classifyUrgency(30, 14)).toBe('warning');
    });
    it('returns watch when runway < lead time + 60', () => {
        expect(classifyUrgency(60, 14)).toBe('watch');
    });
    it('returns ok when runway >= lead time + 60', () => {
        expect(classifyUrgency(90, 14)).toBe('ok');
    });
});

describe('mergeIntoGroups', () => {
    it('merges BOM items into existing vendor group', () => {
        const resaleGroups = [{
            vendorName: 'Acme Corp', vendorPartyId: 'p1', urgency: 'ok' as const,
            items: [{ productId: 'WIDGET', supplierPartyId: 'p1', itemType: 'resale' as const } as any],
        }];
        const bomGroups = [{
            vendorName: 'Acme Corp', vendorPartyId: 'p1', urgency: 'critical' as const,
            items: [{ productId: 'PERLITE', supplierPartyId: 'p1', itemType: 'bom-component' as const } as any],
        }];
        const merged = mergeIntoGroups(resaleGroups, bomGroups);
        expect(merged).toHaveLength(1);
        expect(merged[0].items).toHaveLength(2);
        // Worst urgency wins
        expect(merged[0].urgency).toBe('critical');
    });

    it('keeps vendor groups separate when different vendors', () => {
        const resaleGroups = [{ vendorName: 'A', vendorPartyId: 'p1', urgency: 'ok' as const, items: [] }];
        const bomGroups = [{ vendorName: 'B', vendorPartyId: 'p2', urgency: 'warning' as const, items: [] }];
        const merged = mergeIntoGroups(resaleGroups, bomGroups);
        expect(merged).toHaveLength(2);
    });

    it('sorts merged groups worst-urgency-first then alphabetically', () => {
        const merged = mergeIntoGroups(
            [
                { vendorName: 'Zeta', vendorPartyId: 'pZ', urgency: 'critical' as const, items: [] },
                { vendorName: 'Alpha', vendorPartyId: 'pA', urgency: 'ok' as const, items: [] },
            ],
            [
                { vendorName: 'Beta', vendorPartyId: 'pB', urgency: 'critical' as const, items: [] },
            ],
        );
        expect(merged.map(g => g.vendorName)).toEqual(['Beta', 'Zeta', 'Alpha']);
    });

    it('does not mutate input groups', () => {
        const resale = [{
            vendorName: 'Acme', vendorPartyId: 'p1', urgency: 'ok' as const,
            items: [{ productId: 'WIDGET' } as any],
        }];
        const bom = [{
            vendorName: 'Acme', vendorPartyId: 'p1', urgency: 'critical' as const,
            items: [{ productId: 'PERLITE' } as any],
        }];
        mergeIntoGroups(resale, bom);
        expect(resale[0].items).toHaveLength(1);
        expect(resale[0].urgency).toBe('ok');
        expect(bom[0].items).toHaveLength(1);
    });

    it('merges multiple BOM groups feeding the same vendor', () => {
        const merged = mergeIntoGroups(
            [],
            [
                { vendorName: 'Acme', vendorPartyId: 'p1', urgency: 'warning' as const, items: [{ productId: 'A' } as any] },
                { vendorName: 'Acme', vendorPartyId: 'p1', urgency: 'critical' as const, items: [{ productId: 'B' } as any] },
            ],
        );
        expect(merged).toHaveLength(1);
        expect(merged[0].items).toHaveLength(2);
        expect(merged[0].urgency).toBe('critical');
    });
});
