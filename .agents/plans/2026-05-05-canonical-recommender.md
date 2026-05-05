# Canonical Reorder Recommender — Session Handoff (2026-05-05)

> **For the next coder picking this up.** Everything in here was built and merged
> across two sessions on 2026-05-05. Read top-to-bottom; the gaps section at the
> end is the actual work queue.

---

## TL;DR

Aria's purchasing pipeline now has a single, auditable, self-calibrating reorder
formula. Every recommendation comes with a step-by-step provenance trace
(`Why X?` drawer in the dashboard). Draft POs reserve their qty so a follow-up
scan does not double-order. Vendor MOQs are honored. P90 lead time is used when
we have ≥5 receipts of vendor history. After each PO is received, we calibrate
the recommendation that drove it and roll the error into a per-vendor
`safety_multiplier` that the recommender consumes on the next run.

PO send verification was moved to a Finale-native flow with duplicate-send
guards and Gmail outbox backfill so the dashboard's "PO send unverified" badge
reflects reality.

**Formula version:** `v2.0-calibrated-2026-05-05` (set in
`src/lib/purchasing/qty-recommender.ts`). Bump on behavioral change so phase 2
calibration can bucket error rates per formula version.

---

## What is live (commits in date order)

| Commit | Scope |
|---|---|
| `4a27690` | Finale-native PO send + duplicate guard + sent-verification UI/migration; vendor ETA profile (tracking → reply → ULINE → median → default); raw-runway "most-needed-first" sort. |
| `deec286` | Phase 1 — pure `qty-recommender` module + 20 tests + provenance trace + "Why X?" dashboard drawer. |
| `1de3511` | Phase 2 + 3a + 3c + MOQ + Aria-vs-Finale weekly retro + `/qty-status` + Gmail outbox backfill. Recommender v2.0. |

---

## Architecture map

```
                      getPurchasingIntelligence()  (src/lib/finale/client.ts:4642)
                                  │
                                  ├─ Pre-loop:  loadActiveReservations()       ┐
                                  │             leadTimeService.warmCache()    │
                                  │                                            │
                                  ├─ Per-SKU:   loadCalibrationStats(vendor)   │  src/lib/purchasing/calibration.ts
                                  │             loadVendorMOQs(vendor)         │
                                  │             leadTimeService.getDistribution│  src/lib/builds/lead-time-service.ts
                                  │                                            │
                                  ├─ recommendQty(input)  ───────────────►─────┘  src/lib/purchasing/qty-recommender.ts
                                  │      │
                                  │      └─ provenance trace + suggestedQty
                                  │
                                  └─ Post-loop: recordRecommendationSnapshots()
                                                  → qty_recommendations table


                      createDraftPurchaseOrder()  (src/lib/finale/client.ts:4287)
                                  │
                                  └─ recordReservations(orderId, items) → qty_reservations

                      commitDraftPO()             (src/lib/finale/client.ts:5099)
                                  │
                                  └─ releaseReservations(orderId, "committed")


   Daily 8:30 AM cron (ops-manager.runQtyCalibration):
     attachReceivedPOsToRecommendations()   → stamps actual + error_pct
     recomputeVendorCalibrationStats()      → vendor_calibration_stats + safety_multiplier
     cleanupExpiredReservations()           → 72h TTL on draft reservations

   Friday 8:01 AM cron (ops-manager.sendWeeklySummary):
     summarizeAriaVsFinale(7) → Telegram retro
```

---

## File-by-file reference

### `src/lib/purchasing/qty-recommender.ts` ⭐ the core

Pure function `recommendQty(input)`. **No I/O, no env reads, no Finale calls.**
Returns `{ suggestedQty, runwayDays, adjustedRunwayDays, urgency, provenance, ... }`.

**Inputs grouped by role:**
- Velocity: `dailyRate`, `dailyRateSource`, `dailyRateLabel`, `velocityInflated`, `velocityRawRate`, `velocityRealityCap`
- Stock: `stockOnHand`, `stockOnOrder`, `openPOCount`
- Lead time: `leadTimeDays`, `leadTimeProvenance`, `leadTimeP90` (optional)
- Buffer: `coverBufferDays` (default 60)
- Pack rounding: `orderIncrementQty`
- **Phase 2:** `safetyMultiplier`, `calibrationSampleCount`, `calibrationMedianErrorPct`
- **Phase 3a:** `reservedQty`, `reservedDraftPOs[]`
- **MOQ:** `minimumOrderEaches`, `minimumOrderDollars`, `unitPrice`

**Steps emitted to provenance (in order):**
1. `daily_rate` — chosen velocity signal + source
2. `on_hand` — current stock
3. `on_order` — open PO qty
4. `reserved` — only when reservedQty > 0
5. `runway` — raw + adjusted
6. `lead_time` — `p90` / `median` / `point` basis
7. `cover_days` — lead + buffer × multiplier (when n≥5)
8. `raw_qty` — target − supply = need
9. `pack_round` — snap to increment
10. `moq` — only when MOQ kicked in
11. `urgency` — critical / warning / watch / ok

**Tests:** `src/lib/purchasing/qty-recommender.test.ts` — 32 tests covering
math, urgency tiers, calibration, reservation, MOQ, P90, provenance.

### `src/lib/purchasing/calibration.ts`

Cross-cutting Supabase access. Each function is **best-effort** — Supabase
outage degrades to phase-1 behavior, never blocks.

| Function | Purpose |
|---|---|
| `loadCalibrationStats(vendorPartyIds[])` | vendor → safety_multiplier + median_error_pct + sample_count |
| `loadActiveReservations(productIds[])` | productId → reserved_qty + draft_po_numbers[] (filters released_at IS NULL AND expires_at > now) |
| `recordReservations(draftPO, vendorPartyId, items[])` | called by `createDraftPurchaseOrder` |
| `releaseReservations(draftPO, reason)` | called by `commitDraftPO` (also by cancel + expiry cron) |
| `cleanupExpiredReservations()` | sets released_at on rows past their 72h TTL |
| `loadVendorMOQs(vendorPartyIds[])` | vendor → {minimumOrderDollars, minimumOrderEaches} |
| `recordRecommendationSnapshots(snapshots[])` | batch insert into qty_recommendations |

### `src/lib/purchasing/calibration-engine.ts`

The closed-loop logic. Three exports:

| Function | Schedule | What it does |
|---|---|---|
| `attachReceivedPOsToRecommendations(daysBack=30)` | daily 8:30 AM | For each newly-received PO line, find the most recent uncalibrated `qty_recommendations` row for that SKU within 60d before receive, stamp `actual_consumed_eaches` + `error_pct` + `calibrated_at`. |
| `recomputeVendorCalibrationStats()` | daily 8:30 AM | Rolls calibrated rows per vendor, computes median + mean + bias, applies the safety_multiplier policy below, upserts vendor_calibration_stats. |
| `summarizeAriaVsFinale(daysBack=7)` | Friday 8:01 AM | Returns `{ totalSamples, coveredSamples, ariaUnderFinaleCount, ariaOverFinaleCount, medianAriaErrorPct, medianFinaleErrorPct, worstAriaMisses[], bestAriaWins[] }`. Wins = Aria error magnitude < Finale error magnitude − 10. |

**safety_multiplier policy** (in `recomputeVendorCalibrationStats`):

```
sample_count <  5            → 1.00  (no signal yet)
|bias| < 25%                 → 1.00  (within tolerance)
bias <= -50%                 → 1.50  (substantially under-ordering)
bias <= -25%                 → 1.25  (under-ordering)
bias >=  25%                 → 0.85  (over-ordering)
bias >=  50%                 → 0.75  (substantially over-ordering)
```

`bias = mean(error_pct)` where `error_pct = (recommended − actual) / actual × 100`.
Positive bias = over-ordering, negative = under-ordering. The recommender clamps
the multiplier to `[0.5, 2.5]` defensively.

### `src/lib/builds/lead-time-service.ts`

Existing service extended with:
- `LeadTimeDistribution { p50, p90, sampleCount }`
- `getDistribution(vendorName) → LeadTimeDistribution | null` — returns null when sampleCount < 5

Backed by `FinaleClient.getVendorLeadTimeDistribution()` which reads
the raw days[] array stashed by `getVendorLeadTimeHistory()`. Same 4h
TTL as the median cache.

### `src/lib/finale/client.ts` changes

- New imports: `recommendQty`, `loadActiveReservations`, `loadCalibrationStats`, `loadVendorMOQs`, `recordRecommendationSnapshots`, `leadTimeService`
- New module-level cache: `_vendorLeadTimeRawCache` (4h TTL) populated by `getVendorLeadTimeHistory`, read by `getVendorLeadTimeDistribution`
- `PurchasingItem.recommendation` carries the trace through the API surface
- `getPurchasingIntelligence`: pre-loads reservations + warms lead time cache; per-SKU memoizes calibration + MOQ; calls `recommendQty()`; persists snapshots
- `createDraftPurchaseOrder`: writes reservations after successful create (best-effort)
- `commitDraftPO`: releases reservations after successful commit (best-effort)

### `src/lib/intelligence/ops-manager.ts` changes

- New cron: daily 8:30 AM → `runQtyCalibration()`
- `sendWeeklySummary` rewritten — no longer a stub; reads `summarizeAriaVsFinale` and posts to Telegram
- `syncPOConversations` extended — when it walks `label:PO`, writes `po_sent_verified_at/source/evidence` if no higher-confidence source already exists. Closes false-negatives on POs emailed manually outside Aria.

### `src/cli/start-bot.ts` changes

- New command `/qty-status` (aliases: `/qtystatus`, `/qty`) — surfaces calibration health: open reservations, uncalibrated rec count, sample stats, top vendors by sample count.

### `src/lib/intelligence/po-correlator.ts` changes

- New: `backfillPOSentVerificationFromGmail(daysBack, maxResults)` — walks `label:PO` outbox, normalizes PO numbers to bare digits, upserts `purchase_orders.po_sent_verified_at`. Idempotent. Skips POs already verified from po_send / vendor_reply / manual.

### `src/cli/backfill-po-sent-verification.ts`

One-shot CLI for the above. Run with `node --import tsx src/cli/backfill-po-sent-verification.ts [daysBack=365] [maxResults=500]`. Already ran 30d / 200 → 37 POs verified.

### Migrations applied

| File | What |
|---|---|
| `20260505000001_add_po_sent_verification.sql` | adds po_sent_verified_at/source/evidence to purchase_orders |
| `20260505000002_qty_calibration.sql` | qty_recommendations, qty_reservations, vendor_minimum_orders, vendor_calibration_stats |

### Dashboard changes

`src/components/dashboard/PurchasingPanel.tsx`:
- Sort flipped to raw `runwayDays` ASC primary key (was urgency tier first)
- New "Why X?" toggle next to suggested qty — expands cyan trace drawer with each provenance step + footer "Finale says N (ignored — Aria's trace above is the source of truth)"
- `whyOpen: Set<string>` state keyed `${vendorPartyId}:${productId}`

`src/components/dashboard/ActivePurchasesPanel.tsx`:
- "PO send verified/unverified" badge with source label
- "mark verified" button → POST /api/dashboard/active-purchases with action=mark_sent_verified

---

## Operational gotchas

1. **Migration `_run_migration.js`** uses `DATABASE_URL` (Supabase pooler) from `.env.local`. SUPABASE_SERVICE_ROLE_KEY is the REST JWT — *not* the DB password.
2. **`syncPOConversations`** runs every 30 min and only looks at last 45 days. POs older than 45 days that need verification need either the manual button or a one-shot backfill CLI run.
3. **Recommendation snapshot writes are non-blocking** (`void` + `.then`). A scan can complete and return groups before snapshots finish persisting; this is intentional — calibration data should never block the dashboard.
4. **Calibration matching is "most recent uncalibrated rec for SKU within 60d before receive"**. If we recommend the same SKU twice in a window before either is received, only the most recent gets calibrated. Probably fine for now; revisit when we see misattribution in practice.
5. **safety_multiplier is clamped to [0.5, 2.5]** in the recommender to prevent runaway calibration. The engine itself only emits 0.75 / 0.85 / 1.0 / 1.25 / 1.5.
6. **Vendor matching is fuzzy** — calibration loads stats by vendorPartyId (exact), but lead-time distribution and MOQ both fall through `vendor_party_id` → `vendor_name` partial-match. Vendor renames in Finale will break the chain until the next stats recompute.
7. **HUB_TASKS_ENABLED env still gates agent_task writes** for related rollback. Calibration writes do *not* go through the hub — they're domain-specific.

---

## What we're still missing

### High-value gaps

#### 1. Phase 3b — BOM pull-through for components
**Status:** deferred. Finale's `demandQuantity` covers BOM consumption, but `chooseVelocitySignal` caps demand at 3× max(sales, receipts). For pure components (no direct sales, all consumption via BOM builds), the cap kicks in incorrectly and we under-order.

**Fix sketch:**
- When `dailyRateSource === "demand"` AND `salesVelocity === 0` AND product is BOM-consumed, raise the cap to 5× receipts or skip the cap entirely
- Better: walk the BOM graph from finished-good calendar demand → component daily rate; replace Finale's demandQuantity entirely for components
- Even better: feed BOM-derived demand into `qty_recommendations.inputs_jsonb` so calibration can score component recs

**Why it's hard:** Finale BOM API needs spelunking. There's already `getBOMConsumption` (`client.ts:1845`) but it's a single-product report, not a graph walker. Need to enumerate finished goods → walk `productBomList` → aggregate component requirements weighted by build calendar projection.

**When to do this:** after 4–6 weeks of calibration data. The vendor_calibration_stats will reveal which components are systematically under-ordered (negative bias) and that bias surplus will tell you exactly which BOM chains matter, instead of guessing in the dark.

#### 2. MOQ table is empty
**Status:** infrastructure works; data is empty. `vendor_minimum_orders` has zero rows.

**Fix options:**
- A. **`/moq` Telegram command** — interactive seeder: `/moq ULINE 500` → upsert minimum_order_dollars=500.
- B. **Auto-learn from rejection emails** — when a vendor replies "below MOQ", parse + suggest a row.
- C. **Just do it manually as you hit them.** Probably the right call until 3-5 rejections.

#### 3. Calibration engine has no test coverage
**Status:** logic is straightforward but pure DB code. Worth adding fixtures.

**Fix:** Vitest fixtures with `vi.mock("../supabase")`. Cover:
- `attachReceivedPOsToRecommendations` matches the right rec
- `recomputeVendorCalibrationStats` policy thresholds (5 buckets)
- `summarizeAriaVsFinale` win detection (Aria err magnitude < Finale err magnitude − 10)

#### 4. Aria-vs-Finale data needs ramp time
The Friday retro will say "no calibrated samples yet" for the first 1-2 weeks until POs from after 2026-05-05 start being received. Don't panic — the cron writes; it just takes a receive cycle. Set expectation with the user.

### Smaller wins

#### 5. Snooze-aware morning digest
Today the dashboard PurchasingPanel has `aria-dash-purchasing-snooze` localStorage. The 8 AM digest doesn't read it, so a snoozed-vendor surge still pages. Either:
- Read the snooze list from a server-persisted source and skip in digest
- Auto-un-snooze when velocity surges past historical median by 2×

#### 6. Vendor renames break calibration chain
Vendor name changes in Finale break the lead-time-distribution match (string fuzzy match) without breaking the calibration stats match (vendor_party_id exact). This will surface as "we have stats for vendor X but no P90 distribution available". Logging only; user-invisible.

**Fix:** stash `vendor_party_id` → `vendor_name` map in lead-time-service alongside the days array.

#### 7. Reservation TTL is 72h
Reasonable but not data-driven. If most drafts get committed within 24h, a tighter TTL (24-48h) reduces the chance of an expired reservation hiding real need. Worth measuring after 30 days.

#### 8. `recommendation_snapshot` provenance can blow up token usage
Every recommendation writes the full provenance into `qty_recommendations.provenance_jsonb`. With ~120 SKUs × hourly scans = 2,880 rows/day, each ~2KB. Need a TTL-based pruner if calibration falls behind. Not urgent (one row per *recommendation*, not per scan — duplicates skipped) but worth a `qty_recommendations` retention policy.

#### 9. PurchasingPanel "Why X?" drawer is not virtualized
For groups with 50+ items all expanded, render time will degrade. Acceptable for now since most usage is single-item drill-down.

#### 10. No dashboard surface for reservations
Open `qty_reservations` rows are invisible unless you `/qty-status` or query SQL. A small banner in PurchasingPanel header like "3 SKUs have draft reservations" with a click-through would make it discoverable.

#### 11. `velocityInflated` cap (`3 × reality`) hardcoded in `chooseVelocitySignal`
This is the same root cause as Phase 3b. The cap is right for finished goods but wrong for components. Could be made vendor- or product-class-specific once we have calibration signal.

#### 12. Backfill CLI does not paginate beyond 500 results
Hardcoded to `maxResults` arg. For multi-year backfill, would need pagination loop. Not blocking — 30-day windows are well under the limit.

### Nice-to-have observability

#### 13. Add `formula_version` filter to `/qty-status`
Today `/qty-status` reports across all formula versions. When v3 rolls out we'll want to compare v2 vs v3 error rates side-by-side.

#### 14. Drift alerts
If `safety_multiplier` for a vendor changes by ≥0.25 between weekly recomputes, page Will. Either velocity is shifting fast or we have a data issue.

#### 15. Dashboard timeline of "Aria vs Finale" 30-day rolling
Currently a single Friday digest. A small chart on the dashboard showing rolling median error % over the last 30/60/90 days would build trust faster than a weekly Telegram message.

---

## Test commands cheat sheet

```bash
# Recommender unit tests (32 tests)
npm test -- src/lib/purchasing/qty-recommender.test.ts

# Recommender + Finale combined
npm test -- src/lib/purchasing/qty-recommender.test.ts src/lib/finale/client.test.ts

# Full build (skips type-check by design — see CLAUDE.md)
npm run build

# Type-check the CLI/lib only (faster)
npm run typecheck:cli

# Apply a migration manually
node _run_migration.js supabase/migrations/<filename>.sql

# Run the historical PO sent-verification backfill
node --import tsx src/cli/backfill-po-sent-verification.ts 30 200

# Check PM2 status / restart
pm2 status
pm2 restart aria-bot aria-dashboard
pm2 logs aria-bot --lines 50
```

---

## Recommended next session moves

In priority order:

1. **Wait one week.** Let the cron run 5–7 daily cycles. Look at `/qty-status` and verify `vendor_calibration_stats` is filling. If samples stay at 0, debug the matching logic in `attachReceivedPOsToRecommendations` first.
2. **Seed MOQ** for the 5 vendors that ULINE-style reject small orders (start with vendors you've actually been pushed back on).
3. **Phase 3b BOM pull-through** — but only after calibration data flags which components need it.
4. **Add tests for `calibration-engine.ts`** — small ROI but the file is destined to grow.
5. **Drift alerts (#14)** — cheap to add, high signal.

Skip / deprioritize:

- Snooze-aware digest (low pain — Will sees it on the dashboard anyway)
- Reservation TTL tuning (no data yet)
- Provenance retention (not yet a problem)

---

## Owner notes (from session memory)

- Will prefers cross-cutting concerns embedded centrally, not pushed to call sites. Calibration writes happen inside `getPurchasingIntelligence` / `createDraftPurchaseOrder` / `commitDraftPO` — not at every caller. Keep this pattern.
- Will prefers on-demand commands over date-pinned crons where reasonable. `/qty-status` exists; the daily cron only does *writes*, not reports.
- Will trusts Aria's number when given a clear trace. The "Why X?" drawer is load-bearing — do not remove or shorten it without replacement UX.
- "Finale says N (ignored)" footer is intentional framing. Don't soften it back to "Finale: 12 → Aria: 7 / 42% diff" — that re-introduces ambiguity and Will explicitly wanted Aria to take a side.
