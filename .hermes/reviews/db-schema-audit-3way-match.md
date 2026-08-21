# Database Schema & Data Flow Audit — Order Tracking & Three-Way Match

**Audited by:** Aria Purchasing (t_3c04ecb1)
**Date:** 2026-08-11
**Scope:** purchase_orders, order status tracking, goods receipt, invoice matching (three-way match), inventory velocity, vendor reconciliation

---

## Executive Summary

The schema is **functional but fragile**. The core tables exist and the three-way match gate (shipped 2026-07-29) is well-designed. However, several structural gaps create data integrity risk, especially: (1) missing `receive_date` backfill leaves receipt detection blind for older POs, (2) no composite uniqueness constraint on `po_number` invites duplicate infestation, (3) the dual-table invoice architecture (`invoices` + `vendor_invoices`) has ambiguous semantics, and (4) the `lifecycle_state` field was corrupted by an unfiltered PATCH bug (2026-07-27) that stamped 1,122 rows as RECEIVED. The guard rail added after the incident is solid, but data hygiene for the affected rows is pending.

---

## 1. Table Inventory & Schema Audit

### 1.1 `purchase_orders` (Core PO Table)

**Columns** (38 total — from OpenAPI definition):
```
id, po_number, vendor_name, status (open|partial|received|closed),
issue_date, required_date, total_amount, total, line_items (JSONB),
vendor_response_at, vendor_response_time_minutes,
tracking_numbers (JSONB), last_eta_update (JSONB),
follow_up_sent_at, lifecycle_stage, lifecycle_state,
draft_created_at, committed_at, po_sent_at, po_email_message_id,
vendor_acknowledged_at, vendor_ack_source,
shipping_evidence (JSONB), tracking_status_summary,
tracking_unavailable_at, tracking_requested_at, tracking_request_count,
last_tracking_evidence_at, last_movement_update_at, last_movement_summary,
human_reply_detected_at, vendor_noncomm_at,
needs_human_review, is_intended_multi,
lifecycle_transitions (JSONB — append-only audit trail),
po_sent_verified_at, po_sent_verified_source, po_sent_verified_evidence,
tracking_requested_at_l2, vendor_party_id,
vendor_stated_eta, vendor_stated_ship_date,
vendor_stated_eta_confidence, vendor_stated_eta_extracted_at,
vendor_stated_eta_rationale,
receive_date, lifecycle_stage_legacy,
created_at, updated_at
```

**Issues found:**

| # | Severity | Issue | Impact |
|---|----------|-------|--------|
| 1 | **HIGH** | **Duplicate rows.** No unique constraint on `po_number`. Multiple rows can (and do) share the same PO number. `po-lifecycle.ts:144` uses `.single()` on `po_number` — this is **random-winner** behavior: PostgREST will arbitrarily return one row when multiple match. The `upsert` calls in `active-purchases.ts:322` use `onConflict: "po_number"` but there's no DB-level constraint backing it — the `on_conflict` query param is effectively advisory without a real index. | Random-winner reads produce non-deterministic lifecycle state. Self-heal upserts may insert duplicates instead of updating. |
| 2 | **HIGH** | **`receive_date` NULL for most rows.** The column was added to mirror Finale's receiveDate (commit timeline unclear), but no backfill was run. Many older POs have `receive_date = NULL` despite Finale having concrete receive data. The `po-lifecycle.ts` 3-way gate reads receive_date — a NULL means the gate treats the PO as unreceived even if Finale says received. | Blocks receipt-dependent gates. Causes false "incomplete" verdicts in 3-way match. |
| 3 | **MEDIUM** | **`lifecycle_stage` vs `lifecycle_state` duality.** Two columns for the same concept. `lifecycle_state` is the canonical one (used by `transitionLifecycleState()`). `lifecycle_stage` is older/possibly the original. `po-lifecycle.ts:146` reads `lifecycle_state` but `active-purchases.ts:158` reads `lifecycle_stage`. Not all rows populate both. | Which column is authoritative? Readers disagree. |
| 4 | **MEDIUM** | **Lifecycle corruption from unfiltered PATCH (2026-07-27).** 1,122 rows had `lifecycle_state` stamped to RECEIVED by a bug where `.update({...}).eq("id", x)` skipped the filter on PATCH and hit every row. The guard rail in `db.ts:424-436` now prevents unfiltered writes, but the already-corrupted rows haven't been reverted/corrected. `lifecycle_stage_legacy` preserves the pre-corruption value for rollback. | Dashboard and lifecycle summary functions return inflated RECEIVED counts. Self-heal logic (`active-purchases.ts:286-343`) may compound the issue by further upserting "healed" states. |
| 5 | **LOW** | **No index on `lifecycle_state`.** Both `getLifecycleState()` and `getLifecycleSummary()` scan the full table. With ~1,200 POs this is fine today but linear growth will make it painful. | No current perf impact. Future scaling risk. |

### 1.2 `invoices` and `vendor_invoices` (Dual Invoice Tables)

**Observation:** Two tables exist for invoices — `invoices` and `vendor_invoices`. The three-way match gate reads `invoices` (po-lifecycle.ts:238). Active Purchases reads both (active-purchases.ts:199 and :215), merging them with `vendor_invoices` as a fallback for missing `invoices` data.

**Issues found:**

| # | Severity | Issue | Impact |
|---|----------|-------|--------|
| 6 | **MEDIUM** | **Dual-table semantics unclear.** Which invoices go where? `invoices` appears to be Aria-processed/AP-pipeline invoices. `vendor_invoices` appears broader — possibly all vendor invoices including Bill.com matched ones. The merge logic in `active-purchases.ts:220-230` shows `vendor_invoices` is a fallback (only merged when `invoices` row is missing or has null total), but there's no documentation of the split. | Bug surface: a reconciled invoice in one table but not the other creates split-brain. |
| 7 | **LOW** | **`invoices.discrepancies` column used for PO completion.** `active-purchases.ts:207` checks `Array.isArray(inv.discrepancies) && inv.discrepancies.length > 0` to set `hasDiscrepancies`. This is a good signal but there's no standardization on what counts as a discrepancy vs a variance. | False-positive "exceptions" if minor price variances are stored as discrepancies. |

### 1.3 `po_lifecycle_transitions` (Audit Trail)

**Columns:** `id, po_number, from_state, to_state, transitioned_at, triggered_by, metadata (JSONB), invoice_id`

**Assessment: Clean.** Append-only audit trail. Properly used by `transitionLifecycleState()` which writes both the transition log AND updates `purchase_orders.lifecycle_state` in a single logical operation (though not in a single DB transaction — see Finding 9).

**Issues found:**

| # | Severity | Issue | Impact |
|---|----------|-------|--------|
| 8 | **MEDIUM** | **Local SQLite and Postgres writes are NOT transactional.** `transitionLifecycleState()` writes to SQLite first (Phase 1, line 185), then to Postgres (Phase 2, line 361). If the process crashes between phases, the SQLite record says RECEIVED but Postgres still says REVIEW. The local write is described as "crash-safe write-ahead log" but there's no recovery mechanism that reconciles the two on next boot. | Orphaned transitions: SQLite knows about a state Postgres doesn't. Dashboard reads Postgres only, missing the transition. |
| 9 | **LOW** | **`lifecycle_transitions` JSONB column on `purchase_orders` is redundant.** `po_lifecycle_transitions` already stores the full audit trail in its own table. The embedded JSONB on the PO row is a denormalized copy that must be kept in sync (and currently isn't — it's unclear what code populates it). | Stale cached audit data on the PO row. |

### 1.4 `shipments` and `shipment_intelligence` (Tracking)

**Assessment: Well-structured.** The `shipments` table is the canonical tracking store. `shipment_intelligence` is a derived intelligence layer. Active Purchases uses `listShipmentsForPurchaseOrders()` to enrich PO rows.

**Issues found:**

| # | Severity | Issue | Impact |
|---|----------|-------|--------|
| 10 | **LOW** | **`tracking_numbers` JSONB on `purchase_orders` is legacy.** Active Purchases reads from both `purchase_orders.tracking_numbers` (line 174) and the `shipments` table (line 183). The `derivePurchaseMovement()` function (active-purchases-movement.ts) has a `legacyTrackingNumbers` field to handle the old JSONB array. | Dual source of truth — but shipments table is always the fresher source. Legacy array on PO rows may be stale. |

### 1.5 `ap_activity_log` (Activity/Audit Log)

**Columns:** `id, email_from, email_subject, intent, action_taken, metadata (JSONB), status, created_at, updated_at` (+ GIN index on `metadata->poNumber` from migration 20260601)

**Assessment: Functioning well.** Used as the backbone for PO completion signals and reconciliation activity. The GIN index on `metadata->poNumber` (migration 20260601) is correctly utilized by `po-receipt-recheck` and `po-auto-complete`.

**Issues found:**

| # | Severity | Issue | Impact |
|---|----------|-------|--------|
| 11 | **LOW** | **No `metadata->>orderId` index.** Both `po-auto-complete.ts:191` and `po-completion-loader` query `eq("metadata->>orderId", value)`. With the GIN index being `jsonb_path_ops`, the `->>` operator should still benefit from it, but this should be verified. | Potential sequential scan on large activity logs. |

### 1.6 `vendor_reorder_policies`, `vendor_intelligence`, `vendor_profiles`

**Purpose:** Vendor configuration, intelligence, and profiles. `vendor_reorder_policies` stores per-vendor reorder parameters (`target_cover_days`, lead time buffer). `vendor_intelligence` is a derived analytics table. `vendor_profiles` stores contact metadata.

**Assessment: Adequate for current needs.** Migration `20260623_colorful_tighten_cover.sql` is a good example of tuning reorder policies via data changes rather than code changes.

---

## 2. Three-Way Match Gate Audit

### 2.1 Current Implementation

The three-way match gate lives in two places:

1. **`src/lib/purchasing/three-way-match.ts`** — Pure canonical implementation. Well-designed with clear tolerances, pack size normalization, and distinction between blocking vs informational variances. **No issues found with the pure function.**

2. **`src/lib/purchasing/po-lifecycle.ts` (lines 206-345)** — The enforcement point. The gate fires on `RECONCILED → COMPLETED` and `RECEIVED → COMPLETED` transitions. It reads PO data from `purchase_orders`, invoice data from `invoices`, and received quantities from the caller's metadata.

### 2.2 Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 12 | **HIGH** | **Gate only fires on COMPLETED transitions, not RECONCILED.** The 3-way match gate is wired to block `→ COMPLETED` transitions (line 223: `if (toState === "COMPLETED")`). But the PO can reach `RECONCILED` without any gate — `REVIEW → INVOICED → RECONCILED` is a valid path that skips receipt entirely. A PO can be reconciled without the three-way documents ever being compared. | Move the gate to `→ RECONCILED` transitions as well, or at minimum require receipt evidence before allowing the RECONCILED state when the PO has a matched invoice. |
| 13 | **MEDIUM** | **Gate is optional ("belt, not suspenders").** Line 339-343: if the gate throws an error, it logs a warning and **allows** the transition. The intent ("belt, not suspenders") is that a DB outage shouldn't block PO completion, but the current behavior means any runtime error in the gate (import failure, undefined property, type mismatch) silently passes. | Tighten: only allow on known transient errors (DB unavailable). Structural errors (import failures, type errors) should block. |
| 14 | **MEDIUM** | **`receive_date` is the receipt signal but it's often NULL.** The gate's `hasReceipt` check at line 248-249: `hasReceipt = !!(poData as any)?.receive_date && new Date(...).getTime() < Date.now()`. If `receive_date` is NULL (common for older POs), the gate sees no receipt even when Finale has one. | Backfill `receive_date` from Finale. Add a secondary receipt signal (e.g., `ap_activity_log` PO_RECEIVED rows) as a fallback. |
| 15 | **LOW** | **Pack size loading is per-transition, not cached.** Lines 261-278 load pack sizes from `sku_pack_sizes` on every COMPLETED transition. The table is tiny (~68 rows), so this is fine, but the `await import("./pack-size-registry")` dynamic import on every call adds latency. | Make `getPackSizes` a direct import, or cache the result at module level with a TTL. |

---

## 3. Order Status Tracking & Lifecycle Audit

### 3.1 State Machine

The PO lifecycle state machine (9 states: ORDERED, REVIEW, SENT, ACKNOWLEDGED, INVOICED, RECONCILED, RECEIVED, COMPLETED, CANCELLED) is well-defined with 18 valid transitions. The `assertValidTransition()` pure function enforces them.

**Findings:**

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 16 | **MEDIUM** | **311 rows had non-canonical lifecycle values.** `LEGACY_STAGE_MAP` in `po-lifecycle.ts` documents 14 distinct lowercase/rogue values that were written directly to the DB without going through `transitionLifecycleState()`. These include sub-states like `l3_escalated`, `moving_with_tracking`, `closed_stale` that describe conditions rather than true lifecycle states. The normalization handle (`normalizeLifecycleStage()`) maps them to canonical states, but the original values are still in the DB. | Consider a one-time backfill migration to rewrite all non-canonical `lifecycle_state` values to their canonical form, preserving the originals in `lifecycle_stage_legacy`. |
| 17 | **MEDIUM** | **REVIEW → RECEIVED is a valid transition.** Line 47: `REVIEW: ["SENT", "INVOICED", "RECEIVED", "CANCELLED"]`. This means a PO can skip SENT/ACKNOWLEDGED/INVOICED entirely and go straight from draft review to received. While this is pragmatically correct (goods can arrive before dispatch is recorded), it masks the fact that a PO was never dispatched — a PO that goes REVIEW → RECEIVED should trigger a different alert than one that went through full SENT → ACK → RECEIVED. | Surface the "never-sent-but-received" pattern in `active-purchases.ts` as a warning flag. |
| 18 | **LOW** | **Self-heal may compound corruption.** `active-purchases.ts:286-343` auto-heals POs where receipt evidence exists but lifecycle is stuck at a non-received state. This is good for normal operations, but after the 1,122-row corruption incident (Finding 4), a self-heal pass could re-corrupt rows that were already fixed. The heal logic should verify the transition is valid before upserting. | Add `assertValidTransition(current, "RECEIVED")` check before the self-heal upsert. |

---

## 4. Goods Receipt & Receiving Audit

The receipt detection chain: `Finale receiveDate → purchase_orders.receive_date → po-receipt-state.ts → isHighConfidenceReceived() → Active Purchases filter`

**Findings:**

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 19 | **MEDIUM** | **`receive_date` is not synced from Finale on a schedule.** The field is populated ad-hoc (unclear what code writes it). `po-receipt-recheck.ts` rechecks POs against Finale but only runs on demand (the test file tests it, but no cron job is visible that runs it regularly). | Add a cron job that polls Finale for receipt changes and updates `purchase_orders.receive_date` for recently-received POs. |
| 20 | **LOW** | **`isHighConfidenceReceived` has 8 distinct signals but no debug trace for which signal triggered.** The function uses `finaleReceiptActivity`, `matchedInvoiceStatus`, lifecycle state, shipment data, and `receive_date`. When a PO drops from Active Purchases, there's no log of which signal(s) caused it. | Add an `_receipt_signal` metadata field on the PO row or log to ap_activity_log when a PO is classified as received. |

---

## 5. Inventory Velocity & Build Risk Audit

The Oracle pipeline: `Calendar → BuildParser → FG-traceback filter → BOM explosion → stock verification → snapshot → cron alerts`

**Assessment: Mature and well-tested.** The FG-traceback architecture (documented in `oracle-fg-traceback` skill) correctly filters overstocked FGs and only triggers component orders when feeding FGs have <42d coverage.

**Tables:** `build_risk_snapshot` (per-SKU snapshot rows), `purchasing_snapshots` (per-run metadata), `vendor_reorder_policies` (reorder tuning).

**Findings:**

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 21 | **LOW** | **`build_risk_snapshot` has no cleanup/retention policy.** Unlike `cron_runs` (14d retention via `prune-retention.js`), build risk snapshots accumulate indefinitely. Each run writes N rows (one per component). At ~5 runs/week × ~30 components, that's ~600 rows/month — manageable but trending. | Add retention: keep last 30 days of daily snapshots, 90 days of weekly. |
| 22 | **LOW** | **`vendor_reorder_policies` has no audit trail.** When a policy is changed (e.g., Colorful Packaging target_cover_days from 180 → 90), there's no log of who changed it, when, or why (outside of the migration SQL comment). | Consider adding `updated_by` and `change_reason` columns. |

---

## 6. Vendor Reconciliation Audit

**Tables:** `vendor_po_patterns` (PO format patterns, confidence scoring), `vendor_intelligence` (derived analytics), `statement_reconciliations`, `confirmed_po_matches`, `pending_reconciliations`

**Findings:**

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 23 | **MEDIUM** | **`vendor_po_patterns` uses `vendor_name` as PK but vendor names are inconsistent.** Vendor name normalization (`vendor-name-normalize.ts`) exists but the `upsert_vendor_po_pattern` RPC uses raw `vendor_name`. If "Axiom Print" and "Axiom" both appear, they create separate pattern records with split confidence data. | Normalize vendor names before upserting into `vendor_po_patterns`. |
| 24 | **LOW** | **`pending_reconciliations` has no auto-expiry.** The table has `expires_at` but no cron job that auto-closes expired rows. | Add a daily cron that marks expired pending reconciliations as `stale` and notifies. |

---

## 7. Missing Indexes

| Table | Column(s) | Why |
|-------|-----------|-----|
| `purchase_orders` | `lifecycle_state` | `getLifecycleSummary()` scans full table |
| `purchase_orders` | `vendor_name` | `loadActivePurchases` filters by vendor for intel lookups |
| `ap_activity_log` | `intent, created_at` | Frequent queries: `eq("intent", X).gte("created_at", ...)` |
| `invoices` | `po_number` | Three-way gate reads invoices by `po_number` |

---

## 8. Structural Bottlenecks in the Completion Pipeline

The end-to-end flow for a PO: `REVIEW → SENT → ACKNOWLEDGED → INVOICED → RECONCILED → RECEIVED → COMPLETED`

**Bottlenecks identified:**

| # | Severity | Bottleneck | Recommendation |
|---|----------|-----------|----------------|
| 25 | **HIGH** | **RECONCILED → COMPLETED requires an explicit human or agent action. Nothing auto-advances.** The `po-auto-complete.ts` watcher exists but is gated behind `PO_AUTO_COMPLETE_ENABLED=false` (default OFF). Without it, POs sit at RECONCILED/RECEIVED indefinitely. The three-way gate is only checked when someone/something calls `transitionLifecycleState()` with `COMPLETED` — it's a guard, not a driver. | Enable the auto-complete watcher with a conservative threshold (72h dwell instead of 48h) to start auto-closing clean POs. Add a daily "stuck PO" summary to Telegram. |
| 26 | **MEDIUM** | **Invoice matching has no auto-retry.** When `invoices` lacks a row for a PO that has an invoice in `vendor_invoices`, nothing bridges the gap automatically. The merge logic in `active-purchases.ts:220-230` shows `vendor_invoices` is used as a fallback for display, but the three-way gate only reads `invoices`. | Add an auto-bridge: if `invoices` has no row for a PO but `vendor_invoices` does, copy/merge the relevant fields. |
| 27 | **MEDIUM** | **`receive_date` backfill is not automated.** Finding 19 again: without reliable receive_date data, the three-way gate, the active purchases filter, and the auto-complete watcher all act on incomplete information. | Create a daily sync cron: `sync-finale-receipts` that polls Finale for recently-received POs and backfills `receive_date`. |

---

## 9. Summary of Recommendations (Priority-Ordered)

### Critical (do now)
1. **Add UNIQUE constraint on `purchase_orders.po_number`** — prevents duplicate rows and fixes random-winner reads.
2. **Backfill `receive_date` from Finale** — critical for the three-way gate, receipt detection, and active purchases filtering.
3. **Move 3-way gate to RECONCILED transitions** — currently only fires on COMPLETED; a PO can be "reconciled" without the three documents ever being compared.

### High (do this week)
4. **Add `lifecycle_state` index** on `purchase_orders`.
5. **Fix the 1,122 corrupted lifecycle rows** — restore from `lifecycle_stage_legacy` where available.
6. **Document the `invoices` vs `vendor_invoices` split** — add a comment block in both `active-purchases.ts` and `three-way-match.ts`.
7. **Tighten the 3-way gate error handling** — structural errors should block, not allow.

### Medium (do this sprint)
8. **Create `sync-finale-receipts` cron** — daily poll of Finale for new receive dates.
9. **Add auto-bridge from `vendor_invoices` to `invoices`** — ensures the three-way gate sees invoice data even when only `vendor_invoices` has it.
10. **Enable `po-auto-complete` watcher** — gate behind 72h dwell initially, monitor for false positives.
11. **Normalize vendor names in `vendor_po_patterns`** — prevent split confidence data from variant vendor name spellings.

### Low (backlog)
12. **Add retention policy for `build_risk_snapshot`** — keep 30d daily, 90d weekly.
13. **Add `changed_by`/`change_reason` to `vendor_reorder_policies`** — audit trail for policy changes.
14. **Add `_receipt_signal` logging** — trace which signal(s) triggered a receipt classification.
15. **Remove redundant `lifecycle_transitions` JSONB on `purchase_orders`** — the `po_lifecycle_transitions` table is the canonical store.

---

## Appendix A: Tables Referenced in This Audit

| Table | Rows (est.) | Critical Path | Schema Issues |
|-------|-------------|---------------|---------------|
| `purchase_orders` | ~1,200 | Yes | No UNIQUE on po_number; dual lifecycle columns; corrupted rows |
| `invoices` | ? | Yes | Unclear split from vendor_invoices |
| `vendor_invoices` | ? | Conditional | Fallback for invoices |
| `po_lifecycle_transitions` | Growing | Yes | Clean |
| `po_lifecycle_cache` (SQLite) | Growing | Yes | Not reconciled with Postgres |
| `ap_activity_log` | Large | Yes | GIN index exists; needs intent+created_at index |
| `shipments` | Growing | Yes | Well-structured |
| `shipment_intelligence` | Derived | No | Clean |
| `vendor_po_patterns` | ~20-30 | Conditional | vendor_name not normalized |
| `vendor_reorder_policies` | ~10-15 | Reference | No audit trail |
| `vendor_intelligence` | ~20-30 | Reference | Clean |
| `build_risk_snapshot` | Growing | Conditional | No retention policy |
| `pending_reconciliations` | Tiny | Yes | No auto-expiry |
| `sku_pack_sizes` | ~68 | Conditional (3-way) | Clean |

## Appendix B: Source Files Reviewed

- `supabase/migrations/*.sql` (4 files)
- `src/lib/purchasing/po-lifecycle.ts`
- `src/lib/purchasing/three-way-match.ts`
- `src/lib/purchasing/active-purchases.ts`
- `src/lib/purchasing/po-receipt-state.ts`
- `src/lib/purchasing/po-completion-loader.ts`
- `src/lib/purchasing/po-auto-complete.ts`
- `src/lib/purchasing/po-stuck-detector.ts`
- `src/lib/purchasing/pack-size-registry.ts`
- `src/lib/builds/reorder-engine.ts`
- `src/lib/tracking/shipment-intelligence.ts`
- `src/lib/db.ts`
- `src/lib/intelligence/acknowledgement-agent.ts`
- `src/lib/intelligence/ap/vendor-router.ts`
- `docs/db-ownership.md`
- `scripts/resolve-stuck-ap.ts`
- PostgREST OpenAPI schema (live, 2026-08-11)