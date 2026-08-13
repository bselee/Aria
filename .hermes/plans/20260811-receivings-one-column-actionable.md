# Receivings: One Clean Expandable Column — Implementation Plan

> **For Hermes:** Dispatch workers via kanban; each task has full context.

**Goal:** Replace the confusing split-panel Receivings UI with one clean expandable list that gives Complete feedback and links invoice PDF copies (hover preview on discrepancy).

**Architecture:** Single scrollable column of actionable rows. Each row = one decision (match invoice, review variance, or complete PO). Expand inline for detail. No nested left/right panels. PDF served from existing `downloadPDF()` via a thin GET route keyed on `vendor_invoices.id`.

**Tech Stack:** Next.js 14, React, Tailwind, existing receivings API enrichment (`_reconciliation.variance`), `src/lib/storage/supabase-storage.ts` `downloadPDF`.

**Bill requirements (2026-08-11, verbatim):**
1. "no feedback for complete PO"
2. "Do not like split column please just integrate into one clean column expandable lines simple expandable, actionable."
3. "we already get invoices. download them and reference the copies of invoices via link? popup on hover when discrepancy?"
4. PDF storage/link scope = **list B only** (not all vendors).

### Vendor allowlist (LOCKED 2026-08-11 — Bill chose B)

Receivings PDF **write + serve + UI link/hover** only for these vendors
(case-insensitive match on vendor_name / supplier; normalize spaces/underscores):

| Canonical | Aliases to accept |
|-----------|-------------------|
| Rootwise Soil Dynamics | Rootwise |
| American Extracts | American Extracts |
| Grassroots Fabric Pots | Grassroots Fabric Pots Inc. |
| Malibu Compost | Malibu |
| Lind Marine | Lind Marine, INC · LindMarine |
| Uline | ULINE · Uline.com |
| Axiom Print | Axiom |

**Rules:**
- `uploadPDF` for receivings-relevant AP paths: still OK to write others for AP ops,
  but **Receivings panel only offers PDF** when vendor ∈ allowlist AND file exists on disk.
- PDF serve route: allow if path is under `local/storage` AND vendor folder/name matches allowlist
  (or invoice row's vendor_name matches). Deny/404 otherwise — no open proxy.
- Do **not** bulk-repair the 164 legacy `msgId/timestamp_*.pdf` orphans unless vendor ∈ allowlist.
- Skip junk folders: `error`, `From`, `Start_of_OCR*`, pure carrier archives (AAA Cooper) for this feature.
- Config home: prefer `src/config/receivings-pdf-vendors.ts` (export `RECEIVINGS_PDF_VENDORS` + `isReceivingsPdfVendor(name)`).

**Storage path (unchanged layout):**
`local/storage/INVOICE/{Vendor}/{YYYY-MM-DD}/{invoice#}.pdf`
Root: `C:\Users\BuildASoil\Documents\Projects\aria\local\storage\`

**Constraints (dashboard-panel-ux skill):**
- Lifecycle = left→right columns (~1/3 width). Nested split panels fail here (Pattern D rejected 2026-08-03).
- Never unmount painted data for reload (Pattern A/B).
- Clean match = one green line; differs = expandable detail (Pattern I).
- Variance buckets already exist on API: `rec.variance` (freight/tax/fee/sku/unexplained).

---

## Target UX (one column)

```
RECEIVINGS · 7 action · 54 settled
─────────────────────────────────────
▸ ⚠️ PO 125051 Am.Extracts  Inv#SF4474  +$6,237  [Unknown SKU]  [PDF]
▾ ⚠️ PO 125138 Grassroots   Inv#32654   +$221.60 [Unexplained]  [PDF]
    PO goods $2,013 · Invoice $2,235 · Frt on PO $220
    • Unexplained +$221.60 — goods differ; invoice has no lines
    [Open Finale]              [Apply & Complete]
▸ ✅ PO 125080 Rootwise matched Inv#300047… — ready  [Complete]
▸ 🔍 Inv Grassroots $522 → suggest PO 32751          [Match]
```

**Row types (one list, sorted action-first):**
| Priority | Type | Collapsed | Expand | Primary action |
|---|---|---|---|---|
| 1 | `review` | ⚠️ PO + Inv + net$ + kind chips + PDF link | variance items + money row | Apply & Complete |
| 2 | `ready` | ✅ PO matched Inv# — ready | (none needed) | Complete |
| 3 | `match` | 🔍 Inv# vendor $ → top PO candidate | candidates list | Match / Manual |
| 4 | settled | hidden by default; "Show settled" toggle | — | — |

---

### Task 0: Vendor allowlist config (do first)

**Assignee:** `aria-coder`
**Objective:** Single source of truth for which vendors get Receivings PDF links.

**Files:**
- Create: `src/config/receivings-pdf-vendors.ts`

```ts
/** Bill 2026-08-11 list B — Receivings PDF link/hover scope only. */
export const RECEIVINGS_PDF_VENDORS = [
  "rootwise",
  "american extracts",
  "grassroots",
  "malibu",
  "lind marine",
  "lindmarine",
  "uline",
  "axiom",
] as const;

export function isReceivingsPdfVendor(name: string | null | undefined): boolean {
  const n = (name || "").toLowerCase().replace(/[_\s.]+/g, " ").trim();
  if (!n) return false;
  return RECEIVINGS_PDF_VENDORS.some((v) => n.includes(v));
}
```

**Commit:** `feat(config): receivings PDF vendor allowlist (list B)`

---

### Task 1: Invoice PDF serve route

**Assignee:** `aria-coder`  
**Depends:** Task 0  
**Objective:** GET endpoint that returns the stored invoice PDF bytes so the UI can link/preview it.

**Files:**
- Create: `src/app/api/storage/invoice-pdf/route.ts`
- Reuse: `downloadPDF` from `src/lib/storage/supabase-storage.ts`
- Gate: `isReceivingsPdfVendor` from `src/config/receivings-pdf-vendors.ts`
- Data: `vendor_invoices.id`, `vendor_name`, `pdf_storage_path`, `invoice_number`

**Steps:**
1. Accept query `?id=<vendor_invoices.id>` (UUID preferred) OR `?invoice=<invoice_number>` (fallback).
2. Look up row via PostgREST `createClient()` from `@/lib/db`:
   ```ts
   .from("vendor_invoices").select("id, invoice_number, vendor_name, pdf_storage_path").eq("id", id).maybeSingle()
   ```
3. If vendor not `isReceivingsPdfVendor(vendor_name)` → **403** `{ error: "vendor not in receivings pdf allowlist" }`.
4. If no `pdf_storage_path` → 404 JSON `{ error: "no pdf on file" }`.
5. Reject paths that escape `local/storage` (no `..`, must resolve under storage root).
6. `const buf = await downloadPDF(path)`; if null → 404.
7. Return `new NextResponse(buf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=\"inv-{number}.pdf\"", "Cache-Control": "private, max-age=300" } })`.

**Verify:**
```bash
curl -s "http://localhost:5434/vendor_invoices?pdf_storage_path=like.local/storage*&select=id,vendor_name,pdf_storage_path&limit=5"
curl -sI "http://localhost:3001/api/storage/invoice-pdf?id=<uuid-allowlisted>"
# expect: HTTP 200, content-type application/pdf
# non-allowlist vendor → 403
```

**Commit:** `feat(api): serve vendor invoice PDF by id (allowlist B)`

---

### Task 2: API — ensure PDF fields + id on matched invoices and suggestions

**Assignee:** `aria-coder`  
**Depends:** Task 0  
**Objective:** Every matched invoice and match suggestion carries `id` + `pdf_storage_path` so the UI can build PDF links without a second lookup. UI only renders link when allowlist + path present.

**Files:**
- Modify: `src/app/api/dashboard/receivings/route.ts`
  - GET already selects `id, pdf_storage_path` on vendor_invoices for matched invoices (~line 223) — confirm these are forwarded into `_reconciliation.matchedInvoice` (not stripped).
  - Also ensure `vendor_name` is on matchedInvoice if missing.
  - Match suggestions block: include `id` and `pdf_storage_path` / `pdfStoragePath` on each suggestion object.
  - Optional helper flag: `pdfAvailable: boolean` = path present && isReceivingsPdfVendor(vendor).

**Steps:**
1. Grep payload: after `curl .../receivings?bust=1`, assert at least one allowlisted `matchedInvoice.id` and path when on file.
2. If stripped when building `_reconciliation`, stop stripping — pass full invoice row fields through.
3. Suggestions shape:
   ```ts
   { invoiceId, invoiceNumber, vendorName, invoiceTotal, invoiceDate,
     pdfStoragePath, // NEW
     pdfAvailable,   // NEW optional
     candidates: [...], ... }
   ```

**Verify:**
```bash
curl -s "http://localhost:3001/api/dashboard/receivings?bust=1" | python -c "
import sys,json
d=json.load(sys.stdin)
for po in d['received']:
  m=(po.get('_reconciliation') or {}).get('matchedInvoice')
  if m: print(po['orderId'], m.get('invoice_number'), m.get('id'), bool(m.get('pdf_storage_path')))
for s in d.get('matchSuggestions') or []:
  print('sug', s.get('invoiceNumber'), s.get('invoiceId'), bool(s.get('pdfStoragePath') or s.get('pdf_storage_path')))
"
```

**Commit:** `fix(api): pass invoice id + pdf_storage_path through receivings GET`

---

### Task 3: UI — replace split matcher with one expandable action list

**Assignee:** `aria-dashboard`  
**Depends:** T1, T2  
**Objective:** Kill the visual split. One column of expandable actionable rows. Complete gives visible feedback. PDF link/hover only for allowlist B when file exists.

**Files:**
- Modify heavily: `src/components/dashboard/ReceivedItemsPanel.tsx`
- Soft-deprecate / stop rendering: `src/components/dashboard/InvoicePOMatcher.tsx` (do not delete yet — just stop importing; leave file for one release)
- Keep using existing: `MatchComparisonView` logic / `rec.variance` / `handleCompletePO` / `handleMatchInvoice`
- Optional client check: import `isReceivingsPdfVendor` if vendor name is on the row (or trust `pdfAvailable` from API)

**Steps:**

#### 3a. Complete feedback
Replace silent success in `handleCompletePO`:
```ts
const [actionToast, setActionToast] = useState<{ kind: "ok"|"err"|"block"; text: string } | null>(null);
// on success:
setActionToast({ kind: "ok", text: `PO ${orderId} completed in Finale` });
// remove PO from list immediately (optimistic) then fetchReceivings(true)
// on 409:
setActionToast({ kind: "block", text: json.detail || "3-way gate refused" });
// on error:
setActionToast({ kind: "err", text: e.message });
// auto-clear toast after 5s
```
Render toast sticky at top of panel body (not console-only).

Also track `completingId: string | null` — button shows "Completing…" and disables while in flight.

#### 3b. Build unified row model
```ts
type ActionRow =
  | { kind: "review"; po: ReceivedPO; inv: MatchedInv; variance: VarianceSummary }
  | { kind: "ready";  po: ReceivedPO; inv: MatchedInv }
  | { kind: "match";  suggestion: MatchSuggestion };

// Sort: review (blocking first) → ready → match
// Exclude DropshipPO candidates (existing filter)
// Exclude rows with no action (no invoice, clean freight-only already settled if product wants hide — keep ready visible)
```

#### 3c. Render one list (NO InvoicePOMatcher)
- Remove `<InvoicePOMatcher .../>` and the "▶ Received POs" secondary toggle that hid the real list.
- Remove the dual-column feel: no left invoices / right POs.
- Each row:
  - Click header toggles `expandedId === rowKey`
  - PDF **only if** allowlist vendor and path (or `pdfAvailable`):
    ```tsx
    <a href={`/api/storage/invoice-pdf?id=${id}`} target="_blank" rel="noreferrer"
       className="text-blue-400 underline" onClick={e => e.stopPropagation()}>PDF</a>
    ```
  - Hover preview on **discrepancy (review) rows only**:
    ```tsx
    <span className="relative group">
      <a ...>PDF</a>
      <span className="pointer-events-none absolute z-50 hidden group-hover:block ...">
        <iframe src={`/api/storage/invoice-pdf?id=${id}#page=1`} className="w-[280px] h-[360px] border border-zinc-700 rounded shadow-xl bg-zinc-950" />
      </span>
    </span>
    ```
    Keep preview lightweight: only mount iframe while hovering (state `hoverPdfId`) so N rows don't open N PDFs.
  - No path / not allowlist → **omit PDF control** (no dead link).

#### 3d. Expand bodies
- `review`: reuse variance item list + money row + Apply & Complete + Finale link (from current MatchComparisonView differs branch). Pass `onComplete` with toast wiring.
- `ready`: no expand needed; Complete button on the row itself.
- `match`: show top 3 candidates as simple lines `PO# vendor $score%` + Match button; manual PO input stays one line under expand.

#### 3e. Filters / chrome
- Keep header chips: N action / N ready (derived from ActionRow counts).
- Drop "Check Match Status" dead-end block if it still adds noise (optional; if unsure leave collapsed).
- `showAllReceived` only for true settled dump — not the default path.

**Verify (manual + curl):**
1. `npm run build` passes.
2. Hard refresh dashboard → Receivings is ONE scroll list (no side-by-side matcher).
3. Click Complete on a ready PO → green toast "PO #### completed", row disappears.
4. Hover PDF on a review row (allowlist vendor with file) → iframe preview; click opens full PDF.
5. Non-allowlist / missing file → no PDF control.
6. Expand a variance row → chips + messages + action buttons only (no nested columns).

**Commit:** `feat(ui): one-column expandable receivings with complete toast + invoice PDF hover`

---

### Task 4: Verify end-to-end

**Assignee:** `aria-reviewer`  
**Depends:** T0, T1, T2, T3  

**Checklist:**
- [ ] Build clean
- [ ] Allowlist config exists and matches Bill list B
- [ ] PDF route 200 for allowlisted vendor with file; 403 non-allowlist; 404 missing
- [ ] GET receivings payload has id + pdf_storage_path
- [ ] No InvoicePOMatcher in rendered tree (grep / browser)
- [ ] Complete PO shows toast and removes/refreshes row
- [ ] 409 gate still surfaces as block toast
- [ ] Expand/collapse works; no double-fetch thrash on hover (Pattern B)
- [ ] Narrow column (~1/3 width) still readable
- [ ] PDF UI only for list B vendors

**Commit:** none (review only). Comment findings on parent task.

---

## Out of scope (do not do)
- Re-OCR invoices missing line items
- SKU alias auto-map TX7101 ↔ TX70-CaseQt (separate task)
- Live Finale freight re-fetch per row
- Deleting InvoicePOMatcher.tsx file
- Changing Lifecycle 3-column layout
- Bulk Gmail re-download of all historical PDFs
- AAA Cooper / pure carrier PDF management in Receivings
- Expanding allowlist beyond list B without Bill

## Success criteria (Bill)
1. Completing a PO is visibly acknowledged.
2. Receivings reads as one simple expandable list — not two panels.
3. Invoice PDF is one click away for **list B vendors**; hover shows a preview when reviewing a discrepancy.
4. No PDF noise for vendors outside the allowlist.
