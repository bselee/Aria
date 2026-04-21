---
description: Fill ULINE Quick Order cart from Finale draft POs using raw Playwright — no Stagehand
---

# ULINE Quick Order Workflow

> **When to use:** Filling a ULINE cart from a Finale draft PO before manual checkout.

## Quick Start

```bash
# Specific PO
node --import tsx src/cli/order-uline.ts --po 124636

# All ULINE draft POs
node --import tsx src/cli/order-uline.ts

# Preview only (no browser)
node --import tsx src/cli/order-uline.ts --po 124636 --dry-run

# Auto-detect low-stock ULINE items via purchasing intelligence
node --import tsx src/cli/order-uline.ts --auto-reorder

# Auto-detect + create draft PO in Finale
node --import tsx src/cli/order-uline.ts --auto-reorder --create-po
```

## What It Does

1. Fetches a Finale draft PO and maps SKUs to ULINE model numbers
2. Opens an isolated Playwright browser with your ULINE session cookies (from `.uline-session.json`)
3. Navigates to ULINE Quick Order → Paste Items page
4. Fills the textarea with `Model,Quantity` per line using `page.fill()` (proper event dispatch)
5. Clicks "Add to Cart" — browser stays open for manual review

**This is a FAUX ORDER** — nothing is submitted. User reviews and checks out manually.

## Key Rules

- **Guardrail:** Quantity > 5,000 units triggers a warning (ULINE sells by the box/case of 100-1000+)
- **Deduplication:** Same ULINE model across multiple POs → quantities are summed into one cart line
- **Session:** Uses cookie injection from `.uline-session.json` — no Stagehand, no LLM
- **Browser:** Isolated Playwright instance — cart is NOT visible in your normal Chrome window
- **Cart verification:** Scraper may double-count rows (desktop + mobile DOM rendering) — cart itself is correct

## Session Cookie Refresh

If you get logged out or session errors:

```bash
# Run the cookie grabber — open Chrome, log into ULINE, copy the redirect URL
node --import tsx src/cli/grab-cookies.ts
```

This saves cookies to `.uline-session.json`. The session typically lasts weeks to months.

## Files

| File | Purpose |
|------|---------|
| `src/cli/order-uline.ts` | Main ordering CLI |
| `src/lib/purchasing/uline-session.ts` | Browser launch + cookie injection |
| `src/lib/purchasing/uline-ordering.ts` | SKU mapping, quantity rounding, guardrails |
| `src/lib/purchasing/uline-cart-live.ts` | Cart scraper + verification |
| `.uline-session.json` | ULINE session cookies (gitignored) |

## Technical Notes

- **No Stagehand** — raw Playwright only. Stagehand's page abstraction doesn't expose `page.fill()` or `locator.click()`.
- **Fill method:** `page.fill('#txtPaste', text)` — triggers proper input events (unlike `page.evaluate()` DOM manipulation).
- **Click method:** `page.locator('#btnAddPastedItemsToCart').click()` — Playwright's native click.
- **Cart scraper** (`scrapeObservedUlineCartRows`): selector `tr, .cartRow, .itemRow, .orderRow` may double-count — fix with tighter scoping to `#cart-items-table tr` if needed.
