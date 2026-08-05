# PO ↔ Tracking ↔ Invoice Correlation Hardening

> **For Hermes:** Dispatch one subagent per workstream. Do not commit unless asked.

**Goal:** Make LTL/FTL BOL tracking reliable, link invoice-embedded tracking to open POs, and make Active Purchases show a trustworthy PO → tracking → invoice story.

**Architecture:** Three independent write paths feed one correlation surface.

```
Gmail (bill.selee@ + ap@)
  ├─ email-tracking-ingest ──► shipments (tracking_number, po_numbers[], sources[])
  │     body text + digital PDF + scanned BOL vision OCR
  ├─ AP / paid invoice pipelines ──► vendor_invoices + invoices
  │     extract tracking from invoice PDF ──► shipments (source=ap_invoice|bol_pdf)
  └─ Active Purchases / Tracking Board
        join Finale POs ◄── shipments ◄── invoices/vendor_invoices
```

**Tech stack:** TypeScript, pdf-parse, existing `extractPDF` / `extractPDFWithLLM` (`src/lib/pdf/extractor.ts`), `shipment-intelligence.ts`, `active-purchases.ts`, `ActivePurchasesPanel.tsx`, `TrackingBoardPanel.tsx`.

**Non-goals:** Auto-send vendor replies (already draft-only). Rewrite Finale.

---

## Problem statements

### 1 — Scanned BOLs (LTL/FTL)
- Digital BOLs now partially covered via pdf-parse in tracking ingest.
- Scanned/image BOLs return empty pdf-parse text → tracking missed.
- LTL/FTL are few but high value; easy to identify (AAA Cooper, ODFL, Saia, Estes, PRO#, BOL).

### 2 — Invoice PDF tracking not linked to open PO
- Invoice body/PDF often has UPS/FedEx/PRO + PO#.
- If email body lacks PO, shipment rows become orphaned (`po_numbers=[]`).
- Need: extract tracking from invoice OCR text → upsert shipment with PO from invoice match → vendor_invoices row stays source of truth for $; shipments for movement.

### 3 — Active Purchases tracking UX is weak
- Panel already loads `shipments` + `invoiceStatus` per PO (`active-purchases.ts`).
- Correlation fails when: orphan shipments, weak evidence classification, UI doesn't show invoice↔tracking join, Tracking Board and Active Purchases tell different stories.
- Need one clear per-PO card: tracking (confirmed/candidate), ETA, invoice paid/unpaid/pending, link out.

---

## Workstream 1 — Scanned BOL vision OCR

**Files**
- Modify: `src/lib/tracking/email-tracking-ingest.ts`
- Modify: `src/lib/carriers/tracking-service.ts` (if BOL heuristics need LTL boost)
- Create: `src/lib/tracking/bol-ocr.ts` (thin wrapper)
- Test: `src/lib/tracking/bol-ocr.test.ts`, extend tracking-service tests

**Design**
1. After pdf-parse yields `< 40` non-whitespace chars OR filename matches `/\b(bol|b.?l|bill.?of.?lading|pro\b|ltl|ftl)\b/i`:
2. Call existing `extractPDF(buffer)` which already falls through to vision (`extractScannedPDF` / Gemini).
3. Prefer cheaper path: try pdf-parse first always; vision only when sparse + (BOL-like name OR LTL carrier in email subject/from/body).
4. Cap vision: max 1 vision OCR per email, max 3 pages equivalent (buffer already passed whole).
5. Tag source `email_ingest_bol_vision` when vision used.
6. LTL detect: if carrier is LTL and number is PRO-shaped, encode `AAA Cooper:::PRO`.

**Acceptance**
- Unit test: sparse PDF text + BOL filename triggers vision path (mock extractPDF).
- Unit test: dense digital PDF never calls vision.
- Real fixture text: `PRO NUMBER` / `Bill of Lading` still extracts without vision.

---

## Workstream 2 — Invoice PDF tracking → open PO → shipments

**Files**
- Modify: `src/lib/intelligence/workers/ap-local-forwarder.ts` (after OCR success)
- Modify: `src/lib/intelligence/workers/default-inbox-invoice.ts` OR nightshift path after paid invoice extract
- Create: `src/lib/tracking/invoice-tracking-bridge.ts`
- Modify: `src/lib/storage/vendor-invoices.ts` only if adding optional `tracking_numbers` column is required — prefer shipments table first (no migration if avoidable)
- Test: `src/lib/tracking/invoice-tracking-bridge.test.ts`

**Design**
```ts
// invoice-tracking-bridge.ts
export async function bridgeInvoiceTrackingToShipments(args: {
  ocrText: string;
  poNumber: string | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  source: "ap_invoice" | "default_paid_invoice" | "bol_pdf";
  sourceRef: string; // gmail id or vendor_invoice id
}): Promise<{ upserted: number; trackingNumbers: string[] }>
```

1. `extractTrackingNumbers(ocrText)` + LTL carrier detect from text.
2. Resolve PO:
   - Prefer `args.poNumber` from invoice parse
   - Else extract PO from OCR text
   - Else leave null (still store tracking; Active Purchases can show unlinked)
3. For each tracking hit: `upsertShipmentEvidence` with:
   - `source: args.source`
   - `poNumber`
   - `vendorName`
   - `confidence: po ? 0.92 : 0.75`
4. Call from:
   - AP local forwarder after successful OCR (unpaid path) — tracking still useful even when unpaid
   - default-inbox paid invoice success path after extraction
5. Do **not** require new DB tables. Use `shipments` as movement ledger; invoices stay money ledger.

**Acceptance**
- Test: OCR text with UPS + PO# → shipment upsert called with that PO.
- Test: OCR with tracking but no PO → upsert with null PO, confidence 0.75.
- Test: no tracking in OCR → no upsert.

---

## Workstream 3 — Active Purchases correlation UX + API

**Files**
- Modify: `src/lib/purchasing/active-purchases.ts`
- Modify: `src/components/dashboard/ActivePurchasesPanel.tsx`
- Modify: `src/app/api/dashboard/active-purchases/route.ts` (only if response shape changes)
- Optionally align: `src/lib/tracking/shipment-intelligence.ts` evidence rules for `ap_invoice` / `bol_pdf` / `email_ingest_pdf`
- Test: active-purchases unit tests if present; add `active-purchases.correlation.test.ts`

**Design — single story per PO**

Add computed field on `ActivePurchase`:

```ts
movement: {
  status: "none" | "candidate" | "in_transit" | "out_for_delivery" | "delivered" | "exception" | "stale";
  trackingNumbers: string[];      // confirmed first, then candidate
  primaryEta: string | null;
  primaryCarrier: string | null;
  primaryUrl: string | null;
  evidenceLevel: "confirmed" | "candidate" | "none";
  invoice: {
    state: "none" | "pending_ap" | "paid" | "matched" | "discrepancy";
    invoiceId?: string;
    hasTrackingFromInvoice: boolean;
  };
  correlation: {
    orphanTrackingCount: number; // global not needed per row
    poLinkedShipmentCount: number;
    lastSource: string | null; // email_ingest_pdf | ap_invoice | carrier_poll
  };
}
```

**UI (Active Purchases row/card)**
- Badge strip: `TRACK 1Z… · ETA mm/dd · INV paid|AP|none`
- Click tracking → open carrier URL
- If shipment evidence is candidate only, show amber "unconfirmed"
- If invoice has tracking but shipment missing PO link, show "invoice tracking needs link" (data should already be fixed by WS2; UI still shows invoice state)
- Empty state: "No tracking yet" + typical_tracking_source from vendor profile if present

**Evidence rules (shipment-intelligence)**
- Promote to confirmed when source in: `carrier_poll`, `carrier_api`, `ap_invoice`, `email_ingest_pdf`, `email_ingest_bol_vision`, `bol_pdf` AND has PO
- Candidate when: email_ingest without PO, or weak generic digits

**Acceptance**
- Unit: PO with confirmed shipment + paid invoice → movement.status in_transit/delivered + invoice.state paid
- Unit: PO with only candidate orphan-style → amber candidate
- Panel renders tracking + invoice badges without console errors
- Tracking Board remains; Active Purchases becomes the PO-centric story (don't delete Tracking Board)

---

## Shared conventions

1. **Never invent tracking numbers.** Extract only via `extractTrackingNumbers` / PRO patterns.
2. **LTL/FTL:** prefer PRO over BOL number for public URL when both present and LTL carrier detected.
3. **No auto-send** of vendor emails in these workstreams.
4. **Tests first** where pure functions; mock Gmail/PDF/DB at edges.
5. **Skip full typecheck** (OOM). Run:  
   `npx vitest run src/lib/tracking src/lib/carriers/tracking-service.test.ts src/lib/purchasing src/components/dashboard/ActivePurchasesPanel.tsx src/components/dashboard/TrackingBoardPanel.test.tsx`
6. **Do not commit** unless user asks.

---

## Delegation order

| Agent | Workstream | Depends on |
|-------|------------|------------|
| A | WS1 BOL vision | Independent |
| B | WS2 invoice→shipment bridge | Independent (can land with WS1) |
| C | WS3 Active Purchases UX | Prefers WS1+WS2 sources exist; can mock sources |

Dispatch A+B+C in parallel. C should tolerate missing new source tags and still improve join UI.

---

## Verification checklist (orchestrator)

1. `npx vitest run` on touched test globs — all green  
2. Grep that `extractPDF` is used from tracking ingest for sparse BOL PDFs  
3. Grep that `bridgeInvoiceTrackingToShipments` (or equivalent) called from AP + paid invoice paths  
4. Active Purchases type includes movement/correlation fields and panel displays them  
5. No new auto-send of Gmail replies introduced  
