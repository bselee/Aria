# Purchasing Data Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix case multiplier handling for Teraganix-style vendors and correct PO remaining-quantity calculation so "on order" reflects actual open demand.

**Architecture:** Two independent fixes in `src/lib/finale/client.ts` plus a new Supabase table. No new services or external API changes.

**Tech Stack:** Supabase, GraphQL (Finale), TypeScript

---

## Fix 1 — Case Multiplier Handling

### Task 1: Create Supabase migration for `vendor_case_multipliers`

**Files:**
- Create: `supabase/migrations/20260415_create_vendor_case_multipliers.sql`

**Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS vendor_case_multipliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_pattern TEXT NOT NULL,
  sku_pattern TEXT,                    -- null = applies to all SKUs from vendor
  multiplier NUMERIC NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vcm_vendor_sku 
  ON vendor_case_multipliers(vendor_pattern, COALESCE(sku_pattern, ''));
```

**Step 2: Run the migration**

```bash
node _run_migration.js supabase/migrations/20260415_create_vendor_case_multipliers.sql
```

**Step 3: Seed Teraganix data**

```sql
INSERT INTO vendor_case_multipliers (vendor_pattern, sku_pattern, multiplier, notes)
VALUES 
  ('teraganix', 'EM102', 12, 'EM-1 32oz case of 12'),
  ('teraganix', 'EM108', 12, 'EM-1 16oz case of 12'),
  ('teraganix', 'EM103', 4,  'EM-1 1 gallon case of 4'),
  ('teraganix', 'EM105', 1,  'EM-1 5 gallon each')
ON CONFLICT DO NOTHING;
```

**Step 4: Commit**

```bash
git add supabase/migrations/20260415_create_vendor_case_multipliers.sql
git commit -m "feat: add vendor_case_multipliers table for case-unit conversion"
```

---

### Task 2: Add multiplier lookup to purchasing pipeline

**Files:**
- Modify: `src/lib/finale/client.ts`
- Test: Create inline test in `src/lib/finale/client.test.ts`

**Step 1: Add a `getCaseMultiplier(sku, vendorName)` helper near the top of the file**

```typescript
async getCaseMultiplier(supabase: any, sku: string, vendorName: string): Promise<number> {
    if (!supabase) return 1;
    const vendorLower = vendorName.toLowerCase();
    const { data } = await supabase
        .from('vendor_case_multipliers')
        .select('multiplier')
        .or(`vendor_pattern.ilike.%${vendorLower}%,vendor_pattern.ilike.%${vendorLower.split(' ')[0]}%`)
        .or(`sku_pattern.eq.${sku},sku_pattern.is.null`)
        .order('sku_pattern', { ascending: false })  -- null (wildcard) last
        .limit(1);
    if (data?.length) return Number(data[0].multiplier) || 1;
    return 1;
}
```

**Step 2: Find `buildPurchasingCandidate()` and add multiplier to `suggestedQty`**

Locate where `suggestedQty` is computed (search for `snapToIncrement` in the file). After the `suggestedQty` line:
```typescript
const caseMultiplier = await this.getCaseMultiplier(supabase, sku, vendorName);
const finalSuggestedQty = caseMultiplier > 1 
    ? Math.ceil(suggestedQty * caseMultiplier) 
    : suggestedQty;
```
Replace references to `suggestedQty` in the return object with `finalSuggestedQty`.

**Step 3: Write a test**

```typescript
describe('getCaseMultiplier', () => {
    it('returns multiplier from vendor_case_multipliers for matching SKU', async () => {
        const supabase = createMockSupabase([
            { vendor_pattern: 'teraganix', sku_pattern: 'EM102', multiplier: 12 }
        ]);
        const client = new FinaleClient();
        const result = await client.getCaseMultiplier(supabase, 'EM102', 'Teraganix');
        expect(result).toBe(12);
    });
    it('returns 1 when no match', async () => {
        const client = new FinaleClient();
        const result = await client.getCaseMultiplier(null, 'SKU123', 'Unknown');
        expect(result).toBe(1);
    });
});
```

**Step 4: Commit**

```bash
git add src/lib/finale/client.ts
git commit -m "feat: apply case multiplier to suggestedQty in purchasing intelligence"
```

---

## Fix 2 — PO Remaining Quantity

### Task 3: Add `shipmentList` to `getProductActivity()` GraphQL query

**Files:**
- Modify: `src/lib/finale/client.ts` lines ~4310-4378
- Test: Add test in `src/lib/finale/client.test.ts`

**Step 1: Update the `committedPOs` GraphQL query**

In the `getProductActivity()` GraphQL query (find the `committedPOs: orderViewConnection` block), add `shipmentList`:
```graphql
committedPOs: orderViewConnection(
    first: 20
    type: ["PURCHASE_ORDER"]
    product: ["${productUrl}"]
    sort: [{ field: "orderDate", mode: "desc" }]
) {
    edges { node {
        orderId status orderDate
        itemList(first: 20) {
            edges { node { product { productId } quantity } }
        }
        shipmentList(first: 50) {           -- ADD THIS
            edges { node { shipmentId receiveDate } }
        }
    }}
}
```

**Step 2: Update the openPOs loop to use remainingQty**

Change lines 4364-4378 from:
```typescript
const openPOs: Array<{ orderId: string; quantity: number; orderDate: string }> = [];
for (const edge of data?.committedPOs?.edges || []) {
    const po = edge.node;
    if (po.status !== 'Committed' && po.status !== 'Locked') continue;
    for (const ie of po.itemList?.edges || []) {
        if (ie.node.product?.productId === sku) {
            openPOs.push({
                orderId: po.orderId,
                quantity: parseFinaleNumber(ie.node.quantity),
                orderDate: po.orderDate || '',
            });
            break;
        }
    }
}
```
To:
```typescript
const openPOs: Array<{ orderId: string; quantity: number; orderDate: string }> = [];
for (const edge of data?.committedPOs?.edges || []) {
    const po = edge.node;
    if (po.status !== 'Committed' && po.status !== 'Locked') continue;
    for (const ie of po.itemList?.edges || []) {
        if (ie.node.product?.productId === sku) {
            const originalQty = parseFinaleNumber(ie.node.quantity);
            // Sum received qty from shipmentList entries with receiveDate
            const receivedQty = (po.shipmentList?.edges || [])
                .filter((s: any) => s.node.receiveDate)
                .reduce((sum: number, s: any) => sum + parseFinaleNumber(s.node.quantity || 0), 0);
            const remainingQty = originalQty - receivedQty;
            if (remainingQty <= 0) break;  // skip fully-received POs
            openPOs.push({
                orderId: po.orderId,
                quantity: remainingQty,
                orderDate: po.orderDate || '',
            });
            break;
        }
    }
}
```

**Step 3: Write a test**

```typescript
describe('getProductActivity remainingQty', () => {
    it('subtracts received qty from open PO quantity', async () => {
        // Mock GraphQL response with partially-received PO
        const mockData = {
            committedPOs: {
                edges: [{
                    node: {
                        orderId: '124624',
                        status: 'Committed',
                        orderDate: '2026-01-01',
                        itemList: { edges: [{ node: { product: { productId: 'SKU123' }, quantity: 100 } }] },
                        shipmentList: { edges: [{ node: { shipmentId: 'S1', receiveDate: '2026-01-15', quantity: 80 } }] }
                    }
                }]
            }
        };
        // Verify remainingQty = 100 - 80 = 20
    });
});
```

**Step 4: Commit**

```bash
git add src/lib/finale/client.ts
git commit -m "fix: subtract received qty from PO quantityOnOrder"
```

---

### Task 4: Update `findCommittedPOsForProduct()` with same shipmentList logic

**Files:**
- Modify: `src/lib/finale/client.ts` lines ~1323-1380

**Step 1: Update the GraphQL query in `findCommittedPOsForProduct()`**

Add `shipmentList` to the `orderViewConnection` node:
```graphql
itemList(first: 100) {
    edges { node { product { productId } quantity } }
}
shipmentList(first: 50) {              -- ADD
    edges { node { shipmentId receiveDate quantity } }
}
```

**Step 2: Update the map function (line ~1368-1375)**

Change from `quantityOnOrder: parseFinaleNumber(matchingItem?.node.quantity)` to compute `remainingQty` from `shipmentList` the same way as Task 3.

**Step 3: Write a test**

```typescript
describe('findCommittedPOsForProduct remainingQty', () => {
    it('excludes fully-received POs', async () => {
        // Mock with PO where remainingQty = 0
        // Verify it does not appear in returned array
    });
});
```

**Step 4: Commit**

```bash
git add src/lib/finale/client.ts
git commit -m "fix: apply remainingQty logic to findCommittedPOsForProduct"
```

---

## Verification

After all tasks complete, run:
```bash
npm run typecheck:cli 2>&1 | grep -E "error TS" | head -20
pm2 restart aria-bot
```

Then manually verify in dashboard:
1. Teraganix EM102 should show `suggestedQty × 12`
2. PO 124624 should show only its remaining unreceived quantity
3. Any partially-received PO should reduce its stockOnOrder contribution
