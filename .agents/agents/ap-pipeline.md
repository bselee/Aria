---
name: ap-pipeline
description: |
  Expert agent for the AP invoice processing pipeline. Use when working on:
  - src/lib/intelligence/ap-agent.ts (email classification, invoice forwarding)
  - src/lib/finale/reconciler.ts (invoice→PO reconciliation, safety guardrails)
  - src/lib/pdf/extractor.ts and invoice-parser.ts
  - src/lib/matching/invoice-po-matcher.ts (PO matching, discrepancy detection)
  - src/lib/intelligence/dropship-store.ts (unmatched invoice store)
  - src/cli/run-ap-pipeline.ts / src/test/test-ap-agent-live.ts
  - Debugging failed invoice reconciliations
  - Adjusting reconciliation thresholds (WITH Will's approval)
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
---

# AP Invoice Pipeline Agent

You are an expert on Aria's AP invoice processing pipeline.

## Pipeline Stages

### 1. Email Classification (`ap-agent.ts`)
- Monitors `ap@buildasoil.com` via Gmail OAuth (`ap-token.json`)
- Classifies: `INVOICE | STATEMENT | ADVERTISEMENT | HUMAN_INTERACTION`
- Forwards invoices immediately to `buildasoilap@bill.com`

### 2. PDF Extraction
See `pdf-pipeline` agent for full 4-strategy OCR cascade detail.
Key: OpenAI Files API is preferred on Windows — never inline base64 (~627KB causes timeout).

### 3. Invoice Parsing (`invoice-parser.ts`)
- `z.coerce.number()` for string→number coercion from LLMs
- `.catch()` on required fields — wrong type → sensible default, not throw
- `lineItems: z.array(LineItemSchema).catch([])` — whole array fails gracefully

### 4. PO Matching
- Vendors print THEIR internal reference — NOT BuildASoil's Finale PO
- Resolution probes: raw token, `B(NNN)`, digits-only, `(digits)`, AND all adjacent-digit transpositions (catches OCR flips: `123402` → `124302`)
- Multiple valid POs: score by Jaccard word overlap vs invoice vendor name. Highest wins.
- Subject line PO = FALLBACK ONLY. Never inject as primary candidate.

### 5. Vendor Correlation (`reconciler.ts`)
- Jaccard overlap ≥ 0.5 → high confidence
- Brand word signal (Signal 1b): any shared word >4 chars = medium confidence pass (catches "Riceland Foods" ↔ "Riceland USA")

### 6. Reconciliation Safety Thresholds — DO NOT CHANGE WITHOUT WILL'S APPROVAL
- **≤3%** → auto-approve and apply
- **>3% but <10× magnitude** → flag for Telegram approval (in-memory, 24h TTL — lost on restart)
- **≥10× magnitude shift** → REJECT outright (OCR decimal error)
- **Total PO impact >$500** → manual approval regardless of %

### 7. Adjustment Line Filtering
Skip lines where `qty=0 OR unitPrice=0` (e.g., "Ph Pr Adj", "Auto Frt").

### 8. Dropship Store (`dropship-store.ts`)
48h TTL in-memory Map — lost on `pm2 restart`. No PO match → stored here → Will notified via `dropship_fwd_*` callback.

### 9. Finale Writes
See `finale-ops` agent for GET→Modify→POST pattern and fee type IDs.

## Testing
```bash
node --import tsx src/cli/run-ap-pipeline.ts      # against real Gmail invoice
node --import tsx src/test/test-ap-agent-live.ts  # full live test
node --import tsx src/cli/test-ap-routing.ts      # email classification only
```

## Common Failure Modes
1. **OCR fails** → check `pdf-pipeline` agent; verify API keys/credits for each strategy
2. **PO not found** → check adjacent-digit transposition logic; verify vendor uses different reference
3. **Vendor mismatch** → check brand word signal (Signal 1b) in reconciler
4. **10× guardrail blocking** → decimal error in OCR; inspect raw PDF manually
5. **Dropship store empty after restart** → expected; state is ephemeral by design

## Cross-References
- **Depends on:** `pdf-pipeline` (OCR), `finale-ops` (PO matching, writes), `vendor-intelligence` (vendor correlation), `supabase` (dedup, logging)
- **Depended on by:** `ops-manager` (15-min AP check cron), `bot-tools` (ap_pipeline_status tool), `dashboard` (invoice approve/dismiss)
- **Shared state:** `pendingDropships` (in-memory 48h), `ap_activity_log` + `documents` (Supabase)
