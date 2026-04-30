# Command Board UI Renovation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Renovate `/dashboard` into a polished, performant agentic command center that visibly controls issues, agents, skills, playbooks, and ops modules without returning to the browser-killing panel wall.

**Architecture:** Keep the backend issue/control/orchestrator APIs as the source of truth. The dashboard becomes a client-side command surface over `/api/command-board/issues`, issue detail/actions, agents, tools/capabilities, crons, and existing ops panel APIs. Use a split workspace: issue command center first, contextual detail second, agent/capability/control rail third, and ops modules as full-canvas workspaces.

**Tech Stack:** Next.js App Router, React, Tailwind CSS, lucide-react, Testing Library, Vitest, Playwright for isolated browser/performance checks, existing command-board APIs and dashboard panels.

---

## Design Target

The previous UI failed because it tried to show everything at once: agent tree, task lanes, crons, task detail, and ops modules all in one dense viewport. The new target is not another panel wall. It is an operational console.

| Area | Current | Target |
| --- | --- | --- |
| First viewport | Tab shell with `Blocking Me` list | Command center with issue queue, selected issue detail, agent/control rail |
| Primary unit | Mixed tasks/modules | `agent_issue` as parent unit |
| Control | Approve/reject/resolve only | Control mode, handler, pause/resume, run next, blocker, timeline |
| Agents | Hidden health chip only | Compact live agent rail with currently handling counts and skills |
| Skills/tools | Mostly invisible | Capability drawer tied to selected issue/agent |
| Ops modules | Full-canvas tabs | Full-canvas workspace, but one click from issue context |
| Performance | Visited tabs stay mounted, heavy panels can accumulate | Lazy mount with explicit unload/keep-alive rules and performance budget |

## Non-Negotiable Guardrails

- Do not reintroduce the old 4-column draggable dashboard as the default.
- Do not render all ops panels at boot.
- Do not keep every visited heavy tab mounted forever.
- Do not fetch agents/tasks/heartbeats/crons at boot unless the visible surface needs them.
- Do not add animations except small opacity/transform feedback under 200ms.
- Use `h-dvh`, not `h-screen`, in new shell code.
- Use lucide icons for controls; icon-only buttons require `aria-label`.
- Avoid gradients, glow, decorative blobs, and marketing layout.
- Keep existing panel ids and localStorage keys intact.
- Existing ops panel internals are composition-only unless a test proves a panel itself breaks.
- Add performance checks before and after visual work. Dashboard must be allowed to become useful, but not at the cost of killing Chrome.

## Target Information Architecture

```text
/dashboard
  Top bar
    Aria Command Board
    Need You / Active / Blocked / Agents / Crons
    Refresh / command palette later

  Left rail: Command Nav
    Issues
    Agents
    Ops Modules
    Runs
    Settings

  Main default: Issues
    Left: issue queue grouped by Need You, Working, Waiting, Blocked, Recently Closed
    Center: selected issue detail, next action, timeline, linked tasks, source data
    Right: agent/capability/control rail for selected issue

  Ops workspace
    AP / Receivings / Ordering / Tracking / Builds / Statement Recon
    One active module mounted at a time by default
```

## Subagent Ownership

- Performance worker: Task 0 and Task 9.
- UI architecture worker: Tasks 1 and 2.
- Issue command worker: Tasks 3 and 4.
- Agent/capability worker: Task 5.
- Ops workspace worker: Task 6.
- Visual polish worker: Task 7.
- Integration reviewer: Task 8.

Do not let two workers edit the same files at once.

---

## Task 0: Baseline Dashboard Performance And Failure Guard

**Purpose:** Establish a measurable baseline before renovating. The dashboard may be working now, but the prior browser failure must become a testable constraint.

**Files:**
- Create: `tests/dashboard/dashboard-smoke.spec.ts`
- Create: `src/components/dashboard/command-board/performanceBudget.ts`
- Modify: `package.json` only if adding a script is useful.

**Step 1: Write Playwright smoke test**

Create `tests/dashboard/dashboard-smoke.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("dashboard first viewport loads without runaway console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", msg => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", err => errors.push(err.message));

  await page.goto("http://localhost:3001/dashboard", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("command-board-shell")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Aria/i).first()).toBeVisible();

  expect(errors.slice(0, 5)).toEqual([]);
});
```

**Step 2: Add performance budget constants**

Create `src/components/dashboard/command-board/performanceBudget.ts`:

```ts
export const DASHBOARD_PERF_BUDGET = {
  bootApiCallsMax: 3,
  visibleScrollableRegionsMax: 4,
  heavyPanelsMountedAtBootMax: 0,
  pollIntervalMs: 30_000,
};
```

**Step 3: Run smoke test manually only with dev server already running**

Run:

```powershell
npx playwright test tests/dashboard/dashboard-smoke.spec.ts --project=chromium
```

Expected:

- Pass on a local dev server.
- If it fails due to no server, record as skipped in PR notes; do not start random servers in automation.

**Step 4: Checkpoint**

Run:

```powershell
npm test -- src/components/dashboard/command-board/CommandBoardShell.test.tsx
```

Expected: pass.

**Step 5: Commit**

```powershell
git add tests/dashboard/dashboard-smoke.spec.ts src/components/dashboard/command-board/performanceBudget.ts package.json
git commit -m "test(dashboard): add command board performance smoke guard"
```

---

## Task 1: Create Dashboard View Model Layer

**Purpose:** Stop components from each shaping API responses differently. Add a small frontend view-model layer for issues, agents, capabilities, and shell metrics.

**Files:**
- Create: `src/components/dashboard/command-board/viewModels.ts`
- Create: `src/components/dashboard/command-board/viewModels.test.ts`
- Modify: `src/components/dashboard/command-board/types.ts`

**Step 1: Write failing tests**

Test:

- `issueUrgency()` sorts human approvals first, then blocked, working, waiting, complete.
- `formatAge()` handles seconds/minutes/hours/days.
- `issueControlLabel()` maps control mode to short UI labels.
- `groupIssues()` returns `needYou`, `working`, `waiting`, `blocked`, `recentlyClosed`.

```ts
import { groupIssues, issueUrgency, formatAge } from "./viewModels";

it("groups human approval issues first", () => {
  const grouped = groupIssues([
    { id: "a", lifecycle_state: "working", blocker_reason: null } as any,
    { id: "b", lifecycle_state: "blocked", blocker_reason: "human_approval_required" } as any,
  ]);
  expect(grouped.needYou.map(i => i.id)).toEqual(["b"]);
});
```

**Step 2: Run red**

```powershell
npm test -- src/components/dashboard/command-board/viewModels.test.ts
```

Expected: module missing.

**Step 3: Implement view models**

Create pure functions only. No React, no fetch.

```ts
export function formatAge(seconds: number): string { /* s/m/h/d */ }
export function issueUrgency(issue: CommandBoardIssue): number { /* deterministic rank */ }
export function groupIssues(issues: CommandBoardIssue[]): IssueGroups { /* buckets */ }
export function issueControlLabel(mode?: string | null): string { /* Observe/Suggest/Approval/Auto */ }
export function healthTone(input: "fresh" | "stale" | "degraded" | "error" | "ok"): "zinc" | "emerald" | "amber" | "rose" { /* */ }
```

**Step 4: Run focused test**

```powershell
npm test -- src/components/dashboard/command-board/viewModels.test.ts
```

Expected: pass.

**Step 5: Checkpoint**

Run:

```powershell
npm run typecheck
```

Expected: pass.

**Step 6: Commit**

```powershell
git add src/components/dashboard/command-board/viewModels.ts src/components/dashboard/command-board/viewModels.test.ts src/components/dashboard/command-board/types.ts
git commit -m "feat(dashboard): add command board view models"
```

---

## Task 2: Replace Tab Shell With Command Workspace Shell

**Purpose:** Change the dashboard frame from “tabs across the top” to an operational shell with command nav, visible issue workspace, and lazy ops workspace.

**Files:**
- Modify: `src/components/dashboard/command-board/CommandBoardShell.tsx`
- Create: `src/components/dashboard/command-board/CommandNav.tsx`
- Create: `src/components/dashboard/command-board/ShellTopBar.tsx`
- Create: `src/components/dashboard/command-board/CommandBoardShell.layout.test.tsx`

**Step 1: Write failing layout tests**

Assert:

- Shell renders top bar.
- Shell renders command nav with Issues, Agents, Ops, Runs.
- Default workspace is Issues.
- Boot fetches no more than `/api/command-board/issues` plus summary endpoint.
- Ops panels do not mount at boot.

```ts
it("does not mount ops panels at boot", async () => {
  render(<CommandBoardShell fetchImpl={fetchImpl} />);
  expect(screen.queryByText(/Ordering/i)).not.toBeInTheDocument();
});
```

**Step 2: Run red**

```powershell
npm test -- src/components/dashboard/command-board/CommandBoardShell.layout.test.tsx
```

Expected: fails against current tab shell.

**Step 3: Implement `ShellTopBar`**

Responsibilities:

- Title: `Aria Command Board`
- Metrics: `Need You`, `Active`, `Blocked`, `Agents`, `Crons`
- Refresh button with `aria-label`
- Last updated text
- Error text next to refresh

Use compact, restrained dark UI. No gradients.

**Step 4: Implement `CommandNav`**

Nav items:

- Issues
- Agents
- Ops
- Runs
- Settings

Use icon + text. Persist active workspace in `aria-dash-active-workspace`.

**Step 5: Refactor shell**

`CommandBoardShell` should:

- Fetch minimal shell summary and issues on boot.
- Render issue workspace by default.
- Lazy-load ops workspace only when selected.
- Do not fetch agents/capabilities until Agents or issue detail rail needs them.
- Use `h-dvh`.

**Step 6: Run layout tests**

```powershell
npm test -- src/components/dashboard/command-board/CommandBoardShell.layout.test.tsx src/components/dashboard/command-board/CommandBoardShell.test.tsx
```

Expected: pass after updating old tests to the new shell contract.

**Step 7: Checkpoint**

Run:

```powershell
npm run typecheck
```

Expected: pass.

**Step 8: Commit**

```powershell
git add src/components/dashboard/command-board/CommandBoardShell.tsx src/components/dashboard/command-board/CommandNav.tsx src/components/dashboard/command-board/ShellTopBar.tsx src/components/dashboard/command-board/CommandBoardShell.layout.test.tsx src/components/dashboard/command-board/CommandBoardShell.test.tsx
git commit -m "feat(dashboard): introduce command workspace shell"
```

---

## Task 3: Build Issue Command Center

**Purpose:** Replace the single-column issue list with a real issue command center: grouped queue, selected issue, and fast action surface.

**Files:**
- Create: `src/components/dashboard/command-board/IssueCommandCenter.tsx`
- Create: `src/components/dashboard/command-board/IssueQueue.tsx`
- Create: `src/components/dashboard/command-board/IssueCard.tsx`
- Create: `src/components/dashboard/command-board/IssueCommandCenter.test.tsx`
- Modify: `src/components/dashboard/command-board/IssuesPanel.tsx`

**Step 1: Write failing tests**

Mock `/api/command-board/issues` and assert:

- `Need You`, `Working`, `Waiting`, `Blocked`, `Recently Closed` groups render.
- Human approval issue is selected by default.
- Selecting a row calls `/api/command-board/issues/:id`.
- Approve/reject/resolve buttons still post to `/actions`.
- Empty state has one clear next action.

**Step 2: Run red**

```powershell
npm test -- src/components/dashboard/command-board/IssueCommandCenter.test.tsx
```

Expected: module missing.

**Step 3: Implement `IssueCard`**

Each issue card shows:

- title
- lifecycle
- control mode if present
- current handler
- blocker reason
- next action
- age
- linked task count
- source table/source id compactly

No emoji. Use lucide icons and text labels.

**Step 4: Implement `IssueQueue`**

Queue behavior:

- Dense list.
- Keyboard navigable buttons.
- Stable row height where possible.
- Selected row visible.
- Loading skeleton.
- Error row next to queue.

**Step 5: Implement `IssueCommandCenter`**

Layout:

```text
IssueCommandCenter
  left 320-420px: IssueQueue
  center minmax: IssueDetailWorkspace placeholder until Task 4
  right 280-340px: AgentControlRail placeholder until Task 5
```

Use responsive collapse:

- Desktop: three panes.
- Tablet: queue + detail, rail collapses below detail.
- Mobile: queue/detail toggle.

**Step 6: Wire `IssuesPanel` as compatibility wrapper**

`IssuesPanel` should render `IssueCommandCenter` so existing imports do not break.

**Step 7: Run focused tests**

```powershell
npm test -- src/components/dashboard/command-board/IssueCommandCenter.test.tsx
```

Expected: pass.

**Step 8: Checkpoint**

Run:

```powershell
npm test -- src/components/dashboard/command-board
npm run typecheck
```

Expected: pass.

**Step 9: Commit**

```powershell
git add src/components/dashboard/command-board/IssueCommandCenter.tsx src/components/dashboard/command-board/IssueQueue.tsx src/components/dashboard/command-board/IssueCard.tsx src/components/dashboard/command-board/IssueCommandCenter.test.tsx src/components/dashboard/command-board/IssuesPanel.tsx
git commit -m "feat(dashboard): build issue command center"
```

---

## Task 4: Build Issue Detail Workspace

**Purpose:** Make selected issue detail useful: timeline, linked tasks, source preview, actions, and next step.

**Files:**
- Create: `src/components/dashboard/command-board/IssueDetailWorkspace.tsx`
- Create: `src/components/dashboard/command-board/IssueTimeline.tsx`
- Create: `src/components/dashboard/command-board/LinkedTasksList.tsx`
- Create: `src/components/dashboard/command-board/IssueActionsBar.tsx`
- Create: `src/components/dashboard/command-board/IssueDetailWorkspace.test.tsx`
- Modify: `src/components/dashboard/command-board/IssueCommandCenter.tsx`

**Step 1: Write failing tests**

Assert:

- Detail fetch renders title, lifecycle, blocker, next action.
- Timeline merges issue and task events.
- Linked tasks render status/source/age.
- Approve/reject/resolve use existing API action shape.
- Pause/resume/run-next use new issue control action shape if available.
- Errors render inside detail pane.

**Step 2: Run red**

```powershell
npm test -- src/components/dashboard/command-board/IssueDetailWorkspace.test.tsx
```

Expected: module missing.

**Step 3: Implement `IssueActionsBar`**

Controls:

- Approve
- Reject
- Resolve
- Pause/Resume
- Run Next
- Assign
- Set Blocker

Rules:

- Destructive or irreversible actions need confirmation if they complete/reject.
- Buttons disabled while pending.
- Error appears next to the action bar.
- Icon-only buttons get `aria-label`.

**Step 4: Implement timeline**

Timeline rows:

- event type
- timestamp
- agent name if available
- status
- compact payload summary

Avoid dumping raw JSON by default. Add `details` disclosure for payload.

**Step 5: Wire into command center**

Selected issue id lives in `IssueCommandCenter`.

**Step 6: Run tests**

```powershell
npm test -- src/components/dashboard/command-board/IssueDetailWorkspace.test.tsx src/components/dashboard/command-board/IssueCommandCenter.test.tsx
```

Expected: pass.

**Step 7: Checkpoint**

Run:

```powershell
npm run typecheck
```

Expected: pass.

**Step 8: Commit**

```powershell
git add src/components/dashboard/command-board/IssueDetailWorkspace.tsx src/components/dashboard/command-board/IssueTimeline.tsx src/components/dashboard/command-board/LinkedTasksList.tsx src/components/dashboard/command-board/IssueActionsBar.tsx src/components/dashboard/command-board/IssueDetailWorkspace.test.tsx src/components/dashboard/command-board/IssueCommandCenter.tsx
git commit -m "feat(dashboard): add issue detail workspace"
```

---

## Task 5: Build Agent And Capability Control Rail

**Purpose:** Show the agentic system: current handler, agent health, skills, workflows, tools, playbooks, and what can be run for the selected issue.

**Files:**
- Create: `src/components/dashboard/command-board/AgentControlRail.tsx`
- Create: `src/components/dashboard/command-board/CapabilityList.tsx`
- Create: `src/components/dashboard/command-board/AgentMiniTree.tsx`
- Create: `src/components/dashboard/command-board/AgentControlRail.test.tsx`
- Modify: `src/components/dashboard/command-board/IssueCommandCenter.tsx`
- Modify: `src/app/api/command-board/agents/route.ts` only if current response lacks needed counts.
- Modify: `src/app/api/command-board/tools/route.ts` only if capability data is not exposed yet.

**Step 1: Write failing tests**

Assert:

- Rail fetches agents only when visible or an issue is selected.
- Shows selected issue current handler.
- Shows currently handling counts.
- Shows skills/workflows/references for the handler.
- Shows tools/capabilities grouped by read/write/playbook.
- Run buttons are disabled unless control mode allows them.

**Step 2: Run red**

```powershell
npm test -- src/components/dashboard/command-board/AgentControlRail.test.tsx
```

Expected: module missing.

**Step 3: Implement rail**

Sections:

- `Handler`: current handler, owner, control mode.
- `Agents`: compact tree or list with counts.
- `Capabilities`: skills, playbooks, tools.
- `Controls`: assign handler, control mode select.

Do not render full markdown files inline. Link/reference paths only.

**Step 4: Run tests**

```powershell
npm test -- src/components/dashboard/command-board/AgentControlRail.test.tsx
```

Expected: pass.

**Step 5: Checkpoint**

Run:

```powershell
npm run typecheck
```

Expected: pass.

**Step 6: Commit**

```powershell
git add src/components/dashboard/command-board/AgentControlRail.tsx src/components/dashboard/command-board/CapabilityList.tsx src/components/dashboard/command-board/AgentMiniTree.tsx src/components/dashboard/command-board/AgentControlRail.test.tsx src/components/dashboard/command-board/IssueCommandCenter.tsx src/app/api/command-board/agents/route.ts src/app/api/command-board/tools/route.ts
git commit -m "feat(dashboard): add agent capability control rail"
```

---

## Task 6: Renovate Ops Workspace Without Mounting Everything

**Purpose:** Keep AP, Receivings, Ordering, Tracking, Builds, Active POs, and Statement Recon central, but make them feel like workspaces rather than cramped tabs.

**Files:**
- Create: `src/components/dashboard/command-board/OpsWorkspace.tsx`
- Create: `src/components/dashboard/command-board/OpsWorkspace.test.tsx`
- Modify: `src/components/dashboard/command-board/panelRegistry.tsx`
- Modify: `src/components/dashboard/command-board/CommandBoardShell.tsx`
- Deprecate composition use only: `src/components/dashboard/command-board/OpsModuleDock.tsx`

**Step 1: Write failing tests**

Assert:

- Ops workspace renders module nav.
- Only active module is mounted by default.
- Optional keep-alive can preserve one recently visited module, not all modules.
- Required modules are present:
  - AP / Invoices
  - Receivings
  - Ordering / Purchasing
  - Active Purchases
  - Build Risk
  - Build Schedule
  - Tracking
  - Statement Recon

**Step 2: Run red**

```powershell
npm test -- src/components/dashboard/command-board/OpsWorkspace.test.tsx
```

Expected: module missing.

**Step 3: Implement workspace**

Layout:

- Left compact module nav.
- Main full-canvas panel.
- Header shows module title and refresh hint.

Performance:

- Mount active module only.
- Optional one-module keep-alive behind constant:

```ts
const OPS_KEEP_ALIVE_COUNT = 1;
```

**Step 4: Wire shell**

`CommandBoardShell` workspace `Ops` renders `OpsWorkspace`.

**Step 5: Run focused tests**

```powershell
npm test -- src/components/dashboard/command-board/OpsWorkspace.test.tsx src/components/dashboard/command-board/CommandBoardShell.layout.test.tsx
```

Expected: pass.

**Step 6: Checkpoint**

Run existing panel tests:

```powershell
npm test -- src/components/dashboard/InvoiceQueuePanel.test.tsx src/components/dashboard/ReceivedItemsPanel.test.tsx src/components/dashboard/TrackingBoardPanel.test.tsx src/components/dashboard/OversightPanel.test.tsx
```

Expected: pass. If a panel test fails due to the panel itself, fix that separately with a focused commit.

**Step 7: Commit**

```powershell
git add src/components/dashboard/command-board/OpsWorkspace.tsx src/components/dashboard/command-board/OpsWorkspace.test.tsx src/components/dashboard/command-board/panelRegistry.tsx src/components/dashboard/command-board/CommandBoardShell.tsx src/components/dashboard/command-board/OpsModuleDock.tsx
git commit -m "feat(dashboard): renovate ops workspace"
```

---

## Task 7: Visual System Polish

**Purpose:** Make the new UI look deliberate and coherent: dense, calm, operational, and befitting the agentic features.

**Files:**
- Create: `src/components/dashboard/command-board/ui.tsx`
- Create: `src/components/dashboard/command-board/ui.test.tsx`
- Modify: components created in Tasks 2-6.

**Step 1: Write UI primitive tests**

Assert:

- `IconButton` requires `aria-label`.
- `StatusPill` renders known tones.
- `SectionHeader` keeps title/action layout.
- `SkeletonRows` renders stable row count.

**Step 2: Run red**

```powershell
npm test -- src/components/dashboard/command-board/ui.test.tsx
```

Expected: module missing.

**Step 3: Add shared primitives**

`ui.tsx` exports:

- `IconButton`
- `StatusPill`
- `MetricChip`
- `SectionHeader`
- `SkeletonRows`
- `EmptyState`
- `ErrorInline`

Rules:

- No gradients.
- No negative letter spacing.
- Cards max `rounded-md`.
- `tabular-nums` for metrics.
- `line-clamp` or `truncate` for dense text.
- Small local transition only: `transition-colors`, `transition-opacity`, or `active:scale-[0.98]`.

**Step 4: Refactor new components to use primitives**

Apply primitives to:

- `ShellTopBar`
- `CommandNav`
- `IssueCard`
- `IssueActionsBar`
- `AgentControlRail`
- `OpsWorkspace`

**Step 5: UI review checklist**

Review components using this table:

| Before | After | Why |
| --- | --- | --- |
| Ad hoc pill classes in each component | `StatusPill` | Consistent status language |
| Every tab button owns its own style | Shared nav/button primitive | Reduces visual drift |
| Empty state is just gray text | `EmptyState` with one next action | Operational clarity |
| Long issue titles can push controls | `truncate`/`line-clamp` | Prevents overlap |

**Step 6: Run tests**

```powershell
npm test -- src/components/dashboard/command-board
npm run typecheck
```

Expected: pass.

**Step 7: Commit**

```powershell
git add src/components/dashboard/command-board
git commit -m "style(dashboard): polish command board visual system"
```

---

## Task 8: API And UI Integration Tests

**Purpose:** Verify the UI uses the intended backend contracts and does not regress to frontend mock state.

**Files:**
- Create: `src/components/dashboard/command-board/CommandBoard.integration.test.tsx`
- Modify tests only unless defects are found.

**Step 1: Write integration tests**

Test full flow with mocked fetch:

- Dashboard boots into Issues workspace.
- Issues list comes from `/api/command-board/issues`.
- Selecting issue fetches `/api/command-board/issues/:id`.
- Clicking pause posts `/api/command-board/issues/:id/actions`.
- Agent rail fetches `/api/command-board/agents` and `/api/command-board/tools` only after detail/rail is visible.
- Switching to Ops mounts one ops panel.
- Switching back to Issues preserves selected issue.

**Step 2: Run red/green**

```powershell
npm test -- src/components/dashboard/command-board/CommandBoard.integration.test.tsx
```

Expected: pass after wiring fixes.

**Step 3: Checkpoint**

Run all command-board component tests:

```powershell
npm test -- src/components/dashboard/command-board
```

Expected: pass.

**Step 4: Commit**

```powershell
git add src/components/dashboard/command-board/CommandBoard.integration.test.tsx src/components/dashboard/command-board
git commit -m "test(dashboard): cover command board integration flow"
```

---

## Task 9: Browser, Performance, And Accessibility Verification

**Purpose:** Confirm the renovated dashboard is usable in-browser and does not recreate the Chrome-killing behavior.

**Files:**
- Modify only to fix discovered defects.
- Optional: `tests/dashboard/dashboard-smoke.spec.ts`

**Step 1: Run typecheck and component tests**

```powershell
npm run typecheck
npm run typecheck:cli
npm test -- src/components/dashboard/command-board
```

Expected: pass.

**Step 2: Run route/API tests**

```powershell
npm test -- src/app/api/command-board src/lib/command-board src/lib/intelligence/issue-control-actions.test.ts
```

Expected: pass.

**Step 3: Run browser smoke on isolated dev server**

Only after tests pass:

```powershell
npx playwright test tests/dashboard/dashboard-smoke.spec.ts --project=chromium
```

Expected:

- `/dashboard` loads.
- First viewport shows command shell.
- Console has no errors.
- No runaway network loop.

**Step 4: Manual browser checklist**

Open `http://localhost:3001/dashboard` only after automated smoke passes.

Check:

- First viewport shows issue command center, not a panel wall.
- Need You issues are obvious.
- Selecting an issue shows timeline and linked tasks.
- Control buttons are visible and understandable.
- Agent/capability rail shows what Aria can do.
- Ops workspace modules are one click away.
- Switching modules does not freeze the browser.
- Text does not overlap at desktop and mobile widths.

**Step 5: Performance notes**

Record:

- Boot API calls.
- Components mounted at boot.
- Any console errors.
- Any slow panel.
- Whether the browser stays responsive after 5 minutes.

**Step 6: Final commit if fixes were needed**

```powershell
git add <fixed-files>
git commit -m "fix(dashboard): stabilize command board browser behavior"
```

---

## Definition Of Done

- `/dashboard` opens into an issue-first command center.
- The UI visibly represents the new agentic model: issues, handlers, control mode, blockers, next action, timeline, linked tasks, agents, skills, tools, and playbooks.
- Existing ops modules remain fully accessible in a full-canvas workspace.
- Boot does not mount all heavy panels.
- Dashboard tests prove issue selection, detail fetch, control action POSTs, agent/capability loading, and ops workspace switching.
- Browser smoke passes before any manual preview.
- Typecheck, CLI typecheck, command-board component tests, command-board API tests, and targeted panel tests pass.
- No frontend-only mock data ships in the finished dashboard.

## Execution Recommendation

Use subagents, but not all at once.

1. Run Task 0 alone.
2. Run Tasks 1-2 sequentially.
3. Run Tasks 3-5 with separate workers after shell is stable.
4. Run Task 6 separately because ops panels are heavy.
5. Run Tasks 7-9 only after functional behavior is green.

This should be a dedicated PR. Do not combine it with orchestrator backend work.
