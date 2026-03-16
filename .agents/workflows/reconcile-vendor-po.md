---
description: Reconcile vendor order confirmations against Finale POs — extract per-item pricing and shipping from email, map to Finale SKUs, update PO prices and add freight
---

# Vendor PO Reconciliation Workflow

> Use when: A vendor sends order confirmations with discounted pricing that needs to be reflected in Finale POs, or when reconciling invoices with actual costs including shipping/freight.

## Prerequisites

- Gmail access configured (default account)
- Finale API credentials in `.env.local`
- `FinaleClient` from `src/lib/finale/client.ts`

## Step 1: Extract Order Details from Email

Search Gmail for order confirmations from the vendor:

```typescript
// Search for order confirmations
const { data } = await gmail.users.messages.list({
    userId: "me",
    q: `from:VENDOR_EMAIL subject:"Order" subject:"confirmed"`,
    maxResults: 20,
});
```

For each email, extract:
- **Order number** (from subject, e.g. `Order #76658`)
- **Line items** with quantities and prices (both retail and discounted)
- **Subtotal, discount amount, shipping, and total**
- **Email date** (for PO matching)

Parse the email body to calculate **per-item discounted pricing**:
- If order has an overall discount, distribute proportionally: `discountedPrice = lineTotal × (1 - discount/subtotal) / qty`
- Watch for per-foot vs per-unit pricing — Finale may store differently than the vendor's email

## Step 2: Match Orders to Finale POs

Fetch recent POs for the vendor:

```typescript
const finale = new FinaleClient();
const allPOs = await finale.getRecentPurchaseOrders(120); // look back N days
const vendorPOs = allPOs.filter(po =>
    po.vendorName.toLowerCase().includes("vendor_name")
);
```

Match by **date proximity** (within 3-5 days) between email date and PO orderDate.

**IMPORTANT**: Exclude dropship POs (e.g., IDs containing "DropshipPO"). Multiple orders can map to the same PO.

## Step 3: Map Vendor Product Names → Finale SKUs

Run a **dry-run first** to inspect actual Finale line items:

```typescript
const orderData = await finale.getOrderDetails(poId);
const items = orderData.orderItemList || [];
for (const item of items) {
    console.log(`${item.productId} × ${item.quantity} @ $${item.unitPrice}`);
}
```

Build a SKU mapping table. Watch for:
- **Per-foot pricing**: Tubing/tape is stored per-foot in Finale, per-roll in vendor emails
  - `emailPrice / rollLength = finalePerFootPrice`
- **`undefined` productId entries**: Skip these (empty/placeholder rows)
- **Items already at correct price**: Skip to avoid unnecessary API calls

### ⚠️ UOM Conversion (CRITICAL — applies to ALL vendors)

**Finale always tracks by the smallest unit** (each, bag, roll, lb, kg). Vendors invoice by case/box/pallet/roll.

When vendor qty ≠ Finale qty for the same item, you MUST divide:

```
finaleUnitPrice = vendorUnitPrice / (finaleQty / vendorQty)
```

Example: Vendor sells 1 box of 500 bags for $103. Finale has 500 individual bags.
- Conversion factor = 500 / 1 = 500
- Finale price = $103 / 500 = **$0.206/bag**

**If you skip this, a $103 box becomes $103×500 = $51,500. Catastrophic.**

Always sanity-check: **Finale PO subtotal must match vendor invoice subtotal (±$10).** If it doesn't, something is wrong — do not save.

## Step 4: Apply Price Updates

Use `FinaleClient.updateOrderItemPrice()` which handles all PO states:

```typescript
// Works on Draft, Committed, AND Completed POs
const result = await finale.updateOrderItemPrice(orderId, sku, newUnitPrice);
// Auto: unlock → edit → restore original status
```

The method automatically:
- Unlocks Committed POs via `actionUrlEdit`
- Un-completes Completed POs via `actionUrlEdit`
- Applies the price change
- Re-commits or re-completes to restore original status

## Step 5: Add Freight (Shipping)

Use `FinaleClient.addOrderAdjustment()` with `FREIGHT` type:

```typescript
await finale.addOrderAdjustment(orderId, "FREIGHT", amount, "Freight - Order #XXXXX");
```

**Multiple freight entries**: If a PO has multiple orders with different shipping amounts, you need to build the adjustment list manually:

```typescript
const currentPO = await finale.getOrderDetails(orderId);
const freightPromoUrl = `/buildasoilorganics/api/productpromo/10007`;

// Remove existing freight, add new entries
const adjustments = (currentPO.orderAdjustmentList || [])
    .filter(adj => adj.productPromoUrl !== freightPromoUrl);

adjustments.push({ amount: 35, description: "Freight - Order #1", productPromoUrl: freightPromoUrl });
adjustments.push({ amount: 45, description: "Freight - Order #2", productPromoUrl: freightPromoUrl });

// POST back with all adjustments
await finale.post(`/${accountPath}/api/order/${orderId}`, {
    ...currentPO,
    orderAdjustmentList: adjustments,
});
```

Skip $0 shipping entries — no need to add a $0 freight adjustment.

## Step 6: Verify & Generate Report

After all updates, generate an artifact/report showing:
- Per-PO breakdown with old → new prices
- Freight added per order
- Any SKUs that couldn't be matched
- Final PO status

## Key Learnings

1. **Finale API rejects edits on ORDER_COMPLETED POs** — must un-complete first via `actionUrlEdit`, then re-complete via `actionUrlComplete`
2. **actionUrlEdit works on both Committed AND Completed POs** — same endpoint, different source states
3. **Finale auto-completes on commit** for formerly-completed POs — calling `actionUrlComplete` on a draft that was previously completed goes straight to ORDER_COMPLETED
4. **Per-foot pricing trap**: Always inspect actual Finale quantities — if PO shows `BLM202 × 700`, that's 700 feet, not 7 rolls
5. **Always dry-run first**: Inspect actual SKUs and current prices before applying changes
6. **Multiple orders per PO**: Group orders by PO, combine freight entries
7. **Fee type IDs** are in `FinaleClient.FINALE_FEE_TYPES` — FREIGHT is `10007`

## Available Fee Types

| Key | ID | Name |
|-----|-----|------|
| FREIGHT | 10007 | Freight |
| TAX | 10008 | Tax |
| TARIFF | 10014 | Duties/Tariff |
| SHIPPING | 10017 | Shipping |
| LABOR | 10016 | Labor |
| DISCOUNT_20 | 10011 | Discount 20% |
| DISCOUNT_10 | 10012 | Discount 10% |
| FREE | 10013 | Free |
