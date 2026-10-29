/**
 * @file carton-pooling.ts
 * @purpose One physical carton, many vendor SKUs. Pool on-hand by size before
 *          deciding to buy, so the dashboard and the Friday report agree.
 *
 *          Uline lists a carton as `S-`, SP USA lists the same carton as `SP-`,
 *          and our build lists it as `BOX1xx`. Judged SKU by SKU the board sees
 *          "0 on hand, order 1,500" while the same size sits on another shelf.
 *          Verified 2026-10-22: ULS455 (30x15x15) read 0 on hand and drove a
 *          1,500-unit order, but S-4412 held 310 and BOX118 held 45.
 *
 * @author  Hermia
 * @created 2026-10-22
 * @deps    none at runtime (types only) — the caller supplies names and stock
 */

import type { PurchasingGroup, PurchasingItem } from "../finale/client";

/**
 * Canonical dimension key for a carton, so the same size sold under different
 * SKUs pools together.
 *
 * `30"x15"x15"`, `15"x15"x30"` and `(30 x 15 x 15)` all normalize to `15x15x30`.
 * Dimensions are sorted ascending so orientation never splits a group.
 * Returns null for anything that is not a box/corrugated item.
 *
 * @param name Product name from Finale (or the SKU cache).
 * @returns Canonical `aXbXc` key, or null.
 */
export function boxDimKey(name: string | null | undefined): string | null {
  const n = String(name || "");
  if (!/box|corrugat/i.test(n)) return null;
  const m = n.match(
    /(\d+(?:\.\d+)?)\s*["']?\s*[xX]\s*(\d+(?:\.\d+)?)\s*["']?\s*[xX]\s*(\d+(?:\.\d+)?)/
  );
  if (!m) return null;
  const dims = [m[1], m[2], m[3]].map((d) => Number(d));
  if (dims.some((d) => !Number.isFinite(d) || d <= 0)) return null;
  return dims.sort((a, b) => a - b).join("x");
}

/** A SKU and the product name used to derive its carton size. */
export type CartonName = { sku: string; name: string | null };

export type CartonPoolDeps = {
  /** Every carton SKU we know about, used to find same-size siblings. */
  cartonNames: CartonName[];
  /** Live on-hand for a SKU that is not present in the groups. */
  stockFor: (sku: string) => Promise<number | null>;
};

/** Evidence of what a pooled size looked like. Useful for logs and tests. */
export type CartonPoolResult = {
  dimKey: string;
  skus: string[];
  onHand: number;
  dailyRate: number;
  runwayDays: number;
  /** True when the pooled size covers its lead time, so nothing is ordered. */
  covered: boolean;
};

export type CartonPoolOutcome = {
  groups: PurchasingGroup[];
  pooled: CartonPoolResult[];
};

/**
 * Recompute runway for every carton against pooled on-hand for its size.
 *
 * A size that covers its lead time gets `suggestedQty: 0` and `urgency: 'ok'`
 * on every SKU of that size, so no vendor is re-ordered for a carton we hold.
 * A size that is genuinely short keeps its quantity and simply carries the
 * pooled runway.
 *
 * Non-carton items are returned untouched.
 *
 * @param groups Purchasing groups from the scan (resale or BOM).
 * @param deps   Carton name index and a live stock resolver for siblings.
 * @returns New groups plus one entry per pooled carton size.
 */
export async function poolCartonGroups(
  groups: PurchasingGroup[],
  deps: CartonPoolDeps
): Promise<CartonPoolOutcome> {
  if (!Array.isArray(groups) || groups.length === 0) {
    return { groups, pooled: [] };
  }

  // Dimension key -> every SKU known to be that carton.
  const membersByDim = new Map<string, string[]>();
  const nameBySku = new Map<string, string>();
  for (const { sku, name } of deps.cartonNames) {
    if (!sku) continue;
    if (name) nameBySku.set(sku, name);
    const key = boxDimKey(name);
    if (!key) continue;
    const arr = membersByDim.get(key);
    if (arr) arr.push(sku);
    else membersByDim.set(key, [sku]);
  }

  // SKU -> the item instance(s) present in these groups.
  const itemsBySku = new Map<string, PurchasingItem[]>();
  const dimItems = new Map<string, string[]>();

  for (const group of groups) {
    for (const item of group.items ?? []) {
      const sku = String(item.productId || "");
      if (!sku) continue;
      const existing = itemsBySku.get(sku);
      if (existing) existing.push(item);
      else itemsBySku.set(sku, [item]);

      const key = boxDimKey(item.productName) || boxDimKey(nameBySku.get(sku));
      if (!key) continue;
      const list = dimItems.get(key);
      if (list) {
        if (!list.includes(sku)) list.push(sku);
      } else {
        dimItems.set(key, [sku]);
      }
    }
  }

  if (dimItems.size === 0) return { groups, pooled: [] };

  const pooled: CartonPoolResult[] = [];
  // SKU -> replacement item, applied once at the end.
  const replacements = new Map<PurchasingItem, PurchasingItem>();

  for (const [dimKey, presentSkus] of dimItems) {
    const skus = Array.from(
      new Set([...presentSkus, ...(membersByDim.get(dimKey) ?? [])])
    );

    let onHand = 0;
    for (const sku of skus) {
      const items = itemsBySku.get(sku);
      if (items && items.length > 0) {
        onHand += Number(items[0].stockOnHand) || 0;
        continue;
      }
      try {
        onHand += (await deps.stockFor(sku)) || 0;
      } catch {
        // One vendor unavailable must not invalidate the rest of the size.
      }
    }

    // Pooled supply against pooled demand: two SKUs of one carton are two
    // consumption ledgers for the same physical stock.
    let dailyRate = 0;
    for (const sku of presentSkus) {
      for (const item of itemsBySku.get(sku) ?? []) {
        const r = Number(item.dailyRate) || 0;
        if (r > 0) dailyRate += r;
      }
    }
    if (dailyRate <= 0) continue;

    const runwayDays = onHand / dailyRate;
    let coveredAny = false;

    for (const sku of presentSkus) {
      for (const item of itemsBySku.get(sku) ?? []) {
        const lead = Number(
          item.effectiveLeadTimeDays ?? item.leadTimeDays ?? 21
        );
        const leadDays = Number.isFinite(lead) && lead > 0 ? lead : 21;
        const covered = runwayDays >= leadDays;
        if (covered) coveredAny = true;

        const note = `Pooled ${onHand.toLocaleString("en-US")} on hand across ${skus.length} SKUs of ${dimKey}${
          covered ? " — covers lead time, do not reorder." : "."
        }`;

        replacements.set(item, {
          ...item,
          adjustedRunwayDays: runwayDays,
          pooledOnHand: onHand,
          pooledDimKey: dimKey,
          ...(covered
            ? {
                suggestedQty: 0,
                urgency: "ok" as const,
                explanation: [item.explanation, note].filter(Boolean).join(" "),
              }
            : {}),
        });
      }
    }

    pooled.push({
      dimKey,
      skus,
      onHand,
      dailyRate,
      runwayDays,
      covered: coveredAny,
    });
  }

  if (replacements.size === 0) return { groups, pooled };

  const next = groups.map((group) => ({
    ...group,
    items: (group.items ?? []).map((item) => replacements.get(item) ?? item),
  }));

  return { groups: next, pooled };
}
