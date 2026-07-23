# Assessment — The "freight won't apply" problem is a symptom of an unfinished repo-wide refactor

**Author:** Hermia
**Date:** 2026-07-23
**Prepared for:** Bill Selee
**Status:** Diagnosis only — NO code changed to produce this doc.

---

## 1. TL;DR

Freight extraction and application to POs is *not* the hard part. The data is already
captured and the correlation already exists in the DB. The reason it keeps feeling
impossible to get right is that **the code that applies freight correctly cannot run** —
it throws `supabase is not defined` at runtime.

A global refactor from a shared `supabase` client to a per-call `createClient()` (aliased
`db` / `sb`) was **started and never finished**. It left **289 undefined-variable errors
across 69 files**, including the core Accounts-Payable reconciliation engine.

Yesterday's `pushInvoiceFreightToFinale` was written as a workaround *around* that dead
code — which is why we keep bolting guards onto it that the real engine already has.

**You cannot make freight bulletproof on top of a foundation that throws.** Fix the
foundation first.

---

## 2. What actually happens to freight today (the data IS there)

| Stage | Where | Status |
|-------|-------|--------|
| OCR extracts freight from invoice PDF | `invoice-parser.ts`, `invoice-field-normalize.ts` | ✅ works |
| Freight written to `vendor_invoices.freight` (PostgREST) | `ap-local-forwarder.ts:430` | ✅ works |
| Freight mirrored to `invoice_cache.freight` (SQLite) | `ap-local-forwarder.ts:387` | ✅ works |
| Invoice correlated to PO (`po_number` set) | `invoice-po-matcher.ts` | ✅ works |
| **Freight applied to the Finale PO** | `reconciler.ts` via `po-sweep.ts` | ❌ **DEAD — throws at runtime** |

The correlation is in the DB. The freight is in the DB. The apply step is broken.

---

## 3. The three overlapping systems (why it's confusing)

There are **three** matcher/apply systems that all touch the same Finale freight field:

1. **`reconciler.ts` — `reconcileInvoiceToPO()`** (mature, ~3000 lines). The correct engine.
   Delta-based fee application, duplicate detection, balance validation, derived-freight
   fallback, vendor fee-label learning (Pinecone), disproportion guards, per-fee dollar
   caps, Telegram approval, full audit trail.
2. **`po-sweep.ts` — `runPOSweep()`.** PO-first batch sweep that finds matches and routes
   them into `reconcileInvoiceToPO`. This is the *right* pattern — **but it references a
   bare `supabase` (lines 30, 48) that is never defined.** It throws the moment it runs.
3. **`invoice-po-matcher.ts` + `pushInvoiceFreightToFinale()`** (yesterday). A workaround.
   Re-implements matching AND freight push with *none* of System 1's guards. This is the
   file we've spent three rounds patching (vendor gate, idempotency, don't-clobber) —
   every "fix" is a feature System 1 already shipped.

**System 3 exists only because Systems 1 & 2 are broken.** Remove the breakage and
System 3 should be deleted, not maintained.

---

## 4. Root cause: unfinished `supabase` -> `createClient()` refactor

`src/lib/db.ts` exports **only** `createClient()` (line 550). There is no exported shared
`supabase` singleton anymore. But 69 files still reference a bare `supabase` (or `db`)
identifier in one or more function scopes.

Typical failure shape (confirmed in `reconciler.ts`, `po-sweep.ts`, `reconciliation-action/route.ts`):
the file correctly does `import { createClient } from "@/lib/db"` and even assigns
`const db = createClient()` inside *some* functions — but *other* functions in the same
file were never updated and still say `await supabase.from(...)`. Half-renamed.

**Scale:** 289 `Cannot find name 'supabase' | 'db'` errors, 69 files. AP/freight-critical
files in the blast radius:

- `src/lib/matching/po-sweep.ts`  ← the good freight sweep
- `src/lib/finale/reconciler.ts`  ← the mature engine (8 bare refs)
- `src/app/api/dashboard/reconciliation-action/route.ts`  ← dashboard approve/reject
- `src/lib/intelligence/ap-agent.ts`
- `src/lib/gmail/attachment-handler.ts`
- `src/lib/intelligence/po-correlator.ts`
- ...plus 63 more across dashboard routes, CLIs, crons, watchers.

---

## 5. Why the build never caught this

- Memory/standing note: **"Skip typecheck (OOMs)"**. `ship:bot` and `ship:dashboard` do
  **not** run `tsc`. They restart PM2 / run `next build` (which type-checks pages but not
  every lib path the same way) + a smoke test.
- `tsx` and Next dev transpile per-file **without** full type-checking, so a bare
  `supabase` compiles and only explodes at runtime when that function is actually invoked.
- Result: the errors ship silently and surface as runtime crashes — e.g. the **aria-bot
  16 restarts** (the `db is not defined` observation from the 2026-07-22 scrutiny is this
  same bug) and freight silently never applying.

---

## 6. The fix (mechanical, low-intelligence, high-verification)

Per broken scope: assign a client once and use it.

```ts
// at the top of each function that references a bare `supabase`:
const supabase = createClient();
if (!supabase) return; // or the file's existing null-guard convention
```

Some files already import `createClient` and just need the missing assignment; a few need
the import added. No logic changes — this is a rename-completion, not a redesign.

**Recommended order:**
1. Fix the AP/freight-critical files (Section 4 list) first.
2. Verify `po-sweep` + `reconcileInvoiceToPO` run clean against one real invoice
   (freight lands as a delta, dupe guard fires on re-run).
3. **Then** delete `pushInvoiceFreightToFinale` + the hardcoded Marion/Farm Fuel/Seacoast
   list, and route the auto-matcher into `reconcileInvoiceToPO`.
4. Fix the remaining 63 files (dashboard routes, CLIs, crons, watchers).
5. Add a `tsc --noEmit` ship-gate (with `--incremental` or a Node `--max-old-space-size`
   bump to dodge the OOM) so this class of bug can never ship silently again.

**Execution:** Steps 1 and 4 are ideal for parallel subagents with per-file `tsc`
verification. Step 3 is the only judgement step and should be reviewed by a human first
(it changes what writes to Finale).

---

## 7. What "bulletproof" looks like when done

- **One** freight/fee apply path: `reconcileInvoiceToPO` -> `applyReconciliation`, whether
  the invoice was matched by a human or by cron.
- No hardcoded vendor freight list — the engine reads the PO's *actual* existing freight
  and applies a **delta**, so a vendor who bakes freight into line items yields a $0 delta
  and nothing double-counts. (This is why the Marion/Farm Fuel/Seacoast gate becomes
  unnecessary.)
- Duplicate invoices are caught by the engine's Guard 0, not by last-writer-wins.
- Every Finale write is audited and, above the per-fee cap, gated behind Telegram approval.
- `tsc` runs in CI/ship so undefined-variable regressions are impossible to ship silently.

---

## 8. Risk if we do nothing

- Freight continues to not apply through the real engine; the workaround stays and rots.
- The bot keeps crash-looping on `db is not defined` in whichever code path hits a broken
  file, inflating restart counts and risking missed AP automation runs.
- Any dashboard route / CLI in the 69-file list is a latent runtime 500 waiting for the
  first user who exercises that path.
- COGS/GL correctness depends on freight landing correctly — this is an accounting-grade
  risk, not a cosmetic one.
