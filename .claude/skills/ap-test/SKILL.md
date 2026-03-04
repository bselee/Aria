---
name: ap-test
description: |
  Run the AP pipeline test scripts to validate invoice processing end-to-end.
  Use when debugging AP invoice failures, testing reconciliation changes, or
  validating a new OCR strategy. Tests against real Gmail and Finale.
allowed-tools:
  - Bash(node --import tsx src/cli/run-ap-pipeline.ts)
  - Bash(node --import tsx src/test/test-ap-agent-live.ts)
  - Bash(node --import tsx src/cli/test-ap-routing.ts)
---

# AP Pipeline Test (Aria)

Tools for testing the full AP invoice processing pipeline.

## Scripts

### Full Pipeline (recommended first)
```bash
node --import tsx src/cli/run-ap-pipeline.ts
```
Triggers the AP pipeline against a real Gmail invoice in `ap@buildasoil.com`.
- Reads from actual Gmail inbox
- Classifies, extracts, matches to Finale PO
- Shows reconciliation result WITHOUT writing to Finale (dry-run if configured)

### Live AP Agent Test
```bash
node --import tsx src/test/test-ap-agent-live.ts
```
Full live test including Finale writes. Use carefully in production.

### AP Routing Test
```bash
node --import tsx src/cli/test-ap-routing.ts
```
Tests email classification routing (INVOICE/STATEMENT/ADVERTISEMENT/HUMAN_INTERACTION).

## What to Look For

### OCR
- Which of the 4 strategies succeeded (logged)
- Extracted text quality — decimal points correct?
- Line items count matches actual invoice

### PO Matching
- Raw token found, then which transform found the Finale PO
- If multiple candidates, which scored highest by vendor name overlap
- "No PO found" → check dropship store path

### Reconciliation
- Per-line price deltas and %
- Auto-approve vs pending-approval vs rejected
- 10× guardrail trigger (decimal OCR error)

## Gmail Filter
The test script uses `bill.selee@buildasoil.com` (default token) and skips:
- Files < 1KB
- Emails with subject "Dashboard Upload" (echo emails)

## Notes
- All scripts load `.env.local` automatically
- Requires valid `ap-token.json` and `token.json` in project root
- If Gmail token expired: `node --import tsx src/cli/gmail-auth.ts ap`
