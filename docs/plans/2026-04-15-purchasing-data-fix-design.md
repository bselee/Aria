# Purchasing Data Fixes Design

**Date:** 2026-04-15
**Author:** Aria
**Status:** Approved — in implementation

## Problem Statement

Two issues in the ordering/purchasing dashboard:

1. **Case multiplier missing:** Teraganix sells in case packs (EM102 = 12 bottles/case). `suggestedQty` is computed in units with no conversion, producing orders 4x–12x too small.

2. **PO on-order quantity inflated:** `getProductActivity()` and `findCommittedPOsForProduct()` add the full **original ordered quantity** of Committed/Locked POs to `stockOnOrder`, ignoring partial receipts. PO 124624 shows as "on order" when most of it has already been received.

## Fix 1 — Case Multiplier Handling

### Solution

Add a `vendor_case_multipliers` Supabase table as the lookup source for case → unit conversion:

```sql
CREATE TABLE vendor_case_multipliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_pattern TEXT NOT NULL,      -- e.g. "teraganix", "uline", case-insensitive
  sku_pattern TEXT,                   -- e.g. "EM102", null = all SKUs from this vendor
  multiplier NUMERIC NOT NULL,        -- e.g. 12
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
-- Unique index to prevent duplicates
CREATE UNIQUE INDEX idx_vcm_vendor_sku ON vendor_case_multipliers(vendor_pattern, sku_pattern);
```

**Fallback chain for each purchasing candidate:**
1. Check `vendor_case_multipliers` for matching vendor + SKU pattern
2. If no match and vendor has known multi-unit pattern (e.g. "uline" → boxes), apply built-in defaults as temporary fallback
3. If no match at all, multiplier = 1 (existing behavior, no change)

**In `buildPurchasingCandidate()` / `getPurchasingIntelligence()`:**
- After `suggestedQty` is computed: `suggestedQty = ceil(suggestedQty * multiplier)`
- The multiplier applies to the **final suggested quantity**, not intermediate velocity calculations

### Files Touched
- `src/lib/finale/client.ts` — apply multiplier to `suggestedQty`
- New Supabase migration for `vendor_case_multipliers` table

---

## Fix 2 — PO Remaining Quantity

### Solution

Modify `getProductActivity()` and `findCommittedPOsForProduct()` to fetch `shipmentList` and compute `remainingQty`:

**GraphQL query change (in both methods):**
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
        shipmentList {      -- ADD THIS
            edges { node { shipmentId receiveDate } }
        }
    }}
}
```

**Per-line-item remaining qty logic:**
```
For each PO edge:
  For each item matching SKU:
    originalQty = ie.node.quantity
    receivedQty = sum of shipmentList.edges where receiveDate is not null
    remainingQty = originalQty - receivedQty
    if remainingQty <= 0: skip this PO
    push { orderId, quantity: remainingQty, orderDate }
```

**Also update:** `adjustedRunwayDays` formula uses `stockOnOrder` (sum of all open PO quantities) — must reflect `remainingQty` values to avoid inflated runway suppressing legitimate reorder alerts.

### Files Touched
- `src/lib/finale/client.ts` — `getProductActivity()` (lines ~4310-4378), `findCommittedPOsForProduct()` (lines ~1323-1380), `adjustedRunwayDays` calculation

---

## Testing Plan

1. **Teraganix:** Verify EM102 multiplier = 12, EM103 = 4, EM105 = 1 via `vendor_case_multipliers` lookup; `suggestedQty` should be 12× computed value
2. **PO 124624:** Query `getProductActivity("PO_SKU")` and confirm open PO quantities reflect received shipments; partially-received POs should contribute only remaining qty
3. **Regression:** Other vendors with multiplier = 1 should have unchanged behavior
4. **Dashboard:** Verify "on order" display in PurchasingPanel reflects remaining qty, not original qty
