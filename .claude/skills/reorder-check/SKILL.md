---
name: reorder-check
description: |
  Check reorder status and test draft PO creation for Aria.
  Use when debugging why items appear/don't appear, or testing PO creation.
allowed-tools:
  - Bash(node --import tsx src/cli/verify-tools.ts)
  - Bash(node --import tsx src/cli/probe-finale.ts)
---

# Reorder Check (Aria)

## Via Dashboard (preferred)
```
GET  /api/dashboard/reorder   # items by vendor (10-min cache)
POST /api/dashboard/reorder   # create draft PO for vendor group
```
Start dev server: `npm run dev`

## Via CLI
```bash
node --import tsx src/cli/verify-tools.ts   # includes reorder assessment
node --import tsx src/cli/probe-finale.ts   # explore Finale API shapes
```

## Trigger Conditions
- `reorderQuantityToOrder > 0` **OR** (`consumptionQty > 0` AND `stockoutDays < 45`)
- `stockoutDays` arrives as `"24 d"` string — `parseFinaleNum()` strips non-numeric chars

## Fallback Qty Formula
`Math.max(1, Math.ceil((consumptionQty / 90) * 30))` ≈ 30 days at current consumption rate

See `reorder` agent for full implementation details.
