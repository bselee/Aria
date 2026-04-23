---
description: Reconcile Axiom Print invoices against Finale POs — update pricing, add freight, create draft POs
---

# Axiom Print Invoice Reconciliation

// turbo-all

## Prerequisites
- Finale API credentials in `.env.local`
- Axiom Print login credentials in `.env.local` (`AXIOM_EMAIL`, `AXIOM_PASSWORD`)
- Chrome **closed** before running (Playwright needs exclusive profile access)
- Cached data at `~/OneDrive/Desktop/Sandbox/processed/axiom-order-details.json` (created by `--scrape-only`)

## Quick Run

> [!NOTE]
> `--dry-run` is the **default** behavior — no changes are made to Finale. Use `--live` to write.

1. **Dry run (default)** — fetch + reconcile with cached data, no Finale changes:
```bash
node --dns-result-order=ipv4first --import tsx src/cli/reconcile-axiom.ts
```

2. **Full pipeline + live update** (fetch + reconcile + write to Finale):
```bash
node --dns-result-order=ipv4first --import tsx src/cli/reconcile-axiom.ts --live
```

3. **Fetch invoice data only** (safe, API-only):
```bash
node --dns-result-order=ipv4first --import tsx src/cli/reconcile-axiom.ts --scrape-only
```

4. **Use cached data + live update** (skip API fetch, write to Finale):
```bash
node --dns-result-order=ipv4first --import tsx src/cli/reconcile-axiom.ts --update-only --live
```

> [!IMPORTANT]
> Always use `--dns-result-order=ipv4first` to avoid IPv6 DNS issues with Finale API.

## How It Works

### Step 1: Fetch Axiom Invoices (API)
- Authenticates via Playwright → acquires session cookies
- Calls `newapi.axiomprint.com/v1/project` REST API for invoice data
- Paginates through all pages (10 invoices/page)
- Extracts: job name, quantity, price, invoice number, dates
- Calculates shipping from `card_total - API_subtotal`
- Saves JSON to Sandbox for reuse

### Step 2: Match Invoices to Finale POs (Two-Pass)

**PO Fetch (paginated):**
| Page | Window | Limit | Why |
|---|---|---|---|
| 1 | Recent 270 days | 1000 | Catches current + recent POs |
| 2 | 270–540 days ago | 1000 | Catches older POs (crowded out by ULINE/FedEx) |

> [!NOTE]
> Finale API hard caps at `first: 1000`. With 500+ POs per 9 months across all vendors,
> Axiom's ~20 POs get crowded out. The paginated approach ensures complete coverage.

**Pass 1: Strict (date + SKU overlap)**
- Invoice date within [-7, +30] days of PO date
- At least one SKU match between invoice and PO
- Newest invoices get first pick

**Pass 2: Date-only fallback**
- For remaining invoices near an unused PO
- Tighter window: [-5, +14] days
- Handles POs with different product IDs or missing line items

### Step 3: Reconcile Matched POs
- Updates per-SKU pricing when invoice price differs from PO
- Adds freight as `orderAdjustment` with unique label per invoice
- Handles locked/completed PO statuses

### Step 4: Create Draft POs for Unmatched
- Looks up Axiom vendor party ID
- Creates draft POs with correct line items and pricing
- Adds freight adjustments to draft POs
- Archives all invoices to `vendor_invoices` table

## SKU Mapping

24 Axiom job names → Finale SKUs including front/back label pairs:
- `GNS Front 1 Gallon / GNS Back 1 Gallon` → `GNS11` + `GNS21`
- `BAS Ball_Full 1 Gallon` → `BAF1G`
- See `AXIOM_TO_FINALE` map in the script for full list

## Pagination Pattern (For Other Reconcilers)

> [!TIP]
> If your reconciler fetches POs via `getRecentPurchaseOrders()` and you're seeing
> missing matches, the `first: 500` default across ALL vendors may be the bottleneck.
>
> **Fix:** Use the `limit` parameter: `getRecentPurchaseOrders(daysBack, limit)`
> - Default is 500, Finale API hard caps at 1000
> - For long date ranges (>180 days), use paginated calls:
>   ```ts
>   const page1 = await finale.getRecentPurchaseOrders(180, 1000);
>   const page2 = await finale.getRecentPurchaseOrders(360, 1000);
>   // Deduplicate by orderId
>   ```
> - Affected scripts: `reconcile-teraganix.ts` (180d), `reconcile-fedex.ts` (400d)

## Troubleshooting

- **0 Axiom POs found**: increase `daysBack` or `limit` — Axiom POs get crowded out
- **Session expired**: close all Chrome windows, re-run with `--scrape-only`
- **SKU not mapped**: add entry to `AXIOM_TO_FINALE` map in the script
- **Finale 404**: check `.env.local` credentials and ensure `dotenv` loads correctly
