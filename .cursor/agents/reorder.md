---
name: reorder
description: |
  Expert agent for the reorder engine and draft PO creation. Use when working on:
  - src/lib/finale/client.ts — getExternalReorderItems(), createDraftPurchaseOrder()
  - src/lib/builds/lead-time-service.ts — LeadTimeService singleton
  - src/lib/builds/reorder-engine.ts
  - src/app/api/dashboard/reorder/route.ts — GET/POST
  - src/components/dashboard/ReorderPanel.tsx
  - Bot tools: reorder_assessment, create_draft_pos in src/cli/start-bot.ts
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
---

# Reorder Engine Agent

You are an expert on Aria's reorder engine. See `finale-ops` agent for Finale API patterns.

## Reorder Trigger Logic (`getExternalReorderItems()`)
Items appear when:
- `reorderQuantityToOrder > 0` **OR**
- `consumptionQty > 0` AND `stockoutDays < 45`

- Pages `productViewConnection` at **500/page** (client-side Active filter — server-side broken)
- Supplier: `supplierList[0].supplierPartyUrl` → `/api/partygroup/{id}` → `groupName`
- `resolveParty()` returns `{ groupName, isManufactured, isDropship }`
- Skip if `isManufactured` (groupName includes 'buildasoil'/'manufacturing'/'soil dept'/'bas soil')
- Skip if `isDropship` (see dropship exclusion list below)
- 5× concurrent worker pool + `partyCache` Map (prevents duplicate partygroup lookups)
- `stockoutDays` returns as string `"24 d"` — `parseFinaleNum()` strips non-numeric chars

## Dropship Exclusion List (both panels — server-side)
These vendors are **silently skipped** in both `getExternalReorderItems` AND `getPurchasingIntelligence`.
Never show in ReorderPanel or PurchasingPanel. Applied at `resolveParty()` via regex:
```
/autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i
```
Vendors: **Autopot, Printful, Grand Master, HLG (Horticulture Lighting Group), Evergreen, AC Infinity**
These are dropship-only vendors — BAS never holds their stock. Do not add reorder logic for them.

## Draft PO Creation (`createDraftPurchaseOrder()`)
```
POST /{accountPath}/api/order
{
  orderTypeId: 'PURCHASE_ORDER',
  statusId: 'ORDER_CREATED',
  orderRoleList: [{roleTypeId: 'SUPPLIER', partyId: vendorPartyId}],
  orderItemList: [{productUrl: ..., quantity, unitPrice}]
}
```
Returns `{orderId, finaleUrl}` — finaleUrl is base64-encoded orderUrl.
Safe fallback: `data.orderUrl || /{accountPath}/api/order/{orderId}`

## Lead Time Service (`lead-time-service.ts`)
Resolution: vendor median → SKU REST → **14-day default** | Cache TTL: **4 hours**

## Bot Tools
- `reorder_assessment` — compact summary: urgency breakdown + top 5 SKUs
- `create_draft_pos` — optional `vendor_filter`. Fallback qty: `Math.max(1, Math.ceil((consumptionQty/90)*30))`

## Dashboard API (`/api/dashboard/reorder/route.ts`)
- **GET** — reorder items grouped by vendor (10-min module-level cache)
- **POST** — create draft PO for specified vendor group

## Purchasing Intelligence (`getPurchasingIntelligence()`)
Separate from `getExternalReorderItems`. Uses raw velocity from receipt/shipment history, not Finale's unreliable server-calculated fields.
- 3× concurrent workers (rate-limit friendly) + 100ms inter-SKU pause
- Single combined GraphQL `getProductActivity(sku, daysBack)` — 3 aliased root fields in 1 request
- Default window: 365 days; deep-dive: 730 via `?daysBack=730`
- Same `resolveParty` exclusion logic (isManufactured + isDropship)
- See `finale-ops` agent and CLAUDE.md for full pipeline details

## Common Issues
1. **Item not in list** → Check `reorderQuantityToOrder` in Finale; may need threshold set
2. **Dropship vendor appearing** → Check regex in `resolveParty()`; vendor name must match pattern
3. **Wrong vendor grouping** → Check `partygroup` lookup; verify Finale supplier config
4. **Draft PO fails** → Confirm `vendorPartyId` is partygroup ID, not product ID
5. **Lead time wrong** → No historical POs for vendor → defaults to 14d
6. **Stockout showing NaN** → `parseFinaleNum()` should strip " d"; check if format changed
