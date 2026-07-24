/**
 * @file    dashboard-design-audit.md
 * @purpose Design + engineering audit of the Aria Ops Board (Command Board
 *          shell). Documents real bugs reproduced live, structural design
 *          debt, and a prioritized fix backlog with file:line references.
 * @author  Hermia
 * @created 2026-07-24
 * @scope   src/app/dashboard, src/components/dashboard/**
 */

# Aria Ops Board — Design & Engineering Audit

Audited live against `http://localhost:3001/dashboard` (PM2 `aria-dashboard`,
Next.js 15.5) plus full read of the rendering code. Every finding below was
either reproduced in the running app or confirmed by reading the source —
nothing in this doc is speculative.

**Scope note:** production defaults to the **Command Board shell**
(`CommandBoardShell.tsx`). The old 4-column drag-panel wall (`page.tsx` →
`LegacyDashboard()`) still exists in the repo behind
`NEXT_PUBLIC_COMMAND_BOARD_ENABLED=false` but is not what anyone sees today.
This doc is about the Command Board. The legacy wall is dead code — see P3.

---

## Severity key

- 🔴 **P0** — live bug, reproduced, breaks the app for users today
- 🟠 **P1** — structural risk, will cause the next P0
- 🟡 **P2** — design/consistency debt, no crash risk but hurts velocity + polish
- ⚪ **P3** — cleanup / dead code

---

## 🔴 P0-1: No error boundaries anywhere → one panel bug blacks out the whole app

**Reproduced live.** Clicking the BUILDS tab threw an unhandled client
exception. Next.js's generic full-screen fallback replaced the *entire*
dashboard — header, tabs, every other panel — with:

> "Application error: a client-side exception has occurred while loading
> localhost (see the browser console for more information)."

**Root cause:** searched the full `src/` tree — there is **no** `error.tsx`
(Next.js App Router convention), no `componentDidCatch`, no React error
boundary of any kind, anywhere in this codebase. `CommandBoardShell.tsx`
renders all 5 tabs' content directly (`tab.render()` at line 337) with
nothing catching a throw.

**Why this matters more than a normal bug:** the Command Board's whole
selling point is "12 operational panels get full canvas, tab switching is
instant" (see the file header comment, lines 4-12). That design explicitly
keeps *every visited tab mounted* so switching is free. It also means a
crash in any one tab's subtree is a crash in the shared React tree for
**all** tabs — there is no per-panel isolation.

**Fix — two layers, both required:**

1. **App-level safety net:** add `src/app/dashboard/error.tsx` (Next.js
   picks this up automatically as the route-segment error boundary). This
   stops the "white screen of death" from replacing the whole app; it at
   least contains the blast radius to the dashboard route with a "Reload"
   affordance.

2. **Panel-level isolation (the real fix):** wrap every panel render in a
   `<PanelErrorBoundary>` inside `CommandBoardShell.tsx`. One panel throwing
   should show *that panel* with an inline "this panel crashed" card —
   every other tab and panel keeps working. This is the difference between
   "Ordering is down" and "the entire Ops Board is down."

```tsx
// src/components/dashboard/PanelErrorBoundary.tsx
"use client";
import React from "react";

type Props = { label: string; children: React.ReactNode };
type State = { error: Error | null };

/**
 * @purpose Contains a single panel's render crash so it doesn't take down
 *          sibling panels or the shell. Every panel in panelRegistry.tsx
 *          and every tab in CommandBoardShell.tsx MUST be wrapped in this.
 */
export class PanelErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[PanelErrorBoundary] ${this.props.label} crashed:`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-6 gap-2 text-center">
          <span className="text-rose-400 text-sm font-mono">
            {this.props.label} crashed
          </span>
          <span className="text-zinc-500 text-xs max-w-sm">
            {this.state.error.message}
          </span>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-2 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-xs"
          >
            Retry panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

Apply it at the tab level in `CommandBoardShell.tsx` (wraps `tab.render()`,
line ~337) **and** inside `panelById()` (line 190-193) so nested panels
(e.g. the 3-pane Lifecycle grid) are each independently isolated:

```tsx
// CommandBoardShell.tsx — panelById, isolate each sub-panel
const panelById = useCallback(
  (id: PanelId) => (
    <PanelErrorBoundary label={PANEL_BY_ID[id]?.label ?? id}>
      {PANEL_BY_ID[id]?.render() ?? <div className="p-4 text-zinc-500">panel missing: {id}</div>}
    </PanelErrorBoundary>
  ),
  [],
);
```

```tsx
// CommandBoardShell.tsx — tab render, isolate each tab
<div key={tab.id} className={...}>
  <PanelErrorBoundary label={tab.label}>
    {tab.render()}
  </PanelErrorBoundary>
</div>
```

---

## 🔴 P0-2: Crash state is persisted to localStorage → app re-crashes on every reload until manually cleared

**Reproduced live.** After the BUILDS tab crashed, I navigated fresh to
`/dashboard` — it crashed again **immediately**, before I clicked anything.

**Root cause:** `CommandBoardShell.tsx` lines 130-139:

```tsx
useEffect(() => {
    if (typeof window === "undefined") return;
    try {
        const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
        const RETIRED = new Set([...]);
        if (saved && RETIRED.has(saved)) setActiveTab("lifecycle");
        else if (saved) setActiveTab(saved as TabId);   // ← line 137, unvalidated
    } catch { /* ignore */ }
}, []);
```

`activeTab` is written to `localStorage["aria-dash-active-tab"]` on every
tab switch (line 143). On mount, it's read back and cast to `TabId` with no
membership check against the actual `tabs` array. If the *content* of a tab
throws (not the tab id itself — the tab id "builds" is perfectly valid), the
next page load restores straight into that same crashing tab and crashes
again, before the user can do anything to recover. The only way out today is
opening devtools and manually clearing `localStorage`. I did this to
un-brick the app during this audit — this is not a hypothetical.

The existing `RETIRED` set (line 135) proves the team already knows
"validate what comes out of localStorage before trusting it" — it's just
scoped to *renamed* tab ids, not to *crashing* tab content.

**Fix:** this is precisely what P0-1's error boundaries solve at the
render layer — but layer this belt-and-suspenders fix on top so a crash
never becomes unrecoverable without devtools:

```tsx
// CommandBoardShell.tsx
const [activeTab, setActiveTab] = useState<TabId>("lifecycle");
const [tabCrashed, setTabCrashed] = useState<Record<TabId, boolean>>({} as any);

// In PanelErrorBoundary's componentDidCatch callback (pass a prop down),
// mark the tab as crashed and fall back to "lifecycle" on the NEXT mount,
// not the current one — current one still shows the boundary's fallback UI.
```

Simpler and sufficient: **don't restore into a tab whose last render
attempt failed.** Store a `aria-dash-crash-tab` flag alongside the tab id
when `PanelErrorBoundary.componentDidCatch` fires; clear it on a successful
render; check it before trusting the restored tab on mount. With P0-1 in
place this becomes a nice-to-have rather than the only line of defense —
but ship both.

---

## 🔴 P0-3: Ordering / Lifecycle panel is stuck in permanent "Loading purchasing data…" under a Finale 429 storm

**Reproduced live** — screenshot shows the loading skeleton never resolving
across multiple refreshes, minutes apart. PM2 error log
(`aria-dashboard-error.log`) shows the actual mechanism:

```
[FinaleCoreClient] 429 rate-limited on GET /buildasoilorganics/api/shipment/124964-1 — waiting 5s (attempt 3/3)
[FinaleCoreClient] 429 rate-limited on GET /buildasoilorganics/api/shipment/124905-1 — waiting 5s (attempt 1/3)
... (dozens of shipment IDs, same pattern, sustained)
```

Something in the Ordering data path is issuing **one Finale API call per
shipment ID**, sequentially or in an uncapped burst, and Finale is rate
limiting it into a retry storm (3 attempts × 5s backoff per ID × dozens of
IDs). The panel's loading state is gated on this entire chain completing, so
it never resolves while the storm is running.

**This is your primary "what needs ordering today" view being functionally
dead** whenever build/shipment volume is high enough to trigger it — which
is exactly when you need it most.

**Root cause traced — exact location:** `src/lib/finale/receivings.ts`
lines 113-135, inside the received-POs fetch used by the Ordering/Receivings
data path:

```ts
const receivedOrderIds = new Set(received.map((po) => po.orderId));
const shipmentDetailsByOrderId: Record<string, any[]> = {};
await Promise.all(edges.map(async (edge: any) => {           // ← outer fan-out: one task per PO
    const po = edge.node;
    if (!receivedOrderIds.has(po?.orderId)) return;

    const allShipmentIds = (po.shipmentList || [])
        .map((shipment: any) => String(shipment?.shipmentId || ""))
        .filter(Boolean);
    const urls: string[] = allShipmentIds.map((shipmentId) =>
        `/${this.accountPath}/api/shipment/${encodeURIComponent(shipmentId)}`);

    const details = await Promise.all(urls.map(async (url) => {   // ← inner fan-out: one GET per shipment
        try { return await this.getShipmentDetails(url); }
        catch { return null; }
    }));

    shipmentDetailsByOrderId[po.orderId] = details.filter(Boolean);
}));
```

This is a **double-nested, fully unbounded `Promise.all`**: outer loop over
every received PO on the page, inner loop over every shipment on that PO,
each firing an individual `GET /api/shipment/{id}` with zero concurrency
cap. A page of 40-50 received POs with 2-3 shipments apiece fires
100-150+ simultaneous requests in the same tick. `FinaleCoreClient`'s
process-wide "120 req/min" limiter (core-client.ts ~line 301) throttles
*rate* but does nothing to stop this call site from *queuing* all of them
at once — so they all get 429'd together and all retry together (3
attempts × 5s backoff each), which is the exact log pattern captured
during this audit. There is also **no caching** of shipment details
between polls, so this fires again on every 30s dashboard poll.

A second, much smaller instance of the same pattern exists at
`src/lib/finale/reconciler.ts` line 2448 (tracking-update write path) but
it only reads `shipUrls[0]` — not a fan-out, lower priority, note but don't
block on it.

**Fix, in order of impact:**
1. **Cap concurrency** on the inner shipment-detail fan-out (e.g. batches
   of 5-8 via a small `pLimit`-style helper) — stops the instant-storm even
   before anything else changes.
2. **Cache shipment details** (`shipmentDetailsByOrderId`) keyed by
   shipment ID with a short TTL (e.g. 5 min) — most shipments don't change
   status between 30s polls, so repeated identical fetches are pure waste.
3. **Investigate whether Finale's API supports a batch/filter shipment
   query** (`/api/shipment?orderId=in:(...)` or similar) to collapse N
   per-ID GETs into one call — check Finale API docs/existing usages in
   `src/lib/finale/client.ts` before assuming this doesn't exist.
4. Regardless of the above: **the panel should never loading-spin
   forever.** Add a client-side timeout (e.g. 15s) that flips to an error/
   stale-data state with a "Retry" button instead of an infinite skeleton.

**This same code path is suspected to be why PO creation "takes forever"**
— per Bill's live observation, PO creation and dashboard loading are both
slow, and both plausibly walk through received-PO/shipment enrichment
(`receivings.ts`) as part of validating existing orders before committing
a new one. Confirm this via profiling (P0-3 subagent should time the
PO-commit request path specifically, not just assume) before treating it
as fully explained by this fix — it's the leading hypothesis, not a
confirmed second root cause yet.

---

## 🟠 P1-1: Design tokens exist but are barely used — consistency depends on developer memory, not the system

`src/app/globals.css` defines a real semantic token layer:

```css
--dash-l1: #E8E8E8;       /* Entity names — vendors, SKUs */
--dash-l2: #888888;       /* Metadata — qty, price, dates */
--dash-l3: #666666;       /* System labels — CRIT, WARN, mono uppercase */
--dash-ts: #555555;       /* Timestamps — dimmed, right-aligned */
--dash-ts-stale: #883333; /* Timestamps > 24h — subtle warm tint */
--dash-accent-human: rgba(244, 63, 94, 0.6);
--dash-accent-pending: rgba(251, 191, 36, 0.6);
```

This is good — it encodes a real information hierarchy (entity vs metadata
vs system label vs timestamp) and matches the semantic color convention
already in use across Aria (red=action, amber=attention, cyan=progress,
emerald=done, rose=exception). But grepping the panel components shows most
of them reach for raw Tailwind utility classes (`text-zinc-400`,
`bg-rose-500/20`, `text-amber-300`) instead of these tokens. `tailwind.config.ts`
doesn't even register the `--dash-*` vars as theme colors, so there's no
autocomplete/lint nudge toward using them — a dev writing a new panel today
has to already know the tokens exist and remember to reach for them by
hand-typing the CSS var.

**Fix:**
1. Register the tokens in `tailwind.config.ts` as first-class colors:
   ```ts
   colors: {
     "dash-l1": "var(--dash-l1)",
     "dash-l2": "var(--dash-l2)",
     "dash-l3": "var(--dash-l3)",
     "dash-ts": "var(--dash-ts)",
     "dash-ts-stale": "var(--dash-ts-stale)",
   }
   ```
   Now `text-dash-l2` etc. are usable Tailwind classes with autocomplete.
2. Sweep existing panels opportunistically (not a big-bang rewrite) —
   whenever a panel is touched for any other reason, replace its ad-hoc
   `text-zinc-400`/`text-zinc-500` metadata classes with the matching
   `text-dash-l*` token. Track via a checklist in this doc (see Backlog).

---

## 🟠 P1-2: No shared panel contract — every panel reinvents header/loading/empty/error

18 panels registered in `panelRegistry.tsx`, each independently implementing
its own header row, loading skeleton, empty state, and (per P0-1) no error
state at all. `BuildSchedulePanel.tsx` alone is **972 lines** — data
fetching, date math, risk sorting, and the entire render tree in one file.
`BuildRiskPanel.tsx` is 268 lines doing the same shape of work. This is
exactly the kind of surface where an unguarded date-parse or `undefined`
property access takes down a tab (P0-1/P0-3's blast radius).

**Fix:** introduce a shared `<Panel>` primitive that every registry entry is
built on top of, e.g.:

```tsx
// src/components/dashboard/Panel.tsx
type PanelProps = {
  title: string;
  icon?: React.ReactNode;
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyMessage?: string;
  lastUpdated?: number | null;
  actions?: React.ReactNode;   // refresh button, filters, etc.
  children: React.ReactNode;
};

export function Panel({ title, loading, error, empty, emptyMessage, lastUpdated, actions, children }: PanelProps) {
  return (
    <div className="flex flex-col h-full min-h-0" data-testid={`panel-${title}`}>
      <header className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60 shrink-0">
        <h2 className="text-xs font-mono uppercase tracking-wider text-dash-l3">{title}</h2>
        <div className="flex items-center gap-2">
          {lastUpdated && <span className="text-[10px] text-dash-ts">{timeAgo(lastUpdated)}</span>}
          {actions}
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-auto">
        {error ? <PanelErrorState message={error} />
         : loading ? <PanelLoadingSkeleton />
         : empty ? <PanelEmptyState message={emptyMessage} />
         : children}
      </div>
    </div>
  );
}
```

Migrate panels incrementally — this is not a rewrite-everything-at-once
task. Every *new* panel from today forward must use `<Panel>`. Existing
panels get migrated opportunistically when touched.

---

## 🟡 P2-1: Inconsistent density and layout grammar across tabs

- **Lifecycle** tab: 3-column CSS grid (`minmax(560px,1.4fr)` /
  `minmax(480px,1fr)` / `minmax(400px,0.9fr)`), everything visible at once,
  no scroll within the tab.
- **Builds** tab: two panels stacked vertically in a scrolling flex column
  — very different interaction model from Lifecycle's fixed grid.
- **Axiom SKUs** / **Kanban**: unrelated full-page widgets bolted on as
  tabs, each with their own internal layout conventions.

None of this is *wrong* individually, but there's no written rule for "when
does a new operational surface become a new tab vs. a new panel within an
existing tab vs. a column in the Lifecycle grid." Right now that's decided
ad hoc per PR. Write the rule down (see Backlog: Dashboard Contributor
Guide) so the next 5 panels don't each invent a new layout idiom.

## 🟡 P2-2: No client-side timeout/escape on any loading state

Same root issue as P0-3 but generalized: skim of the panel components shows
the "loading" pattern is universally "show skeleton until fetch resolves,"
with no timeout anywhere. Any slow/stuck upstream (Finale, PostgREST, WSL
bridge — all documented as flaky in this environment) produces the same
infinite-skeleton dead end in whichever panel depends on it. This should be
a standard feature of the shared `<Panel>` primitive (P1-2), not something
each panel author has to remember to add.

---

## P2-3: Clutter audit — two panels have redundant, stacked filter/status UI

Screenshot review (2026-07-24, post-429-fix, panels finally loading real
data) surfaced a distinct problem from anything above: it's not broken, it's
**noisy**. Once real data renders, both the Ordering panel and Active
Purchases panel show 3+ layers of overlapping chips/filters before a single
actual line item appears. This is a genuine UX regression risk as data
volume grows — traced to specific code, not just a vibe.

### Ordering panel (`PurchasingPanel.tsx`) — THREE stacked filter rows

1. **Time-window pills** (line ~1678-1680): `TODAY / 30 / 60 / 90 / ALL` —
   cumulative day-window filter, each showing a count.
2. **Lifecycle-bucket pills** (line ~1780-1783): `Need Order / Topping Up /
   On Order / Other Holds / All` — a *second*, independent filter axis,
   rendered as its own row directly below #1, visually identical pill
   style (colored border + count badge) so the eye can't tell these are
   two different filter systems, not one continuous row.
3. **"Order Now (2)" chip** (below both): a third summary/action control
   in the same visual language (pill, count badge).

All three are legitimate, useful filters individually. The problem is
purely presentation: identical visual weight (same pill shape, same badge
style, same color-coded borders) makes 3 unrelated control groups read as
one confusing wall of 12+ chips. A user has to consciously segment them by
reading label text, not by any visual grouping cue (spacing, section
label, iconography).

**Fix — visual hierarchy, not fewer features:**
- Give each filter *row* a small uppercase micro-label to its left (e.g.
  "WINDOW", "STATUS") so the two axes are visually distinct groups, not
  one long chip soup. ~4px of `text-dash-l3` label solves most of this.
- Demote the "Order Now (N)" chip to a different visual treatment (e.g.
  a solid button, not a pill matching the filter chips) since it's an
  action/shortcut, not a filter — currently it's visually indistinguishable
  from the filter pills next to it, which is the single biggest
  "what am I looking at" confusion point in the screenshot.
- Consider collapsing the time-window row by default (behind the existing
  chevron affordance at line ~1678's container) since the lifecycle-bucket
  row is the one Bill actually uses day-to-day per his stated workflow —
  the audit `dashboard-design-audit.md` conversation confirms priority is
  "reorder? given demand" not "what's due in the next N days" as the
  primary lens.

### Active Purchases panel — summary chips duplicate per-row badges

`59 Active / 7 Overdue / 44 No Tracking` chips (~line 590-664) sit directly
above a list where **every row already carries its own status badge**
(`In Transit`, `⚠ OVERDUE 35d`, etc. — visible per-row in the screenshot).
The header chips are aggregate counts of the exact same signal each row
already displays individually. They're not wrong, just redundant real
estate — in a dense list this reads as "the same information, said twice."

**Fix:**
- Keep the header chips as **filter toggles** (they already partially are
  — `filterOverdue` state exists at line 152) but make that affordance
  visually obvious (e.g. underline-on-hover, pressed state) so they read
  as "click to filter" controls, not passive repeated counters.
- Do NOT remove the per-row badges — those are the actually useful signal
  when scanning a list. The header chips should feel like a *lens*, not
  a second data source.

### Underlying structural note (ties to P1-2)

Both `PurchasingPanel.tsx` (3,018 lines) and `ActivePurchasesPanel.tsx`
(1,430 lines) contain enormous type surfaces (`UrgencyTier`,
`LifecycleBucket`, `FocusFilter`, ETA confidence, tracking-source
provenance, sent-verification evidence chains, etc.) and — predictably —
most of those internal concepts have grown their own visible badge over
time with no shared "badge/chip" component enforcing consistent visual
weight between "this is a filter," "this is a status," and "this is an
action." This is the same root cause as P1-2 (no shared `<Panel>`
primitive) manifesting one level deeper: no shared `<FilterChip>` /
`<StatusBadge>` / `<ActionChip>` primitives either, so every new state a
developer adds gets rendered in whatever pill style was copy-pasted from
the nearest existing one — regardless of whether it's semantically a
filter, a status, or an action.

**Fix (do this once, benefits every future badge):** build 3 small
primitives — `<FilterChip active count onClick>`, `<StatusBadge tone
label>`, `<ActionChip label onClick>` — with deliberately distinct visual
languages (chips = outlined pill, status = solid/tinted badge, action =
filled button). Migrate the Ordering + Active Purchases panels first since
they're the worst offenders; other panels benefit as they're touched.

---

## ⚪ P3-1: Dead legacy dashboard code

`src/app/dashboard/page.tsx` still ships `LegacyDashboard()` — the old
4-column drag-and-drop panel wall with its own resize handlers, its own
`SortablePanel.tsx`, its own layout persistence keys
(`aria-dash-left-w`, `aria-dash-midleft-w`, `aria-dash-midright-w`,
`aria-dash-chat-open`, plus `LAYOUT_STORAGE_KEY`). It's reachable only via
`NEXT_PUBLIC_COMMAND_BOARD_ENABLED=false`, which nothing in the repo sets.
This is ~280 lines of parallel dead-but-compiled code that every future
dashboard change has to visually scan past and reason about ("is this the
file that's live?").

**Recommendation:** if there's no near-term rollback scenario planned,
delete `LegacyDashboard()` and its dedicated bits
(`ColHandle`, `startLeftResize`/`startMidLeftResize`/`startMidRightResize`,
the `Column` droppable wrapper, `SortablePanel.tsx` if nothing else uses
it) and keep `page.tsx` as a one-line `<CommandBoardShell />` export. If
you want a rollback path, keep it — but say so explicitly in the file
header comment with a reason, not just "one env, one fallback" with no
expiry.

---

## New surface: Invoice Approval Review page (design approved 2026-07-24)

A separate Hermes desktop session designed a dedicated `/dashboard/invoice-review`
page — full-width side-by-side invoice-vs-PO comparison for AP approval
decisions, replacing the current compressed-text-in-a-feed pattern in
`InvoiceQueuePanel`/`ActivePurchasesPanel`. Zero new backend: reuses
`GET /api/dashboard/pending-approvals` and `POST /api/dashboard/reconciliation-action`
as-is. Design approved with three tie-ins to this audit, all cheap, do them
from day one rather than retrofitting:

1. **Wrap the focused-review pane in `PanelErrorBoundary`** (P0-1) —
   two-column diff rendering off nullable reconciliation fields
   (`feeChanges`, `warnings[]`, possibly-missing PDF paths) is a realistic
   crash surface. Build this page only after `PanelErrorBoundary.tsx` lands
   (backlog item 1 below) and use it as the first real consumer.
2. **Use `--dash-l1/l2/l3` tokens, not raw Tailwind grays** (P1-1) — the
   page's own hierarchy (entity header / line-item metadata / warning
   labels) maps directly onto the existing token semantics. Build this
   after backlog item 7 (Tailwind token registration) lands so it's the
   first page built "correctly" against the design system instead of
   another one-off.
3. **Bounded loading state with timeout → error/retry** (P2-2) — this page
   fetches from the same PostgREST/Finale stack documented elsewhere as
   flaky; don't let it infinite-skeleton like the current Ordering panel.

Sequencing: build this page AFTER backlog items 1-4 and 7 land (see table
below) so it inherits the fixes instead of needing a follow-up patch.

**Status (2026-07-24): DONE.** Built `src/app/dashboard/invoice-review/page.tsx`
after verifying all 3 dependencies live on disk (not just trusting the
in-flight subagent reports — `PanelErrorBoundary.tsx` had timed out once
before landing on a retry). All 3 tie-ins applied as specified.

**Correction to the data-source list above:** `GET /api/dashboard/pending-approvals`
is NOT the live source — the one row in `ap_pending_approvals` in the local
DB has `status: "expired"` and the table isn't written to by the current
reconciliation flow. `InvoiceQueuePanel` (the panel this page supersedes for
the decision moment) actually reads `GET /api/dashboard/invoice-queue`
(sourced from `invoices` + `ap_activity_log`, keyed by `activityLogId`) and
posts to `reconciliation-action` with that same id. The new page uses
`invoice-queue` + `activityLogId`, matching `InvoiceQueuePanel`'s real
wiring — `pending-approvals` looks like dead/superseded code from an earlier
iteration and is worth a follow-up prune (not done here — out of scope).

**Known data gap surfaced during testing:** the one live `needs_approval`
row today (Marion Ag Service, Invoice #85974 → PO #124977, auto-matched via
the PO-sweep path) has `metadata` with no `priceChanges`/`feeChanges` array
— that auto-match path doesn't attach line-item diff detail the way the
dashboard-approval path does (`reconciliation-action.ts` L79). The page
correctly falls back to an honest "no line-item differences recorded"
message rather than fabricating a diff. If diff detail should always be
attached, that's a gap in the PO-sweep reconciliation write, not in this
page — flagging as a candidate follow-up, not fixing here (out of scope).

Entry points added: a "review →" link in `InvoiceQueuePanel`'s header
(shown only when there's a pending queue).

---

## Prioritized backlog (do in this order)

| # | Item | Files | Effort |
|---|------|-------|--------|
| 1 | `PanelErrorBoundary` component | new: `src/components/dashboard/PanelErrorBoundary.tsx` | S |
| 2 | Wrap all tab renders + `panelById()` in the boundary | `CommandBoardShell.tsx` L190-220, L327-340 | S |
| 3 | Add `src/app/dashboard/error.tsx` route-level fallback | new file | S |
| 4 | Guard `activeTab` localStorage restore against crash state | `CommandBoardShell.tsx` L130-139 | S |
| 5 | Cap concurrency + cache shipment lookups (double-nested `Promise.all` fan-out) | `src/lib/finale/receivings.ts` L113-135 | M |
| 5b | Profile PO-commit path — confirm/rule out same receivings.ts path as cause of slow PO creation | `src/app/api/dashboard/purchasing/commit/route.ts`, `po-modify/route.ts` | S (profiling) |
| 6 | Add client-side loading timeout → error state, generically | shared `<Panel>` (item 8) or ad hoc per panel as stopgap | S per panel |
| 7 | Register `--dash-*` tokens in `tailwind.config.ts` | `tailwind.config.ts` | XS |
| 8 | Build shared `<Panel>` primitive; migrate 1-2 panels as proof | new: `src/components/dashboard/Panel.tsx` | M |
| 9 | Write the "when is it a tab vs panel vs grid column" contributor rule into this doc | this file | XS |
| 10 | Decide fate of `LegacyDashboard()` — delete or document why it stays | `page.tsx` | XS |
| 11 | ✅ DONE — Build `/dashboard/invoice-review` page (design approved, see above) — AFTER items 1-4 + 7 land | new: `src/app/dashboard/invoice-review/page.tsx` + focused-review component | M |
| 12 | Clutter fix: visually separate the 3 stacked filter rows in Ordering panel (window/lifecycle/action) | `PurchasingPanel.tsx` L1678-1822 | S |
| 13 | Clutter fix: make Active Purchases header chips read as filter toggles, not duplicate counters | `ActivePurchasesPanel.tsx` L590-664 | S |
| 14 | Build `<FilterChip>`/`<StatusBadge>`/`<ActionChip>` primitives with distinct visual languages | new: `src/components/dashboard/chips/` | M |

Items 1-4 are the ones that actively hurt you today — they're the reason
this audit exists. Do those first, independent of everything else.

**Status (2026-07-24):** Items 1-4 and 7 landed and were independently
verified live against the running PM2 process (not just trusted from
subagent self-reports) — see "Verification log" below. Item 5 landed
partially: the double-nested fan-out is fixed and confirmed via test suite,
but live testing after the fix still showed active 429s from a *separate*
source (product/resale-scan lookups, same one flagged in commit `2a8073b`)
— so item 5 stays open pending that separate source being addressed. Item
5b (PO-commit profiling) is done: confirmed NOT a direct fan-out in the
commit path itself, but the global rate-limiter clogging from the shipment
storm is the suspected indirect cause, which item 5's fix should partially
relieve.

## Verification log

- **PanelErrorBoundary + wiring (items 1-4):** live-tested by navigating to
  the Builds tab, which has a genuine pre-existing bug
  (`e.channel is not a function` in BuildSchedulePanel/BuildRiskPanel — a
  separate bug, not part of this fix). Confirmed the app did NOT
  black-screen: each broken panel showed its own isolated "crashed" card
  with a Retry button, all other tabs stayed fully interactive. Reloaded
  the page fresh afterward — no re-crash, tab restore correctly validated
  against `VALID_TABS` allow-list.
- **receivings.ts fan-out fix (item 5):** `npx vitest run src/lib/finale/receivings.test.ts`
  — 9/9 passed. Confirmed via `git stash` that the one failing test in
  `CommandBoardShell.test.tsx` (`ReceivedItemsPanel` fetch-mock gap) is
  pre-existing on the baseline commit, not a regression from this work.
- **Tailwind tokens (item 7):** config parses, 2 spot-migrations in
  `MarkdownRenderer.tsx` confirmed present via diff review.
- **Not yet independently re-verified after landing:** whether the 429
  volume dropped meaningfully in absolute terms over a full dashboard
  boot cycle — the concurrency cap and cache are proven correct in
  isolation, but a full before/after log comparison under real load
  hasn't been run. Worth doing before declaring the Ordering panel
  "fixed" to Bill.

---

## Verification steps for each fix

- **P0-1/P0-2:** In devtools console, run
  `throw new Error("test")` inside a panel's render path (or temporarily
  add one), confirm only that panel's boundary fires and the rest of the
  Ops Board keeps working. Reload the page — confirm it does NOT re-crash.
- **P0-3:** Watch `pm2 logs aria-dashboard --lines 0` while loading the
  Lifecycle tab; confirm no unbounded per-ID Finale call storm, and confirm
  the Ordering panel resolves (or shows a clear timeout/error state) within
  a bounded time even under load.
- **P1-1/P1-2:** `grep -rn "text-zinc-4\|text-zinc-5" src/components/dashboard/*.tsx | wc -l` before/after a migration pass, trending toward zero for metadata-role text.
