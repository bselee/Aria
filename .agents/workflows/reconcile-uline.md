---
description: Scrape ULINE invoice detail pages and reconcile line items against Finale POs — automated with real Chrome profile
---

# ULINE Invoice Reconciliation Workflow

> **When to use:** Reconciling ULINE invoices against Finale POs — updating per-item pricing, freight, and tax.

## Quick Start

```bash
# ⚠️ Close Chrome first — Playwright needs exclusive profile access

# Default: dry run (preview only, no Finale changes)
node --import tsx src/cli/reconcile-uline.ts

# Live update: write changes to Finale
node --import tsx src/cli/reconcile-uline.ts --live

# Just scrape (no Finale updates)
node --import tsx src/cli/reconcile-uline.ts --scrape-only

# Use cached scrape data (skip re-scraping)
node --import tsx src/cli/reconcile-uline.ts --update-only

# Single PO
node --import tsx src/cli/reconcile-uline.ts --po 124426

# Different year
node --import tsx src/cli/reconcile-uline.ts --year 2025
```

## What It Does

1. **Scrapes** all invoice detail pages from uline.com (persistent Chrome profile)
2. **Maps** ULINE item numbers to Finale SKUs (7 cross-references + 31 direct matches)
3. **Updates** Finale PO line-item prices to match ULINE invoice (source of truth)
4. **Adds** freight entries with descriptive labels (avoids duplicates)
5. **Restores** PO status (re-commits completed POs)

## Key Rules

- **ULINE invoice price = source of truth. Always.**
- **UOM CONVERSION (CRITICAL):** Finale tracks by the smallest unit (each, bag, roll, lb, kg). Vendors invoice by case/box/pallet. **Always divide vendor unit price by the conversion factor.** Formula: `finalePrice = vendorPrice / (finaleQty / vendorQty)`. Example: ULINE sells 1 box of 500 bags for $103 → Finale price = $103 / 500 = $0.206/bag. This applies to ALL vendors, not just ULINE.
- **Subtotal sanity check:** After price updates, Finale PO subtotal must match ULINE invoice subtotal (±$10). If it doesn't, something is wrong — do not save.
- **$0 items** (caps, jugs, lids) are bundled components — skip in reconciliation
- **Close Chrome** before running — Playwright needs exclusive profile access
- **DO NOT use injected cookies** — ULINE's grid won't render. Must use persistent Chrome profile.
- **No Stagehand** — uses raw Playwright only. Stagehand's page abstraction doesn't expose `page.fill()`.

## SKU Mapping

| ULINE | Finale | Description |
|-------|--------|-------------|
| S-15837B | FJG101 | Jugs |
| S-13505B | FJG102 | Bottles (120-pack) |
| S-13506B | FJG103 | Bottles (240-pack) |
| S-10748B | FJG104 | Bottles (60-pack) |
| S-12229 | 10113 | |
| S-4551 | ULS455 | |
| H-1621 | Ho-1621 | |

All other SKUs match directly between ULINE and Finale.

## Fee Type IDs

| Key | ID | Promo URL |
|-----|-----|-----------|
| FREIGHT | 10007 | `/buildasoilorganics/api/productpromo/10007` |
| TAX | 10008 | `/buildasoilorganics/api/productpromo/10008` |
| TARIFF | 10014 | `/buildasoilorganics/api/productpromo/10014` |
| SHIPPING | 10017 | `/buildasoilorganics/api/productpromo/10017` |

## Technical Notes

- **Selectors**: Invoice links use `a[href*="InvoiceDetail"]` (standard HTML table)
- **Page structure**: Standard HTML `<table>`, NOT Kendo grid widgets
- **Output**: Cached at `~/OneDrive/Desktop/Sandbox/uline-invoice-details.json`
- **Duplicate freight**: Script checks existing adjustments before appending
- **Bot detection**: ULINE blocks synthetic browsers. Only the persistent Chrome profile approach works.
