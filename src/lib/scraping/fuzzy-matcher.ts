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
      threshold: 0.4,
      includeScore: true,
      minMatchCharLength: 3,
    });
  }

  match(description: string): { sku: string; score: number } | null {
    const results = this.fuse.search(description);
    if (results.length === 0) return null;
    const best = results[0];
    const sku = best.item.sku;
    if (sku === 'N/A') return null;
    return { sku, score: best.score ? 1 - best.score : 1 };
  }
}