# 01 — AP Invoicing Pipeline

**Domain:** Gmail Ingest & Accounts Payable  
**Owner:** aria-ap + Hermia  
**Last Updated:** 2026-06-15  
**Supersedes:** Older manual invoice handling

## Pipeline Stages
1. **Ingest** — Raw PDF invoices via Google Drive/Gmail/Email attachments (multi-account: default + ap slots)
2. **OCR Parsing** — `pdf-pipeline` extracts line items, totals, vendor, invoice #
3. **PO Mapping** — Line items matched to Finale Purchase Orders (`finale-ops`)
4. **Logging** — Results written to Supabase `ap_activity_log`
5. **Archive** — Raw invoices moved to `vendor_invoices` via `/vendor-invoice-archive`
6. **Dashboard State** — `⟳ FLOW-THROUGH` or `🔍 NEEDS ANALYSIS` (reclassify via TG `/reclassify`)

## Key Rules
- `token.json` = Slot "default" (bill.selee@buildasoil.com)
- `ap-token.json` = Slot "ap" (ap@buildasoil.com)
- FedEx AP: Trim page 1 (invoice# = summary), forwarder naming = `FedEx_<type>_<invoice#>.pdf`
- `invoice_date` must be > `expectedReceiveDate` = shipped date
- PO replies always check invoices first

## Verification
- `node --import tsx src/cli/gmail-auth.ts ap|default`
- `node --import tsx src/cli/run-ap-pipeline.ts`

## Kaizen Notes
- Morning AP health report at 8:30 AM weekdays
- `sendCriticalTelegramNotify` bypasses business-hours gate
- Invoice class config in `config/invoice-classification.ts`

**Related Skills:** `ap-funnel`, `ap-llm-comparison`

---
**Status:** Core pipeline stable. Next: Full SOP for reclassification logic.