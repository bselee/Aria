# basauto-recon review + phantom on-order root cause

**Date:** 2026-08-21
**Author:** Hermia (review of own work, requested by Bill)
**Status:** plan — P0 in progress

## Why this exists

Bill asked for a review of the basauto-recon work shipped in `7246eb2`, a plan, and
confirmation that no zombie code remains. The review found two real defects in my
own work, and researching Bill's question ("there will always be a reason a PO is
this old — need to research why") uncovered a **pre-existing Aria core bug** that is
larger than the panel.

## Concurrency note

A second Hermes session is editing this repo live (09:20–09:22): it owns
`basauto-recon-lookup.ts`, `PurchasingPanel.tsx`, `api/dashboard/purchasing/route.ts`,
`lib/finale/core-client.ts` — wiring basauto's number into the Ordering row as a
third opinion. **Do not touch those four files.** This plan takes only
`lib/finale/purchasing.ts` and `lib/purchasing/basauto-recon.ts`.

---

## 🔴 ROOT CAUSE: phantom on-order in Aria core (pre-existing, not from my commit)

`src/lib/finale/purchasing.ts:2018-2040` (`getProductActivity`):

```ts
if (po.status !== 'Committed' && po.status !== 'Locked') continue;   // line 2021
...
quantity: parseFinaleNumber(ie.node.quantity),                        // line 2033
```

Two compounding faults:

1. **Filters on `status`, which never changes.** Finale keeps a fully-received PO at
   `status: "Committed"` forever. The receipt state lives in `statusExtended`
   ("Committed · Fully received") and, authoritatively, on the line.
2. **Pushes ORDERED quantity, not what remains.** Even a partially-received PO
   contributes its full original quantity as "inbound".

### Ground truth Finale does expose (verified via schema introspection)

`orderItem` carries per-line receipt fields — no heuristics needed:

| Field | Meaning |
|---|---|
| `productUnitsOrdered` | originally ordered |
| `productUnitsReceived` | actually received |
| `productUnitsRemainingToBePackedShippedOrReceived` | **what is genuinely still inbound** |

`order.statusExtended` gives the human-readable roll-up.

### Measured blast radius (live, 2026-08-21)

73 POs credited as on-order across 297 dashboard items:

| statusExtended | count |
|---|---|
| Committed · Fully received | **32** |
| Committed · Not received | 23 |
| Committed · Partially received | 15 |
| Draft · Not received | 2 |

- **80 phantom line-credits / 106,472 phantom units** where `remaining = 0` but Aria
  still counts the full ordered qty as inbound.
- 19 distinct SKUs. Oldest offender: `S-4738` PO#123785 ordered **8/29/2025** (357d).
- `po_lifecycle_cache` holds only **40 of 73** credited POs → the 2026-08-04 local-DB
  fallback structurally cannot suppress the other 33. That is why the earlier fix
  didn't hold.

### Two SKUs are being actively held on stock that is already gone

| SKU | onHand | Aria on-order | phantom | real on-order | rate | Aria runway | REAL runway |
|---|---|---|---|---|---|---|---|
| S-4122 | 126 | 3,800 | 3,800 | **0** | 3.91/d | 1,004d | **32d** |
| S-3902 | 4,633 | 6,001 | 6,001 | **0** | 108.37/d | 98d | **43d** |

Both currently `decision: hold`. This is the stockout-causing direction of the error.

### Why Bill's "research why" was the right call

My proposed heuristic was "PO older than 60 days → downgrade to BORDERLINE". That
would have been wrong twice over:
- It would **miss** PO#125169 (ordered 8/6, fully received, 15 days old) — phantom but young.
- It would **false-flag** PO#125215 (ordered 8/19, genuinely 50 units inbound) — old-ish but real.

Age is a proxy. `remaining` is the fact. No date heuristic survives contact with the data.

---

## 🔴 DEFECT 2: my panel never renders

`src/app/dashboard/page.tsx:122` short-circuits to `CommandBoardShell` whenever
`NEXT_PUBLIC_COMMAND_BOARD_ENABLED !== "false"` (unset → true). The live surface is
the Lifecycle tab, whose three panes are hardcoded in `CommandBoardShell.tsx:70-110`.
The `DEFAULT_LAYOUT` I edited in `useDashboardLayout.ts` is labelled
*"legacy 4-col wall rollback only"* — dead config on the current surface.

Verified: `curl /dashboard | grep basauto-recon` → no match.

The other session's `basauto-recon-lookup.ts` approach (badge on the Ordering row)
is the better surface. Defer mounting to it; revert my dead DEFAULT_LAYOUT edit.

---

## 🟡 Zombie code (all pre-existing; snapshot handoff verified safe)

`basauto-recon` now writes `latest-snapshot.json` (67 requests, 09:15 today, was 33
from Jun 9), so the legacy poller is fully superseded and `BasautoPanel` keeps working.

| Item | Action |
|---|---|
| `scripts/basauto_poll.py` + `__pycache__/basauto_poll.cpython-311.pyc` | delete |
| `scripts/basauto_crossref.ts` | delete (zero refs) |
| `scripts/basauto_true_candidates.ts` | delete (zero refs) |
| `src/lib/purchasing/basauto-request-watcher.ts` | **delete** — Bill confirmed; never called since Slack removal 8/20 |
| `docs/operational-guides/hermes-cron-jobs.canonical.json:251` | update to `basauto-recon` 7am |
| Stale comments: `BasautoPanel.tsx:7`, `basauto-requests/route.ts:4,18`, `basauto-request-watcher.ts:5` | repoint to `src/cli/basauto-recon.ts` |
| Unused fields in my types: `unitsInStock`, `averageBuildConsumption`, `assessmentDecision`, `supplierName`, `stockAvailable` | drop |

---

## Execution order

### P0 — correctness (own now)
1. `purchasing.ts` `getProductActivity`: query `statusExtended` +
   `productUnitsReceived` + `productUnitsRemainingToBePackedShippedOrReceived`;
   credit **remaining**, not ordered; skip lines where remaining is 0. Keep blanket-PO
   exemptions (CR Minerals 10024, Covico 10745).
2. Unit tests: fully-received-but-Committed, partially received, genuinely open,
   Draft, blanket PO, `"--"`/null parsing.
3. `basauto-recon.ts`: OVERBUY_RISK must cite only genuinely-remaining qty; add a
   `phantom-suppressed` note when a cited PO has nothing left to receive.
4. Verify S-4122 → 32d and S-3902 → 43d, and that both leave `hold`.

### P1 — surfacing (coordinate with the other session)
5. Revert dead `DEFAULT_LAYOUT` edit; keep `ALL_PANEL_IDS` + registry entry.
6. Let the other session own the Ordering-row badge; add a shell test once it lands.

### P2 — cleanup
7. Delete the 4 zombie files + `.pyc`; fix 4 stale comments; update canonical cron JSON.
8. Drop the 5 unused fields.

### P3 — follow-up
9. Re-audit `po-reliability-scorer.ts` — its `po_lifecycle_cache` fallback covers
   only 40/73 credited POs; Finale line-level `remaining` should become the primary
   signal there too.
10. Patch `purchasing-calibration-audit` skill: replace the age/lifecycle detection
    recipe with the `remaining`-based one.
