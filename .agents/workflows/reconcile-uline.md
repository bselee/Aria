---
description: Scrape ULINE invoice detail pages and reconcile line items against Finale POs — automated with real Chrome profile
---

# ULINE Invoice Reconciliation Workflow

> Use when: Reconciling ULINE invoices against Finale POs — extracting per-item SKUs and pricing from uline.com, then updating Finale POs with correct prices, freight, and tax.

## Prerequisites

- User must be logged into uline.com in their real Chrome browser
- Finale API credentials in `.env.local`
- ULINE credentials in `.env.local` (`ULINE_EMAIL`, `ULINE_PASSWORD`)

## Step 1: Scrape ULINE Invoice Details

**Script**: `src/cli/scrape-uline-details.ts`

```bash
# IMPORTANT: Close Chrome first — Playwright needs exclusive profile access
node --import tsx src/cli/scrape-uline-details.ts
```

This uses the **real Chrome profile** (persistent context) to bypass ULINE's bot detection. It:
1. Navigates to `https://www.uline.com/MyAccount/Invoices`
2. Collects all invoice links from the grid
3. Visits each `InvoiceDetail` page
4. Scrapes the HTML table for: Item#, Description, Qty, Unit Price, Extended Price
5. Outputs structured JSON to `~/OneDrive/Desktop/Sandbox/uline-invoice-details.json`

### Key Technical Details

- **DO NOT use injected cookies** — ULINE's Kendo grid won't render in a synthetic browser context. Only the persistent Chrome profile approach works.
- **Selector**: Invoice links use `a[href*="InvoiceDetail"]` (NOT `.k-grid-content`)
- **Page structure**: Standard HTML `<table>`, not Kendo grid widgets
- **Line items table**: Identified by finding a `<th>` containing "Item #"
- **Order info row**: Identified by first cell matching 7-digit customer number pattern

## Step 2: Match ULINE Items to Finale SKUs

ULINE item numbers (e.g., `S-14454C`, `H-754`) map directly to Finale product IDs.
Some items have **component entries** with $0 price (e.g., `S-13505B-JUG`, `S-13505CAP`) — these are caps/jugs bundled with the main item. Skip $0 items.

## Step 3: Add Freight to Finale POs

**Script pattern**: `tmp/add-freight-reconcile.ts` (or `tmp/fix-124143-freight.ts`)

```typescript
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { FinaleClient } from "../src/lib/finale/client";

const FREIGHT_PROMO = `/buildasoilorganics/api/productpromo/10007`;

async function run() {
    const finale = new FinaleClient();
    const post = (finale as any).post.bind(finale);

    const poId = '124338';
    const po = await finale.getOrderDetails(poId);

    // Unlock if needed
    if (po.actionUrlEdit && (po.statusId === 'ORDER_LOCKED' || po.statusId === 'ORDER_COMPLETED')) {
        await post(po.actionUrlEdit, {});
    }

    const unlocked = await finale.getOrderDetails(poId);
    const adjustments = [...(unlocked.orderAdjustmentList || [])];

    // ⚠️ CHECK FOR EXISTING FREIGHT FIRST — avoid duplicates!
    // Compare amounts before appending
    adjustments.push({
        amount: 30.35,
        description: 'Freight - ULINE Inv 203591102',
        productPromoUrl: FREIGHT_PROMO,
    });

    await post(`/buildasoilorganics/api/order/${poId}`, {
        ...unlocked, orderAdjustmentList: adjustments
    });

    // Re-commit
    const after = await finale.getOrderDetails(poId);
    if (after.actionUrlComplete) await post(after.actionUrlComplete, {});
}
run().catch(console.error);
```

### Critical: Avoiding Duplicate Freight

**ALWAYS check existing adjustments** before appending. If a generic "Freight" entry exists at the same amount you're about to add, **remove it first** and replace with the descriptive version.

```typescript
// Remove generic freight that matches our amount, keep everything else
const cleaned = adjustments.filter(a =>
    a.productPromoUrl !== FREIGHT_PROMO ||
    a.amount !== newAmount  // keep if different amount
);
cleaned.push({ amount: newAmount, description: 'Freight - ULINE Inv XXXXX', productPromoUrl: FREIGHT_PROMO });
```

## Step 4: Cross-Reference FedEx COLLECT Freight

FedEx freight CSV files (from `~/OneDrive/Desktop/Sandbox/`) contain shipments for ALL vendors.

To filter to Finale POs:
- Look for PO_NUMBER column values matching 6-digit Finale PO format (12xxxx)
- These are always COLLECT shipments (FedEx billing BuildASoil directly)
- The corresponding ULINE invoices typically show $1.50 nominal freight

Add FedEx freight as additional FREIGHT entries on the same PO, with descriptive labels like `FedEx Freight - Inv XXXXXXXXX`.

## Fee Type IDs

| Key | ID | Promo URL |
|-----|-----|-----------|
| FREIGHT | 10007 | `/buildasoilorganics/api/productpromo/10007` |
| TAX | 10008 | `/buildasoilorganics/api/productpromo/10008` |
| TARIFF | 10014 | `/buildasoilorganics/api/productpromo/10014` |
| SHIPPING | 10017 | `/buildasoilorganics/api/productpromo/10017` |

## Key Learnings

1. **ULINE bot detection**: Injected cookies authenticate but Kendo grid doesn't render. MUST use persistent Chrome profile (`chromium.launchPersistentContext`).
2. **Close Chrome first**: Playwright needs exclusive access to the Chrome profile directory.
3. **No PDF needed**: The InvoiceDetail HTML page has all line-item data in a clean `<table>`.
4. **$0 line items**: ULINE bundles caps/jugs/lids as separate $0 line items — skip these in reconciliation.
5. **Check tmp/ first**: Prior reconciliation scripts live in `tmp/` (e.g., `fix-124143-freight.ts`, `add-freight-reconcile.ts`). Always check for existing patterns before writing new scripts.
6. **Duplicate freight trap**: Always audit existing adjustments before appending. Generic "Freight" entries may already exist at the same amount.

## Available Scripts

| Script | Purpose |
|--------|---------|
| `src/cli/scrape-uline-details.ts` | Scrape all invoice line items from uline.com |
| `src/cli/scrape-uline-invoices.ts` | Export summary CSV from uline.com |
| `src/cli/probe-uline-pos.ts` | Inspect ULINE POs in Finale |
| `tmp/add-freight-reconcile.ts` | Bulk add freight entries to Finale POs |
| `tmp/fix-duplicate-freight.ts` | Clean up duplicate freight adjustments |
| `tmp/audit-freight.ts` | Verify current freight state on POs |
