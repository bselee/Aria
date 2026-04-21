import { describe, it, expect } from 'vitest';
import {
    type UlineDemandItem,
    mergeUlineDemand,
    ulineDemandToOrderingInput,
} from './uline-demand';

describe('UlineDemandItem', () => {
    it('has required fields', () => {
        const item: UlineDemandItem = {
            sku: 'S-4092',
            description: 'Poly Mailer 10x13',
            requiredQty: 100,
            contributingSources: ['finale'],
        };
        expect(item.sku).toBe('S-4092');
        expect(item.requiredQty).toBe(100);
        expect(item.contributingSources).toContain('finale');
    });
});

describe('mergeUlineDemand', () => {
    it('returns empty manifest for empty input', () => {
        const result = mergeUlineDemand([]);
        expect(result.items).toHaveLength(0);
        expect(result.source).toBe('finale');
    });

    it('single source preserved as-is', () => {
        const demands: UlineDemandItem[] = [
            { sku: 'S-4092', description: 'Poly Mailer', requiredQty: 50, contributingSources: ['finale'] },
        ];
        const result = mergeUlineDemand(demands);
        expect(result.items).toHaveLength(1);
        expect(result.source).toBe('finale');
        expect(result.items[0].requiredQty).toBe(50);
    });

    it('same SKU from same source sums quantities', () => {
        const demands: UlineDemandItem[] = [
            { sku: 'S-4092', description: 'Poly Mailer', requiredQty: 25, contributingSources: ['finale'] },
            { sku: 'S-4092', description: 'Poly Mailer', requiredQty: 25, contributingSources: ['finale'] },
        ];
        const result = mergeUlineDemand(demands);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].requiredQty).toBe(50);
        expect(result.items[0].contributingSources).toEqual(['finale']);
    });

    it('same SKU from different sources merges sources', () => {
        const demands: UlineDemandItem[] = [
            { sku: 'S-4092', description: 'Poly Mailer', requiredQty: 25, contributingSources: ['finale'] },
            { sku: 'S-4092', description: 'Poly Mailer', requiredQty: 10, contributingSources: ['requests'] },
        ];
        const result = mergeUlineDemand(demands);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].requiredQty).toBe(35);
        expect(result.items[0].contributingSources).toContain('finale');
        expect(result.items[0].contributingSources).toContain('requests');
        expect(result.source).toBe('merged');
    });

    it('different SKUs remain separate', () => {
        const demands: UlineDemandItem[] = [
            { sku: 'S-4092', description: 'Poly Mailer', requiredQty: 25, contributingSources: ['finale'] },
            { sku: 'S-4551', description: 'Bubble Wrap', requiredQty: 10, contributingSources: ['basauto'] },
        ];
        const result = mergeUlineDemand(demands);
        expect(result.items).toHaveLength(2);
        expect(result.source).toBe('merged');
    });

    it('basauto and requests merge correctly', () => {
        const demands: UlineDemandItem[] = [
            { sku: 'S-4092', description: 'Poly Mailer', requiredQty: 5, contributingSources: ['basauto'] },
            { sku: 'S-4092', description: 'Poly Mailer', requiredQty: 3, contributingSources: ['requests'] },
            { sku: 'S-4092', description: 'Poly Mailer', requiredQty: 2, contributingSources: ['finale'] },
        ];
        const result = mergeUlineDemand(demands);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].requiredQty).toBe(10);
        expect(result.items[0].contributingSources).toContain('basauto');
        expect(result.items[0].contributingSources).toContain('requests');
        expect(result.items[0].contributingSources).toContain('finale');
        expect(result.items[0].contributingSources).toHaveLength(3);
    });
});

describe('ulineDemandToOrderingInput', () => {
    it('converts manifest items to ordering input', () => {
        const demands: UlineDemandItem[] = [
            { sku: 'S-4092', description: 'Poly Mailer 10x13', requiredQty: 100, contributingSources: ['finale'] },
            { sku: 'S-4551', description: 'Bubble Wrap 12x12', requiredQty: 50, contributingSources: ['requests'] },
        ];
        const manifest = mergeUlineDemand(demands);
        const input = ulineDemandToOrderingInput(manifest);

        expect(input).toHaveLength(2);
        expect(input[0]).toEqual({
            finaleSku: 'S-4092',
            finaleEachQuantity: 100,
            description: 'Poly Mailer 10x13',
        });
        expect(input[1]).toEqual({
            finaleSku: 'S-4551',
            finaleEachQuantity: 50,
            description: 'Bubble Wrap 12x12',
        });
    });

    it('empty manifest returns empty array', () => {
        const manifest = mergeUlineDemand([]);
        const input = ulineDemandToOrderingInput(manifest);
        expect(input).toHaveLength(0);
    });
});
