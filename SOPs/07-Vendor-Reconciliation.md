# 07 — Vendor Reconciliation

**Domain:** Order Confirmation Matching & PO Pricing/Shipping Updates  
**Owner:** Hermia (aria-purchasing)  
**Last Updated:** 2026-06-15  
**Supersedes:** Previous stub version (2026-06-15)

## Overview
Time-consuming manual task: Updating Finale POs with actual pricing, unit costs, and shipping/freight from vendor order confirmations or invoices after PO placement or payment. Example: Thirsty Earth PO 124902 was just paid — requires verification and update of line prices + shipping totals in Finale to match reality.

The reconciler layer (src/lib/finale/reconciler.ts + CLI tools) automates where possible. Manual fallback or vendor-specific flows for non-pipeline vendors.

## Reconciler Flows (Existing)
- `/reconcile-uline` — Scrapes Uline invoice detail pages for pricing/shipping
- `/reconcile-axiom` — Matches Axiom Print order confirmations (SKU expansion + freight)
- `/reconcile-fedex` — Correlates shipping tracking numbers to Finale POs (page 1 trim for AP)
- `/reconcile-vendor-po` (planned/general) — General vendor order confirmations from email/PDF
- `reconcile-teraganix`, `reconcile-aaa` — Vendor-specific

## Pricing & Shipping Update Process (New Focus)

**Primary Scenarios (per Bill clarification):**

1. **Direct pay by Bill (small items):** Invoice almost always references the most recent vendor PO. Correlation is straightforward — use PO# or vendor + recent date + amount.

2. **AP invoice received:** Most cases have a correlating PO. Run through pipeline (ap-identifier → reconciler) or manual `/reconcile <PO#>`.

3. **Difficult cases — Trucking / LTL / FTL:** High variability in shipping/freight. Multiple line items, possible multi-stop, PO# often missing or fuzzy. Requires fuzzy matching + manual review of freight surcharges, fuel, accessorials.

**When an invoice/confirmation arrives or payment is made (e.g. Thirsty Earth PO 124902):**

1. **Check if automated path applies**
   - Run `node --import tsx src/cli/reconcile-vendor-po.ts 124902` (or equivalent)
   - Or trigger via Telegram /reconcile <PO#>
   - Matches against ap_activity_log or vendor_invoices archive.

2. **Extract actuals**
   - Parse PDF/email for line items (qty, unit price, extended), shipping/freight, tax, total.
   - Use LLM or vendor-specific parser (like AXIOM_TO_FINALE pattern). For trucking: capture accessorial codes, fuel surcharge, LTL/FTL class.

3. **Compare to Finale PO**
   - Fetch PO details via FinaleClient.getOrderDetails(124902)
   - Diff prices, shipping, totals. For direct-pay: default to most recent open PO for that vendor if no explicit #.

4. **Apply updates (per reconciler decision)**
   - Invoice = source of truth.
   - Auto-apply price changes, freight/shipping unless >10x shift or math error.
   - Log to reconciliation_outcomes table.
   - Notify via Telegram with diff: "PO 124902 Thirsty Earth: Line X price $a → $b (+$c), shipping $d → $e. Applied."

5. **Thirsty Earth Specific (Example)**
   - Vendor often has variable commodity pricing + truck freight.
   - After payment confirmation (Bill.com or direct), forward confirmation PDF to pipeline or run manual reconcile.
   - PO 124902: Verify line pricing matched invoice, shipping updated, no short-ship.
   - If no PO# in email: Use fuzzy match on vendor + amount + date (prioritize most recent PO).

**Correlation Rules (Easy Path):**
- Direct pay small items → most recent vendor PO (vendor_party_id + created_at DESC).
- AP invoice → PO# in subject/body or line-item match.
- Trucking/LTL/FTL → Require extra signals: tracking #, BOL, multiple POs possible, freight line separate.

**Decision Tree:**
```
Invoice/Confirmation received?
  ├─ Direct pay by Bill (small) → Correlate to most recent vendor PO (easy)
  ├─ AP pipeline invoice → Standard reconcile (PO# usually present)
  └─ Trucking/LTL/FTL (difficult) → Fuzzy + freight detail parse + manual TG review
        └─ PO# present? → reconcile-vendor-po
            └─ No PO# → vendor + amount + date fuzzy + most recent rule
```

**Guardrails (from reconciler.ts):**
- FREIGHT / SHIPPING: Infinity tolerance (always apply)
- Price change: apply unless 10x magnitude or balance fail
- Always notify Will of changes

## CLI Commands
- `node --import tsx src/cli/reconcile-vendor-po.ts <PO#> [--dry-run]`
- `node --import tsx src/cli/reconcile-fedex.ts`
- Telegram: /reconcile 124902
- Debug: node --import tsx src/cli/reconcile-received-pos.ts (for post-receipt checks)

## Key Files & Tables
- `src/lib/finale/reconciler.ts` — Core engine, applyPriceChanges, applyFeeChanges, guardrails
- `src/lib/finale/reconcile-*.ts` — Vendor adapters
- `src/lib/matching/invoice-po-matcher.ts`
- Supabase: `reconciliation_outcomes`, `ap_activity_log`, `vendor_invoices`, `purchase_orders`
- Archive: `/vendor-invoice-archive`

## Kaizen Notes
- **2026-06-15 (initial):** Expanded from stub to include pricing/shipping update workflow triggered by Thirsty Earth PO 124902 example. Added decision tree, guardrails reference, CLI patterns.
- **2026-06-15 (refine):** Incorporated direct-pay / AP invoice / trucking-LTL-FTL scenarios per user clarification. Added correlation rules prioritizing most recent PO for direct pays, extra signals for difficult freight cases. Supersedes prior version.
- Open item: Implement full `reconcile-vendor-po.ts` CLI (currently relies on main reconciler). Add Thirsty Earth vendor alias/pattern if recurring. Extend for LTL/FTL accessorial parsing.
- Next: Integrate with three-way matching (receiving vs invoice vs PO) for short-ship detection. Cross with vendor-lead-time-tracking for freight drift.
- Related skills: ap-funnel, autonomous-purchasing-systems, aria-sop-database, po-pricing-shipping-reconciliation, vendor-lead-time-tracking

**Related Skills:** ap-funnel, po-pricing-shipping-reconciliation (new), vendor-lead-time-tracking
