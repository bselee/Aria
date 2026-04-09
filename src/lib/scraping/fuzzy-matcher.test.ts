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

test('exact SKU match returns high score close to 1', () => {
  const skus: KnownProduct[] = [
    { name: 'Sharpies Black', sku: 'H-255BL' },
    { name: 'Pens Blue', sku: 'P-123' },
  ];

  const matcher = new FuzzyMatcher(skus);
  const result = matcher.match('H-255BL');
  expect(result).not.toBeNull();
  expect(result!.product.sku).toBe('H-255BL');
  expect(result!.score).toBeGreaterThan(0.9);
});

test('fuzzy description match returns best result', () => {
  const skus: KnownProduct[] = [
    { name: 'Sharpies Black Fine Point', sku: 'H-255BL', vendor: 'ULINE' },
    { name: 'Sharpies Blue Fine Point', sku: 'H-255BU', vendor: 'ULINE' },
    { name: 'Pens Blue', sku: 'P-123' },
  ];

  const matcher = new FuzzyMatcher(skus);
  const result = matcher.match('H-255BL Black Sharpies Fine Point');
  expect(result).not.toBeNull();
  expect(result!.product.sku).toBe('H-255BL');
});

test('no match returns null for unrelated description', () => {
  const skus: KnownProduct[] = [
    { name: 'Sharpies Black', sku: 'H-255BL' },
    { name: 'Pens Blue', sku: 'P-123' },
  ];

  const matcher = new FuzzyMatcher(skus);
  const result = matcher.match('random kitchen appliance');
  expect(result).toBeNull();
});

test('N/A SKU is filtered out', () => {
  const skus: KnownProduct[] = [
    { name: 'Unknown Item', sku: 'N/A' },
    { name: 'Sharpies Black', sku: 'H-255BL' },
  ];

  const matcher = new FuzzyMatcher(skus);
  const result = matcher.match('N/A');
  expect(result).toBeNull();
});

test('very short strings return null', () => {
  const skus: KnownProduct[] = [
    { name: 'Sharpies Black', sku: 'H-255BL' },
    { name: 'Pens Blue', sku: 'P-123' },
  ];

  const matcher = new FuzzyMatcher(skus);
  const result = matcher.match('ab');
  expect(result).toBeNull();
});

test('empty product list returns null', () => {
  const matcher = new FuzzyMatcher([]);
  const result = matcher.match('H-255BL');
  expect(result).toBeNull();
});

test('multiple matches returns best result', () => {
  const skus: KnownProduct[] = [
    { name: 'Sharpies Black Fine Point', sku: 'H-255BL', vendor: 'ULINE' },
    { name: 'Sharpies Blue Fine Point', sku: 'H-255BU', vendor: 'ULINE' },
    { name: 'Sharpies Red Fine Point', sku: 'H-255RD', vendor: 'ULINE' },
    { name: 'Pens Blue', sku: 'P-123' },
  ];

  const matcher = new FuzzyMatcher(skus);
  const result = matcher.match('Sharpies Black');
  expect(result).not.toBeNull();
  expect(result!.product.sku).toBe('H-255BL');
});

test('score is between 0 and 1', () => {
  const skus: KnownProduct[] = [
    { name: 'Sharpies Black', sku: 'H-255BL' },
    { name: 'Pens Blue', sku: 'P-123' },
  ];

  const matcher = new FuzzyMatcher(skus);
  const exactResult = matcher.match('H-255BL');
  expect(exactResult!.score).toBeGreaterThanOrEqual(0);
  expect(exactResult!.score).toBeLessThanOrEqual(1);

  const fuzzyResult = matcher.match('H-255BL Sharpies');
  expect(fuzzyResult!.score).toBeGreaterThanOrEqual(0);
  expect(fuzzyResult!.score).toBeLessThanOrEqual(1);

  const noResult = matcher.match('completely unrelated string with no possible match');
  expect(noResult).toBeNull();
});
