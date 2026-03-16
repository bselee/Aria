---
description: Reconcile FedEx billing against Finale POs — identify and add missing freight charges
---

# FedEx Freight Reconciliation

// turbo-all

## Prerequisites
- FedEx billing CSV exported from https://www.fedex.com/billing/ → placed in `~/OneDrive/Desktop/Sandbox/`
  - File naming: `FEDEX_*.csv`
  - Both inbound and outbound CSVs are supported
- Finale API credentials in `.env.local`
- FedEx API credentials in `.env.local` (for Track API matching)

## Quick Run

1. **Report mode** (safe, read-only):
```bash
node --import tsx src/cli/reconcile-fedex.ts --report-only
```

2. **Dry run** (shows what would be updated):
```bash
node --import tsx src/cli/reconcile-fedex.ts --dry-run
```

3. **Live update** (adds freight to POs):
```bash
node --import tsx src/cli/reconcile-fedex.ts
```

4. **Specific CSV file**:
```bash
node --import tsx src/cli/reconcile-fedex.ts --csv path/to/FEDEX_export.csv
```

## How It Works

### Step 1: Parse FedEx CSV
- Auto-finds the latest `FEDEX_*.csv` in Sandbox
- Deduplicates by invoice number
- Categorizes as COLLECT (BAS pays) vs PREPAID (vendor pays)

### Step 2: Match COLLECT Entries to Finale POs
- **PO reference match**: Extracts 6-digit PO numbers from the FedEx PO_NUMBER field
- **Track API match**: For entries without PO refs, queries FedEx Track API → gets origin city/state → maps to known vendor → finds Finale PO by vendor + date
- Checks for existing freight to avoid duplicates

### Step 3: Add Missing Freight
- Adds freight as `orderAdjustment` with unique label per FedEx invoice
- Handles multiple deliveries per PO (e.g., Rootwise sends 2-3 FedEx Freight deliveries against one PO)
- Preserves PO status (unlocks, edits, restores Committed/Completed)

### Step 4: Audit Report
- Saves `fedex-reconcile-report.json` to Sandbox
- Contains all matched/unmatched entries with amounts and match sources

## Key Rules

1. **COLLECT = BAS pays freight** → Must be on a Finale PO
2. **PREPAID = vendor pays** → No action needed (cost is in vendor pricing)
3. **Multiple deliveries per PO**: Use unique freight labels with FedEx invoice number
4. **Vendor origin mapping**: Maintained in `VENDOR_ORIGIN_MAP` in the script
   - Evergreen, CO → Rootwise Soil Dynamics
   - Add new vendors as identified

## Known Vendors by Origin

| City, State | Vendor | Account | Notes |
|---|---|---|---|
| Evergreen, CO | Rootwise Soil Dynamics | 646135168 | Multiple deliveries per PO |
| Memphis, TN (38120) | ULINE Distribution | 646135168 | PO# in FedEx ref field |
| Laytonville, CA | Grokashi | 646135168 | Excluded (special arrangement) |
| Missoula, MT | Granite Mill | 730901267 | Heavy freight (2200 lbs) |

## Troubleshooting

- **404 on PO lookup**: Finale API loaded wrong `.env`. Check `dotenv.config({ path: '.env.local' })`
- **No CSV found**: Export from https://www.fedex.com/billing/ → ensure file starts with `FEDEX_`
- **Track API auth fails**: Check `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET` in `.env.local`
- **Unmatched entries**: Check the report JSON, use origin city to identify vendor, add to `VENDOR_ORIGIN_MAP`
