# 03 — Reorder Engine & Autonomous Purchasing

**Domain:** Inventory Velocity, Runway, Lead Times  
**Owner:** aria-purchasing + Hermia  
**Last Updated:** 2026-06-15

## Core Calculations
- Queries live Finale stock counts
- SKU velocity (daily consumption)
- Lead times + safety thresholds
- Runway calculation + draft PO quantities

## Uline Autonomous Ordering (Current Flow)
1. Aria reorder surfaces need
2. Check Uline cart (if non-empty → ask Bill)
3. Create Finale draft PO first
4. Push to Uline cart (reverse unit conversion: eaches → carton)
5. Verify match
6. Notify Bill (leave payment to Bill)

**Supersedes:** Old `uline-cart-to-po` flow

## Uline Technical Notes
- Add-to-cart on product detail pages (qty + ADD)
- Cart at `/Product/ViewCart`
- Checkout requires B2B login
- Target = fill cart + verify only

**Related Skills:** `uline-autonomous-ordering`, `purchases-crawl`

---
**Status:** Flow documented. Next: Full vendor lead-time tracking SOP.