---
name: finale-lookup
description: |
  Look up products, SKUs, POs, or stock levels in Finale Inventory using the CLI probe scripts.
  Use when debugging Finale data, verifying stock levels, checking PO status, or
  exploring the Finale API response shapes.
allowed-tools:
  - Bash(node --import tsx src/cli/test-finale.ts)
  - Bash(node --import tsx src/cli/probe-finale.ts)
  - Bash(node --import tsx src/cli/check-finale-statuses.ts)
  - Bash(node --import tsx src/cli/verify-tools.ts)
---

# Finale Inventory Lookup (Aria)

Scripts for probing and verifying Finale Inventory data.

## Scripts

### Test Finale Connection + Basic Lookups
```bash
node --import tsx src/cli/test-finale.ts
```
Verifies Finale API connectivity and runs sample queries.

### Probe Finale API Shapes
```bash
node --import tsx src/cli/probe-finale.ts
```
Explores Finale API response structures — useful when debugging field names or unexpected data.

### Check Order Statuses
```bash
node --import tsx src/cli/check-finale-statuses.ts
```
Lists current PO statuses in Finale — useful for finding ORDER_LOCKED POs.

### Verify All Bot Tools
```bash
node --import tsx src/cli/verify-tools.ts
```
Runs a suite of tool verifications including Finale connectivity.

## Finale API Key Facts
- Auth: Basic auth with `FINALE_API_KEY:FINALE_API_SECRET`
- Base URL: `${FINALE_BASE_URL}/${FINALE_ACCOUNT_PATH}/api/`
- Pre-existing TypeScript errors in `src/lib/finale/client.ts` — do NOT fix them
- Write pattern: **GET → Modify → POST** (always)
- Lock unlock: call `actionUrlEdit` before modifying `ORDER_LOCKED` POs

## Fee Type IDs (productpromo)
| Type | ID |
|------|----|
| FREIGHT | 10007 |
| TAX | 10008 |
| TARIFF | 10014 |
| LABOR | 10016 |
| SHIPPING | 10017 |

## GraphQL Pagination
`productViewConnection` must be paged at 500 items. Always check if there are more pages.
