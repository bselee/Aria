// src/lib/scraping/fuzzy-matcher.test.ts
import { FuzzyMatcher, KnownProduct } from './fuzzy-matcher';
import { expect, test } from 'vitest';

test('matches fuzzy item to SKU', () => {
  const skus: KnownProduct[] = [
    { name: 'Sharpies Black', sku: 'H-255BL', vendor: 'ULINE' },
    { name: 'Pens Blue', sku: 'P-123' },
  ];

  const matcher = new FuzzyMatcher(skus);
  const result = matcher.match('H-255BL Sharpies');
  expect(result?.product.sku).toBe('H-255BL');
  expect(result?.score).toBeGreaterThan(0.6);
});

test('returns null for no match', () => {
  const skus: KnownProduct[] = [
    { name: 'Sharpies Black', sku: 'H-255BL' },
  ];

  const matcher = new FuzzyMatcher(skus);
  const result = matcher.match(' unmatched item');
  expect(result).toBe(null);
});