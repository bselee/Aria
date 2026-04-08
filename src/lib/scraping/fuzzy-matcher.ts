import Fuse from 'fuse.js';

export interface KnownProduct {
  name: string;
  sku: string;
  vendor?: string;
  lastOrdered?: string;
}

export class FuzzyMatcher {
  private fuse: Fuse<KnownProduct>;

  constructor(private skus: KnownProduct[]) {
    this.fuse = new Fuse(skus, {
      keys: ['name', 'sku'],
      threshold: 0.6,
      includeScore: true,
      minMatchCharLength: 3,
    });
  }

  match(description: string): { product: KnownProduct; score: number } | null {
    const results = this.fuse.search(description);
    if (results.length === 0) return null;
    const best = results[0];
    const sku = best.item.sku;
    if (sku === 'N/A') return null;
    return { product: best.item, score: best.score ? 1 - best.score : 1 };
  }
}