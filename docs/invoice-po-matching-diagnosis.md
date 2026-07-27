# Invoice → PO Matching: Diagnosis & Proposed Flow

**Author:** Hermia · **Date:** 2026-07-27
**Question from Bill:** 767/999 `vendor_invoices` have no `po_number`. He expects PO-less
invoices to be "very, very rare" — usually credit-card purchases that land in
`bill.selee@` rather than `ap@`. So why is it 77%?

---

## 1. The 767 is misleading. The real number is 74.

Classified all 767 gaps (live queries, 2026-07-27):

| Bucket | Count | Verdict |
|---|---:|---|
| Freight / service vendors (FedEx, WWEX, AAA Cooper, Culligan, Ace Hardware, Logan Labs) | **255** | **Legitimately PO-less.** These are services, not purchased goods. Never had a PO. |
| Historical bulk backfill (created before 2026-04-01, mostly one March import of 788 rows) | **438** | Pre-dates the live pipeline. Low value to repair. |
| **Live pipeline, non-service, since 2026-04-01** | **74** | **The actual problem.** |

Bill's instinct was right. The live gap rate on real goods purchases is ~74 invoices over
~4 months, not 767. The headline number is inflated by service vendors and a one-time
import.

Gap rate on *all* post-April invoices: 125/210 (59.5%) — drops to 74 once service vendors
are excluded.

---

## 2. Root cause: vendor-name chaos, and an alias table nobody reads

`vendor_aliases` exists (32 rows, `finale_supplier_name` → `alias`) and is used by
`reconciler.ts`, `ap-agent.ts`, `po-sync.ts`.

**The receiving-panel matcher does not read it.** Zero references to `vendor_aliases` in
either `src/app/api/dashboard/receivings/route.ts` or
`src/lib/purchasing/invoice-po-matcher.ts`.

Measured impact: **30 of the 74 live gaps (41%) have a vendor name that is an exact
match for an existing `vendor_aliases.alias` row.** They would resolve immediately if the
matcher consulted the alias table.

The name variance is severe because names come from OCR:

```
AAA COOPER
AAA Cooper Transportation
AAA COOPER TRANSPORTATION
AAA COOPER TRANSPORTION™          <- OCR typo + trademark glyph
"AAA COOPER\r\nTRANSPORTATION™"   <- embedded CRLF from PDF line wrap
```

And invoice-name ≠ Finale-supplier-name even when clean:

| Invoice vendor (OCR) | Finale supplier |
|---|---|
| AutoPot USA | Autopot Watering Systems |

One invoice row even has `vendor_name = ''` (empty string).

---

## 3. Second limitation: the matcher only looks at *recently received* POs

`receivings/route.ts:190-203`:

```ts
const vendorNames = [...new Set(received.map(r => r.supplier))];   // receipts in window
const { data } = await sb.from('vendor_invoices')
    .select(...)
    .is('po_number', null)
    .in('vendor_name', vendorNames)      // <-- gate
    .limit(20);
```

Consequences:
- An unmatched invoice is only ever surfaced if that vendor **also** has a PO receipt in
  the current window. Invoice arrives before/after the receipt window → invisible forever.
- `.in('vendor_name', ...)` is an **exact** string match, so every OCR variant above misses.
- `.limit(20)` then `.slice(0, 12)` caps work per poll; a backlog can never drain.
- `.is('po_number', null)` misses rows where `po_number = ''` (empty string, not NULL).

So the panel is a *receipt-driven* view, not an *invoice-driven* worklist. There is no
surface that answers "which invoices are still unmatched?" independent of receiving.

---

## 4. Bill's credit-card hypothesis: correct, but provenance is being lost

Invoices carry no inbox column. Provenance is only recoverable by joining
`vendor_invoices.source_ref` → `ap_inbox_queue.message_id` / `email_inbox_queue.gmail_message_id`.

For the 125 post-April gaps:
- 4 have `source_ref IS NULL`
- **58 have a `source_ref` that joins to neither queue** (orphaned reference)
- the rest join to `ap_inbox_queue`, all with `source_inbox = 'ap'`

**We currently cannot tell which invoices arrived via `bill.selee@` vs `ap@`.**
`email_inbox_queue` does track `source_inbox` (1,292 default / 187 ap), but that linkage is
broken for most invoices. Bill's rule — "CC purchases come to bill.selee@" — is exactly the
signal needed to auto-classify an invoice as *expected to have no PO*, and it is being
discarded.

---

## 5. Recommendation

### 5.1 Wire the alias table into matching (highest value, lowest risk)
Add vendor-name normalization to `invoice-po-matcher.ts`:
1. Strip `\r\n`, collapse whitespace, strip `™®©`, trim, uppercase.
2. Resolve through `vendor_aliases.alias → finale_supplier_name`.
3. Fall back to token-prefix fuzzy match (already partly present via `extractSearchTerms`).

Closes ~30 of 74 immediately. Also fixes the `.in()` exact-match gate.

### 5.2 Persist inbox provenance on the invoice
Add `source_inbox TEXT` to `vendor_invoices`, populated at ingest from the queue row.
Then:
- `ap@` + no PO after N days → **exception, needs matching**
- `bill.selee@` + no PO → **likely credit-card, expected**; auto-tag `no_po_expected`

This turns Bill's mental rule into a machine-checkable one and stops CC purchases from
polluting the exception list. Also fix whatever is orphaning `source_ref` for 58 rows.

### 5.3 Classify service vendors once
Add a `vendor_profiles.requires_po BOOLEAN` (or reuse existing profile flags). Freight and
utility vendors get `false` and never appear as exceptions. Removes 255 permanent
false positives.

### 5.4 Do NOT build a new panel — the surface already exists (corrected 2026-07-27)

My original recommendation was to add a new "Unmatched Invoices" panel. **That was wrong.**
Inspecting the dashboard first showed the surface already exists and is already wired
end-to-end:

- `src/components/dashboard/InvoiceQueuePanel.tsx` (599 lines) already has an `unmatched`
  status in `StatusKey` / `STATUS_CFG`, rendered as a rose **"NO PO"** badge — matching
  Bill's convention of rose = exception.
- `src/app/api/dashboard/invoice-queue/route.ts` already emits those rows and a
  `stats.unmatched` counter.
- Live check: `curl /api/dashboard/invoice-queue` → `stats.unmatched = 64`, 65 invoices
  returned. It is already working and visible today.

So step 4 is not "build a panel". It is three much smaller changes.

#### 5.4a Fix the false-positive bug first (highest priority of the whole plan)

`resolveStatus()` in `invoice-queue/route.ts:88-110` never inspects `po_number`. Its final
line is an unconditional `return 'unmatched'`, so any unrecognised `status` value is
labelled "NO PO".

Every invoice in the last 60 days has `status='received'`, which matches none of the
branches. Measured:

```
SELECT status, COUNT(*) n, COUNT(*) FILTER (WHERE COALESCE(po_number,'')<>'') has_po
  FROM vendor_invoices WHERE created_at >= now() - interval '60 days' GROUP BY 1;
-> received | 69 | 35
```

**35 of the 64 rows shown as "NO PO" actually have a `po_number`.** Concrete example:
Marion Ag Service invoice `85974` has `po_number='124977'` and is still displayed as
unmatched.

The dashboard therefore over-reports the problem by roughly 2×, which buries the real
exceptions in noise. Fixing this costs a few lines and immediately halves the list —
worth doing before any matching improvement, because otherwise the improvement is
invisible under the false positives.

Note the distinct status: `po_number` set but `reconciled_at IS NULL` means *matched to a
PO but not yet reconciled*. That is neither "done" nor "NO PO" and deserves its own
treatment (either `needs_approval` or a new badge).

#### 5.4b Add the terminal "not a PO purchase" action

Still genuinely missing. Without it the list can only grow — there is no way to record
"this was a credit-card purchase, it will never have a PO". Combined with §5.2's
`source_inbox`, a one-click "Not a PO purchase" on a `bill.selee@` invoice is the exact
flow Bill described.

#### 5.4c Filter by `requires_po`

Once §5.3 lands, the queue should exclude vendors flagged `requires_po = false` so the 255
freight/utility invoices stop appearing at all.


### 5.5 Normalize at write time, not just read time
OCR-extracted `vendor_name` should be normalized before insert (the `\r\n` and `™` cases
are write-side defects). Also: 175 gap rows have `raw_data->>'poNumber'` populated while
`po_number` is empty — the parser found *something* and the writer dropped it. Worth
checking that path, **but note** those values are mostly FedEx sales-order numbers
(`2332xxxx`), not Finale POs — 0 of 93 matched `purchase_orders`. So promote them as
*candidates for review*, never as confirmed matches.

---

## 6. Sequence

1. Vendor-name normalization + alias resolution in the matcher (§5.1) — closes ~41%.
2. `source_inbox` on `vendor_invoices` + fix orphaned `source_ref` (§5.2).
3. `requires_po` vendor flag (§5.3) — removes 255 false positives.
4. Unmatched-invoice worklist panel with a terminal "not a PO purchase" action (§5.4).
5. Write-time normalization + OCR candidate review (§5.5).

Steps 1–3 are data/logic work with measurable before/after counts. Step 4 is the UI change
that makes this self-service from the dashboard.
