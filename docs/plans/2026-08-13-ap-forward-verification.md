# AP Forwarding Reliability — Implementation Plan

> **For Hermes:** Execute via subagent-driven-development, one subagent per workstream.

**Goal:** Close the loop between "Aria forwarded a PDF" and "Bill.com actually has the bill," and repair the dedup safety net that has been silently dead since 2026-07-05.

**Architecture:** The forward path (`forwardInvoiceOnce`) is already atomic and correct. The failures are all *downstream of the send*: nothing confirms Bill.com received the bill, and the `billcom_bills_ref` table that powers duplicate detection stopped refreshing. Four independent workstreams, no shared files.

**Tech Stack:** TypeScript, better-sqlite3 (`aria-local.db`), vitest, PM2 (`aria-bot`), Playwright (bill.com download).

---

## Verified Baseline (facts, measured 2026-08-13)

| Fact | Evidence |
|---|---|
| `billcom_bills_ref` stale 5 weeks | `MAX(imported_at)` = `2026-07-05 13:00:42`, 102 rows |
| `data/AllBillsPage.csv` missing | `data/` holds only `billcom-error.png` (Aug 13 07:00 — today's failed run) |
| `verified` column is dead | `SELECT verified, COUNT(*)` → `(0, 361)` — nothing ever sets it to 1 |
| `verifySentForward()` never called | defined in `ap-local-forwarder.ts`, zero call sites |
| Forward volume | `ap_local_forwards`: 274 FORWARDED, 87 SKIPPED |
| Bill's real CSVs land in Downloads | `~/Downloads/AllBillsPage (16).csv` etc. |
| Cron exists but fails silently | `billcom-ref-import`, `0 7 * * *`, `onFail: "log"` |

**Key paths:**
- `src/lib/intelligence/workers/ap-local-forwarder.ts` (1540 lines) — scan/classify/forward orchestrator
- `src/lib/intelligence/ap-single-forward.ts` (~600 lines) — atomic claim gate, `isAlreadyClaimedOrForwarded`
- `src/lib/intelligence/ap-dedup.ts` (178 lines) — `isDuplicate`, `isAlreadyForwarded`
- `src/lib/intelligence/ap/vendor-router.ts` (185 lines) — routing rules
- `src/cli/import-billcom-ref.ts`, `src/cli/download-billcom-ref.ts`
- `src/cron/jobs/index.ts` — `defineJob` registry

**Verify commands (this repo):**
- `npx vitest run <path>` — targeted tests
- `npm test` — full suite
- **DO NOT run `npm run typecheck`** — allocates 12GB and OOMs this box. Rely on vitest + targeted `npx tsc --noEmit` greps only.

---

## Workstream A — Forward→Bill.com Verification Sweep (CRITICAL)

**Problem:** `forwardInvoiceOnce` marks `FORWARDED` the instant Gmail accepts the message. Nobody ever confirms Bill.com parsed it into a bill. AAA Cooper statements read as "successfully forwarded" for weeks while Bill.com silently ignored them.

**Objective:** Reconcile `ap_local_forwards` (FORWARDED) against `billcom_bills_ref` (what Bill.com actually has) and surface anything that never landed.

**Files:**
- Create: `src/lib/intelligence/ap/billcom-verify.ts`
- Create: `src/lib/intelligence/ap/billcom-verify.test.ts`
- Modify: `src/cron/jobs/index.ts` (add one `defineJob`)

**Contract:**
```ts
export interface ForwardVerificationRow {
  id: number;
  vendorName: string | null;
  invoiceNumber: string | null;
  pdfFilename: string;
  emailSubject: string;
  forwardedAt: string;
  ageHours: number;
  matchReason: string | null;  // how it matched, when verified
}

export interface VerificationSweepResult {
  checked: number;
  verified: number;      // newly confirmed present in Bill.com
  alreadyVerified: number;
  unconfirmed: ForwardVerificationRow[];  // forwarded, NOT in Bill.com, past grace
  refStale: boolean;     // billcom_bills_ref older than staleHours
  refAgeHours: number | null;
}

export function runForwardVerificationSweep(opts?: {
  graceHours?: number;   // default 24 — don't flag before Bill.com has had time
  lookbackDays?: number; // default 45
  staleHours?: number;   // default 36 — ref data older than this = can't trust
}): VerificationSweepResult;
```

**Matching rules (in order):**
1. Exact: `LOWER(vendor_name)` + `invoice_number` equal.
2. Normalized invoice#: strip non-digits, strip leading zeros, compare (handles `01159492` vs `1159492`).
3. Amount+date fallback when invoice# is absent: `ocr_total` within `$0.02` AND invoice date within ±14 days.

**Hard requirements:**
- On match → `UPDATE ap_local_forwards SET verified = 1` (finally activates the dead column).
- **Never** flag `unconfirmed` when `refStale` is true — stale reference data would produce a wall of false positives. Return `refStale: true` and an empty `unconfirmed` list instead, and say so in the report.
- Respect `graceHours`: a forward from 20 minutes ago is not a failure.
- Read-only against `billcom_bills_ref`. Only write is `verified` on `ap_local_forwards`.
- Never throw. Wrap DB access; return a zeroed result on failure.

**Cron job to add** (mirror the style of neighbouring `defineJob` blocks):
```
name: "ap-forward-verification"
schedule: "0 9 * * *"     // 9 AM MT, after the 7 AM ref import
onFail: "log"
description: "Reconcile forwarded invoices against billcom_bills_ref; alert on any that never landed in Bill.com."
```
Handler: run the sweep; if `refStale` → log a clear warning naming the stale age and skip alerting; else if `unconfirmed.length > 0` → send ONE consolidated Telegram message via `sendTelegramNotify` from `@/lib/intelligence/telegram-notify` (dynamic `await import`, wrapped in try/catch, matching how other jobs in this file do it). One message listing all items — never one per item.

**Tests (vitest, in-memory better-sqlite3 with `vi.mock("@/lib/storage/local-db")` — copy the mock pattern from `src/lib/intelligence/ap-single-forward.test.ts`):**
1. Exact vendor+invoice# match → `verified` incremented AND row's `verified` column is now 1.
2. Normalized match: forward `invoice_number = "0064058411"` vs ref `"64058411"` → verified.
3. Forwarded, absent from ref, age > graceHours → appears in `unconfirmed`.
4. Forwarded, absent from ref, age < graceHours → NOT in `unconfirmed`.
5. `billcom_bills_ref` empty or `imported_at` older than staleHours → `refStale: true` and `unconfirmed` is empty.
6. Amount+date fallback matches when invoice# is null on both sides.
7. Already-verified rows counted in `alreadyVerified`, not re-processed.

---

## Workstream B — Repair the billcom_bills_ref Ingest (CRITICAL)

**Problem:** The daily cron's Playwright download fails (today's `data/billcom-error.png` proves it), `data/AllBillsPage.csv` never appears, the import step exits 1, and the table has been frozen for 5 weeks. Because `onFail: "log"`, nobody was told. Meanwhile Bill exports CSVs by hand into `~/Downloads`.

**Objective:** Make the ingest survive Playwright failure by falling back to the newest manual export, and make staleness loud instead of silent.

**Files:**
- Create: `src/lib/intelligence/ap/billcom-csv-source.ts`
- Create: `src/lib/intelligence/ap/billcom-csv-source.test.ts`
- Modify: `src/cli/import-billcom-ref.ts` (resolution + staleness only — do NOT touch the CSV parser or the UPSERT, they work)

**Contract:**
```ts
export interface CsvSourceResolution {
  path: string | null;
  source: "playwright" | "downloads" | "none";
  mtime: string | null;   // ISO
  ageHours: number | null;
}

/**
 * Resolve the freshest usable Bill.com All-Bills CSV.
 * 1. data/AllBillsPage.csv (Playwright output)
 * 2. newest ~/Downloads/AllBillsPage*.csv (Bill's manual export)
 * Picks whichever is NEWER by mtime when both exist.
 */
export function resolveBillComCsv(opts?: {
  dataDir?: string;
  downloadsDir?: string;
}): CsvSourceResolution;

export function isRefDataStale(hours?: number): { stale: boolean; ageHours: number | null };
```

**Requirements:**
- Glob `AllBillsPage*.csv` — must match `AllBillsPage (16).csv` (space + parens).
- Default downloads dir from `os.homedir() + "/Downloads"`; both dirs injectable for tests.
- Missing directory → return `source: "none"`, never throw.
- In `import-billcom-ref.ts`: replace the hard-coded `DEFAULT_CSV` resolution with `resolveBillComCsv()`. Keep `--csv=` as an explicit override that wins. Log which source won and its age. **Keep `parseCSV`, `parseAmount`, `parseDate`, `parseCSVLine`, and `importRows` untouched.**
- Exit non-zero only when no CSV exists at all from any source.

**Tests:**
1. Only `data/AllBillsPage.csv` exists → `source: "playwright"`.
2. Only `Downloads/AllBillsPage (16).csv` exists → `source: "downloads"`, correct path.
3. Both exist, Downloads newer → picks downloads.
4. Both exist, data/ newer → picks playwright.
5. Multiple `AllBillsPage (14/15/16).csv` → picks newest by mtime, not by filename sort.
6. Neither exists → `source: "none"`, `path: null`, no throw.
7. Non-existent downloads dir → no throw.
8. `isRefDataStale` correct on fresh vs old `imported_at`, and on an empty table.

Use `fs.mkdtempSync(os.tmpdir())` for fixtures; set mtimes explicitly with `fs.utimesSync`. Clean up in `afterEach`.

---

## Workstream C — Per-Vendor Invoice-Number Patterns (HIGH)

**Problem:** The AAA Cooper Pro# regex and its bundle-skip logic are hard-coded inside `isNonInvoiceSender()` in `ap-local-forwarder.ts`. Any other vendor that bundles invoices repeats the same outage. OCR invoice# for LTL freight is unreliable (pulls account number `3746570`, sometimes literally `==Start of OCR for page 1==`), so the *subject* is the trustworthy identity.

**Objective:** Extract vendor invoice-number and bundle detection into a declarative, tested table.

**Files:**
- Create: `src/lib/intelligence/ap/vendor-invoice-patterns.ts`
- Create: `src/lib/intelligence/ap/vendor-invoice-patterns.test.ts`
- Modify: `src/lib/intelligence/workers/ap-local-forwarder.ts` — replace the bodies of `extractInvoiceNumberFromSubject`, `deriveVendorName`, and the hard-coded `aaacooper` branch inside `isNonInvoiceSender` with calls into the new module. **Preserve every existing behaviour and all current call signatures.**

**Contract:**
```ts
export interface VendorInvoicePattern {
  vendorKey: string;              // 'aaacooper'
  canonicalName: string;          // 'AAA Cooper Transportation'
  senderMatch: RegExp;
  /** Ordered: first capture group that hits wins. */
  invoicePatterns: RegExp[];
  /** Subject shapes that mean "bundle/correspondence, not one invoice". */
  bundleSubjectPatterns?: RegExp[];
  /** When set, ONLY subjects matching one of these are single invoices. */
  individualSubjectPatterns?: RegExp[];
}

export function matchVendorInvoicePattern(from: string): VendorInvoicePattern | null;
export function extractInvoiceNumber(from: string, subject: string): string | undefined;
export function deriveCanonicalVendorName(from: string): string | undefined;
export function isBundleEmail(from: string, subject: string): boolean;
```

**Seed the table with today's known-good behaviour:**
- **AAA Cooper** — sender `/aaacooper|cooper transportation/i`; invoice patterns `/Pro#:\s*(\d+)/i` then `/^\s*(\d{5,10})\s*$/`; individual-only = `/invoice stmt/i` or bare `/^\s*\d{5,10}\s*$/`; bundles = `/^Account\s+\d+\s*-/i`, `/Correspondence/i`, `/^RE:/i`.
- **Belt Power** — sender `/beltpower/i`, canonical `Belt Power`; invoice pattern `/Invoice#?\s*(\d{5,10})/i`.
- **Generic fallback** (no vendor match): `/invoice\s*(?:#|no\.?|number)?\s*:?\s*(\d{5,10})/i`.

**Requirements:**
- Pure module — no DB, no I/O, no imports from the forwarder.
- Generic bundle signatures apply to ALL vendors: subject `Account <digits> - <text>` or filename/subject containing `Correspondence`.
- `individualSubjectPatterns` present ⇒ anything not matching is a bundle (this is what protects AAA Cooper today; keep that semantic exactly).
- Every regex gets a comment naming the real-world subject it came from.

**Tests:**
1. `"Invoice Stmt - Cust 0001159492 Pro#: 64058431"` → `64058431`.
2. Bare subject `"64471555"` → `64471555`.
3. `"Account 1159492 - BUILDASOIL"` from aaacooper → `isBundleEmail` true.
4. `"RE: Need remittance"` from aaacooper → bundle true.
5. `"Invoice Stmt ... Pro#: N"` from aaacooper → bundle **false**.
6. Belt Power `"Belt Power, LLC - Invoice# 3198860"` → `3198860`.
7. Unknown vendor `"Invoice #12345"` → `12345` via generic fallback.
8. `deriveCanonicalVendorName("act.statement@aaacooper.com")` → `"AAA Cooper Transportation"`.
9. Account-number decoy: subject containing only `3746570` must NOT be mistaken for a Pro# when a `Pro#:` group is present.
10. Regression: existing AAA Cooper skip behaviour is byte-identical to current production behaviour for the 3 bundle subjects and 2 individual subjects observed in `ap_local_forwards`.

**After the refactor, these must still pass:** `npx vitest run src/lib/intelligence/ap/vendor-router.test.ts src/lib/intelligence/ap-single-forward.test.ts` (45 tests green today).

---

## Workstream D — Fuzzy Duplicate Detection (HIGH)

**Problem:** Dedup keys on content hash, message+filename, and exact invoice#. A vendor re-sending the same invoice as a freshly-generated PDF (different bytes, different filename, invoice# missing or OCR-garbled) slips straight through. Real evidence in `ap_local_forwards`: `ocr_invoice_number` values include `3746570` (account number) and `'64058414, 64058417, 64058410, ...'` (comma-joined list).

**Objective:** Add a vendor+amount+date-window layer as the last line of defence.

**Files:**
- Modify: `src/lib/intelligence/ap-single-forward.ts` — extend `isAlreadyClaimedOrForwarded` with the fuzzy layer AFTER all existing layers
- Modify: `src/lib/intelligence/ap-dedup.ts` — export the shared helper
- Create: `src/lib/intelligence/ap-fuzzy-dedup.test.ts`

**Contract (add to `ap-dedup.ts`):**
```ts
export interface FuzzyDuplicateMatch {
  hit: boolean;
  reason: string;
  existingId?: number;
  existingBillcomMessageId?: string | null;
}

/**
 * Last-resort dedup: same vendor, same total (±tolerance), invoice date within
 * ±dayWindow. Only consults rows already FORWARDED/CLAIMED/PENDING_SEND.
 */
export function findFuzzyDuplicate(args: {
  vendorName: string;
  total: number;
  invoiceDate?: string | null;
  excludeId?: number;
  amountTolerance?: number;  // default 0.02 absolute dollars
  dayWindow?: number;        // default 14
}): FuzzyDuplicateMatch;
```

**Requirements — read carefully, this layer can wrongly suppress a real bill:**
- Requires BOTH a non-empty vendor name AND a finite total > 0. Missing either → `hit: false`. Never guess.
- Vendor comparison is normalized: lowercase, strip punctuation, collapse whitespace, drop trailing `llc|inc|corp|co|ltd|transportation`. `"AAA COOPER TRANSPORTATION"` must equal `"AAA Cooper Transportation"`.
- Amount tolerance is **absolute dollars** (default `$0.02`), not a percentage — two genuinely different freight bills are frequently within 2% of each other.
- When `invoiceDate` is missing on either side, fall back to comparing `forwarded_at` within `dayWindow`.
- Wire into `isAlreadyClaimedOrForwarded` **only after** hash, message+filename, invoice#, and `billcom_bills_ref` layers have all missed. Ordering is non-negotiable — precise layers first.
- Log every fuzzy suppression at `console.warn` with vendor, amount, and the matched row id. A silent fuzzy suppression is worse than a duplicate.
- `reason` string must start with `"fuzzy:"` so it is unmistakable in logs and in the `already_forwarded` result.

**Tests:**
1. Same vendor, total `$534.85` vs `$534.85`, dates 3 days apart → hit.
2. Same vendor, `$534.85` vs `$534.90` (8¢ apart, outside $0.02) → NO hit.
3. Same vendor, same total, dates 30 days apart (> 14) → NO hit.
4. Different vendor, identical total and date → NO hit.
5. `"AAA COOPER TRANSPORTATION"` vs `"AAA Cooper Transportation"` → normalizes equal → hit.
6. Empty vendor name → NO hit.
7. `total = 0` or `NaN` → NO hit.
8. Only matches rows in FORWARDED/CLAIMED/PENDING_SEND — an ERROR row must NOT suppress.
9. `excludeId` prevents a row matching itself.
10. Integration: `forwardInvoiceOnce` returns `already_forwarded` with a `reason` starting `"fuzzy:"` when a fuzzy dup exists.

---

## Global Rules for All Workstreams

1. **TDD.** Failing test → run it and see it fail → minimal implementation → run it and see it pass.
2. **File headers.** Every new file opens with `@file`, `@purpose`, `@author Hermia`, `@created 2026-08-13`, `@deps`. Match the existing house style.
3. **JSDoc** on every exported function: params, return, and *why* it exists.
4. **No `any`** in new code. Type DB rows explicitly.
5. **Never break the send path.** New checks may only *suppress* a forward or *annotate* a row. If a new module throws, the forward must still work — wrap everything.
6. **Do not run `npm run typecheck`** (12GB OOM). Use `npx vitest run <path>` and, if needed, `npx tsc --noEmit 2>&1 | grep <your-file>`.
7. **Do not commit.** Leave changes staged-ready; Bill reviews before any commit.
8. **Regression gate:** `npx vitest run src/lib/intelligence/ap-single-forward.test.ts src/lib/intelligence/ap/vendor-router.test.ts` must stay green (45 tests).

---

## Sequencing

A, B, C, D touch disjoint files and run in parallel.

| WS | Owns |
|---|---|
| A | `ap/billcom-verify.ts` + test, `cron/jobs/index.ts` |
| B | `ap/billcom-csv-source.ts` + test, `cli/import-billcom-ref.ts` |
| C | `ap/vendor-invoice-patterns.ts` + test, `workers/ap-local-forwarder.ts` |
| D | `ap-single-forward.ts`, `ap-dedup.ts`, `ap-fuzzy-dedup.test.ts` |

Only A touches `cron/jobs/index.ts`. Only C touches `ap-local-forwarder.ts`. Only D touches `ap-single-forward.ts` / `ap-dedup.ts`.

**Deferred (not in this plan):** Bill.com duplicate-cleanup CLI for the "Multiple Copies" already sitting in the inbox; forward-success-rate on the morning AP health report; vision OCR + Bill.com API push for LTL freight.
