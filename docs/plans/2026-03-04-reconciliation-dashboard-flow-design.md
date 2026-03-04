# Reconciliation Dashboard Flow — Design

**Date:** 2026-03-04
**Author:** Antigravity / Will
**Status:** ✅ IMPLEMENTED (2026-03-04)

---

## Problem

Reconciliation entries in the Activity Feed are broken in three ways:
1. **PO button is dead** — `<button>` with no href/onClick. No Finale URL stored in metadata.
2. **No change details shown** — Only shows "Auto-applied: 1 changes, 0 skipped". The actual price/fee deltas in `metadata` are never rendered.
3. **No approval/dismiss flow** — Can't approve, reject, or acknowledge from the dashboard. Only possible via Telegram inline buttons.

---

## Part A: Activity Feed Rendering

### A1 — PO Link (same pattern as ReceivedItemsPanel)

Construct Finale URL client-side using the same base64-encoded pattern:
```
https://app.finaleinventory.com/{accountPath}/sc2/?order/purchase/order/{base64(orderUrl)}
```

- Expose `FINALE_ACCOUNT_PATH` via `NEXT_PUBLIC_FINALE_ACCOUNT_PATH` env var (not secret — just account slug)
- Construct `orderUrl` as `/{accountPath}/api/order/{orderId}` → base64 encode → build URL
- PO button becomes `<a>` tag opening Finale in a new tab — identical to ReceivedItemsPanel

### A2 — Invoice Details Inline

Clicking INV expands the card inline to show parsed invoice data from metadata:
- Vendor name, invoice number, invoice date
- Line items with quantities and prices
- Fee breakdown
- Totals

### A3 — Show Changes

For RECONCILIATION entries, expand the card to show:
- **Price changes:** `productId: $old → $new (% change, $impact)`
- **Fee changes:** `Freight: $0 → $245.00 (NEW)`
- **Tracking:** numbers and ship date if present
- **Dollar impact:** total
- **Verdict:** color coded (auto_approve=green, needs_approval=amber, rejected=red)

Data already exists in `metadata.priceChanges` and `metadata.feeChanges`.

---

## Part B: Approval/Reject/Dismiss Flow

### B1 — State Machine

```
                    ┌──────────────┐
                    │  NEW ENTRY   │
                    │ (from agent) │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       ┌────────────┐ ┌──────────┐ ┌─────────┐
       │auto_approve│ │needs_    │ │no_change│
       │  (applied) │ │approval  │ │duplicate│
       └─────┬──────┘ └────┬─────┘ └────┬────┘
             │              │             │
             ▼              ▼             ▼
       ┌──────────┐  ┌───────────┐  ┌─────────┐
       │Acknowledge│  │ Approve   │  │  (done) │
       │  button   │  │ Reject    │  └─────────┘
       └─────┬─────┘  └──┬───┬───┘
             │            │   │
             ▼            │   ▼
       ┌──────────┐       │  ┌───────────────┐
       │ REVIEWED │       │  │  PAUSED for   │
       │  (done)  │       │  │  research     │
       └──────────┘       │  └──┬────────────┘
                          │     │
                          ▼     ├──→ Approve & Apply
                    ┌──────────┐├──→ Re-match (smart)
                    │  APPLIED │├──→ Dismiss (options)
                    │ (Finale) │└──→ (stays paused)
                    └──────────┘
```

### B2 — Approve & Apply = "Complete"

Dashboard "Approve & Apply" → same logic as Telegram's `approvePendingReconciliation()`:
1. Re-derive reconciliation from stored metadata (eliminates in-memory dependency)
2. Apply changes to Finale via `applyReconciliation()`
3. Mark `reviewed_at` + `reviewed_action = "approved"` in Supabase
4. Card dims with "✓ Applied" badge
5. Write to Pinecone memory for vendor pattern learning

### B3 — Reject → Pause for Research

Reject doesn't force immediate resolution. Instead:
1. Sets status to **"PAUSED"** — amber badge, stays visible
2. `reviewed_action = "paused"` in Supabase
3. No Finale changes applied
4. When ready, user returns to the card and picks:
   - ✅ **Approve & Apply** — researched, it's correct
   - 🔄 **Re-match** — smart PO matching (see B4)
   - ⏭️ **Dismiss** — confirmed not applicable (see B5)

### B4 — Re-match: Natural Language + Smart Suggestions

Instead of bare PO# input:

1. **Auto-suggest matches** — search Finale for vendor's recent open POs, show as tappable chips:
   `PO-4521 (Mar 1, $1,240)` · `PO-4487 (Feb 22, $890)`
2. **Natural language input** — type things like:
   - `"the March 1st order"` → Aria finds it
   - `"4521"` → direct match
   - `"the big castings order"` → searches by product keywords
3. Aria responds inline, confirms match, re-runs reconciliation against new PO
4. Result feeds back into the same approve/reject flow

### B5 — Dismiss Options

| Option | Action | Learning |
|--------|--------|----------|
| 📦 **Dropship** | Forward to Bill.com, mark as dropship | Adds vendor to known dropship list for future auto-routing |
| ✅ **Already handled** | No action, clear card | Notes that manual handling occurred — tracks frequency |
| 🔁 **Duplicate** | Log duplicate, clear | Strengthens dedup detection for future invoices |
| 💳 **Credit memo** | Forward to Bill.com with credit flag | Improves email classification for future credit memos |
| 📄 **Statement** | No action, clear | Feeds back to intent classifier to improve STATEMENT detection |
| 🚫 **Not ours** | No action, clear | Logs vendor/subject pattern to filter future emails |

**Every dismiss writes the reason to Supabase AND Pinecone memory** so Aria learns:
- Vendor-specific patterns (e.g., "Vendor X invoices are always dropship")
- Common misclassifications to improve the AI parser
- Frequency of manual overrides per vendor

### B6 — Learning for Autonomy

Each action feeds three learning channels:

1. **Pinecone memory** — vendor patterns, approval patterns, price change trends
   - `"Vendor X price increases typically 2-5% and Will always approves"`
   - `"Vendor Y invoices are always dropship"`
2. **Supabase `ap_activity_log`** — full audit trail with `reviewed_action` + `dismiss_reason`
   - Enables queries like: "How often do we reject vendor X reconciliations?"
3. **Vendor profile enrichment** — `vendors` table gets pattern metadata
   - `auto_approve_threshold` per vendor (learned from approval history)
   - `default_dismiss_action` per vendor (learned from dismiss history)

**Autonomy milestones:**
- **Phase 1 (done):** Human reviews every non-auto-approve reconciliation ✅
- **Phase 2 (done):** Dashboard suggests "Based on 8 past approvals for this vendor, auto-approve?" ✅
- **Phase 3:** Vendor-specific thresholds auto-adjust based on approval history

---

## Schema Changes

### `ap_activity_log` — new columns

```sql
ALTER TABLE ap_activity_log
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD COLUMN reviewed_action TEXT,
  ADD COLUMN dismiss_reason TEXT;
```

`reviewed_action` values: `"approved"` | `"paused"` | `"dismissed"` | `"re-matched"` | `"acknowledged"`
`dismiss_reason` values: `"dropship"` | `"already_handled"` | `"duplicate"` | `"credit_memo"` | `"statement"` | `"not_ours"` | null

### Env var addition

```env
NEXT_PUBLIC_FINALE_ACCOUNT_PATH=buildasoil
```

---

## Files Modified

| File | Change |
|------|--------|
| `ActivityFeed.tsx` | Expand RECON cards, real PO links, show changes, approve/reject/dismiss buttons |
| `reconciler.ts` | New `reApplyReconciliation()` function that works from stored metadata |
| `app/api/dashboard/reconciliation-action/route.ts` | **NEW** — approve/reject/pause/dismiss endpoint |
| `app/api/dashboard/rematch-candidates/route.ts` | **NEW** — fetch candidate POs for re-match |
| `.env.local` / `.env.example` | Add `NEXT_PUBLIC_FINALE_ACCOUNT_PATH` |
| Supabase migration | Add `reviewed_at`, `reviewed_action`, `dismiss_reason` columns |

---

## Architecture Decision: Re-derive vs. In-Memory

**Decision:** Re-derive reconciliation from stored metadata when approving from dashboard.

**Rationale:**
- The current `pendingApprovals` Map lives in the bot process (PM2), separate from Next.js
- In-memory state is lost on bot restart
- Storing full ReconciliationResult + invoice data in `ap_activity_log.metadata` already happens
- Dashboard can reconstruct and re-apply from that stored data
- More robust, works regardless of process boundaries or restarts
- Telegram flow continues to use in-memory for speed (it's in the same process)
