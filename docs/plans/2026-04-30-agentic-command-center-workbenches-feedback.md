# Agentic Command Center, Workbenches, And Feedback Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an agentic dashboard where issues coordinate work, domain workbenches execute the work, and human fixes become feedback that improves future agent flow.

**Architecture:** Keep `agent_issue` as the control layer and `agent_task` as the step queue. Keep Ordering, Receivings, AP, Tracking, Builds, Active POs, and Statement Recon as first-class workbenches. Add issue triggers that can start bounded repair work, and add a feedback path so when Will fixes a blocker manually, Aria records the resolution and can adjust future routing/playbooks.

**Tech Stack:** Next.js App Router, React, Tailwind CSS, Supabase, Vitest, Testing Library, Playwright smoke checks, existing command-board APIs, existing dashboard panels, Tool Registry, Memory Manager, issue ledger, task hub, and Telegram.

---

## Core Principle

Issues coordinate. Workbenches execute.

Do not collapse Receivings, Ordering, AP, Tracking, Builds, Active POs, or Statement Recon into generic tickets. Those screens are the actual tools. Issues should point into them, summarize their blockers, and trigger agent work around them.

## Target Model

```text
Issue
  what happened
  current handler
  blocker
  next action
  linked business record
  linked workbench
  timeline
  triggerable repair/action
  human fix feedback

Workbench
  domain-specific records
  domain-specific actions
  related issues
  create/attach issue
  agent suggestions
```

Example flow:

```text
Invoice email arrives
  -> AP issue created
  -> AP workbench shows invoice
  -> agent extracts and matches PO
  -> if blocked, issue says why
  -> Will fixes missing PO/vendor mapping
  -> dashboard records "human_fix"
  -> Aria stores the fix pattern
  -> future invoices use adjusted flow
```

## Non-Negotiable Guardrails

- Dashboard must not become a heavy panel wall again.
- Workbenches remain first-class and directly accessible.
- Issues must deep-link to workbenches.
- Workbenches must show related issues.
- Triggered work must go through shared issue/task/tool services, not component-only logic.
- Human fixes must be recorded as structured events, not only comments.
- Agent behavior changes must be explicit and auditable. Do not silently mutate prompts or business rules.
- Ordering draft PO creation is not complete until vendor email send is fixed or explicitly blocked.
- Telegram remains a control surface for issue actions; dashboard becomes the richer visual control/workbench surface.
- Performance gates come before browser/manual preview.

---

## Task 0: Foundation And Dashboard Safety Check

**Purpose:** Confirm current issue/orchestrator foundation is healthy before UI/workbench renovation.

**Files:**
- Read: `src/lib/intelligence/agent-issue.ts`
- Read: `src/lib/intelligence/issue-orchestrator.ts`
- Read: `src/lib/intelligence/issue-control-actions.ts`
- Read: `src/lib/command-board/service.ts`
- Read: `src/components/dashboard/command-board/CommandBoardShell.tsx`

**Steps:**

1. Run:

```powershell
git status --short --branch
npm test -- src/lib/intelligence/agent-issue.test.ts src/lib/intelligence/issue-control-actions.test.ts src/lib/intelligence/issue-orchestrator.test.ts src/lib/command-board/service.test.ts
npm run typecheck
```

2. Run non-browser smoke:

```powershell
node --import tsx src/cli/smoke-merged-state.ts
```

3. Check:

- Issue list/detail works without dashboard.
- Tool Registry is populated.
- Issue control actions work.
- Orchestrator is still env-gated if not production-ready.

4. Commit only fixes needed to restore foundation.

---

## Task 1: Define Workbench Registry

**Purpose:** Create a single source of truth that maps business records and issues to their proper workbench.

**Files:**
- Create: `src/lib/command-board/workbenches.ts`
- Create: `src/lib/command-board/workbenches.test.ts`
- Modify: `src/lib/command-board/types.ts`

**Workbench ids:**

```ts
export type WorkbenchId =
  | "issues"
  | "ordering"
  | "receivings"
  | "ap"
  | "tracking"
  | "active-pos"
  | "builds"
  | "statement-recon"
  | "agents"
  | "runs";
```

**Required tests:**

- `ap_pending_approvals` maps to `ap`.
- PO/order records map to `ordering`.
- receiving records map to `receivings`.
- tracking records map to `tracking`.
- build-risk records map to `builds`.
- unknown records map to `issues`.

**Check:**

```powershell
npm test -- src/lib/command-board/workbenches.test.ts
```

Expected: pass.

---

## Task 2: Add Issue-to-Workbench Links To API

**Purpose:** Every issue detail should tell the UI where the real work happens.

**Files:**
- Modify: `src/lib/command-board/service.ts`
- Modify: `src/lib/command-board/types.ts`
- Modify: `src/app/api/command-board/issues/[id]/route.ts`
- Test: `src/app/api/command-board/issues/route.test.ts`

**Add to `CommandBoardIssueDetail`:**

```ts
workbench: {
  id: WorkbenchId;
  label: string;
  href: string;
  sourceTable: string | null;
  sourceId: string | null;
};
```

**Required tests:**

- AP issue detail includes `workbench.id = "ap"`.
- Ordering issue detail includes `workbench.id = "ordering"`.
- Unknown issue detail falls back to `issues`.

**Check:**

```powershell
npm test -- src/app/api/command-board/issues/route.test.ts src/lib/command-board/service.test.ts
```

Expected: pass.

---

## Task 3: Add Related Issues Query For Workbenches

**Purpose:** Each workbench can show issues relevant to its domain without loading the entire command center.

**Files:**
- Create: `src/app/api/command-board/workbenches/[id]/issues/route.ts`
- Create: `src/app/api/command-board/workbenches/[id]/issues/route.test.ts`
- Modify: `src/lib/command-board/service.ts`

**Route:**

```text
GET /api/command-board/workbenches/:id/issues?limit=25&bust=1
```

**Behavior:**

- `ap`: AP source tables and AP handlers.
- `ordering`: PO/order/purchasing source tables.
- `receivings`: receiving source tables.
- `tracking`: tracking source tables.
- `builds`: build risk/schedule source tables.
- Always returns `Cache-Control: no-store`.

**Check:**

```powershell
npm test -- src/app/api/command-board/workbenches
```

Expected: pass.

---

## Task 4: Add Issue Trigger Service

**Purpose:** Once an issue is identified, the UI/Telegram can trigger Aria to work on fixing it until blocked or complete.

**Files:**
- Create: `src/lib/intelligence/issue-triggers.ts`
- Create: `src/lib/intelligence/issue-triggers.test.ts`
- Modify: `src/lib/intelligence/issue-control-actions.ts`

**Trigger types:**

```ts
export type IssueTriggerKind =
  | "investigate"
  | "run_next_step"
  | "retry_failed_step"
  | "open_workbench"
  | "create_repair_task"
  | "run_playbook";
```

**Behavior:**

- `investigate`: creates a read-only task or orchestrator step.
- `run_next_step`: delegates to issue orchestrator.
- `retry_failed_step`: creates a retry task if retry budget allows.
- `create_repair_task`: creates an `agent_task` linked to the issue.
- `run_playbook`: only if control mode allows it.
- If blocked, return `{ ok: false, reason: "blocked", nextAction }` unless trigger is human-approved.

**Required tests:**

- Trigger creates linked task with `issue_id`.
- Trigger refuses side-effect work in `observe_only`.
- Trigger allows read-only investigation in `autonomous`.
- Trigger records `issue_triggered` event.
- Trigger failure records event and does not crash caller.

**Check:**

```powershell
npm test -- src/lib/intelligence/issue-triggers.test.ts src/lib/intelligence/issue-control-actions.test.ts
```

Expected: pass.

---

## Task 5: Add Human Fix Feedback Service

**Purpose:** When Will fixes a blocker manually, Aria remembers what happened and can adjust future agent flow.

**Files:**
- Create: `src/lib/intelligence/human-fix-feedback.ts`
- Create: `src/lib/intelligence/human-fix-feedback.test.ts`
- Modify: `src/lib/memory/index.ts` only if existing memory facade needs a typed helper.
- Modify: `src/lib/intelligence/agent-issue.ts` only if a public issue-event helper is needed.

**Feedback shape:**

```ts
export type HumanFixFeedback = {
  issueId: string;
  blockerReason: string | null;
  workbenchId: string;
  fixKind:
    | "mapped_vendor"
    | "selected_po"
    | "corrected_sku"
    | "marked_received"
    | "sent_vendor_email"
    | "changed_policy"
    | "other";
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  actor: "will-dashboard" | "will-telegram" | string;
};
```

**Behavior:**

- Append `human_fix_recorded` event to `task_history` with `issue_id`.
- Store a memory entry through Memory Manager with namespace like `human_fixes`.
- Optionally clear blocker if caller requests it.
- Never directly rewrite agent prompts or hidden rules.

**Required tests:**

- Records issue event.
- Writes memory facade entry.
- Preserves structured before/after payload.
- Can clear blocker only when explicitly requested.

**Check:**

```powershell
npm test -- src/lib/intelligence/human-fix-feedback.test.ts src/lib/memory/index.test.ts
```

Expected: pass.

---

## Task 6: Fix Ordering Draft PO Send Email Flow

**Purpose:** Ordering is a real workbench. Draft PO creation is incomplete until vendor send works or clearly blocks.

**Files:**
- Inspect first:
  - `src/components/dashboard/PurchasingPanel.tsx`
  - `src/lib/purchasing/**`
  - `src/app/api/**/purchasing/**`
  - any existing email/Gmail/PO send helpers
- Create/modify only after tracing current flow.

**Expected behavior:**

```text
Create draft PO
  -> Review draft
  -> Send email to vendor
  -> Record sent status/message id
  -> Create/update issue timeline
  -> Move issue to waiting_external
```

**Tests to add:**

- Draft PO send endpoint calls the registered Gmail/email tool or existing send helper.
- Send success records sent metadata.
- Send failure sets/updates issue blocker.
- UI does not show “sent” unless send returns success.

**Check:**

```powershell
rg "draft PO|send.*vendor|vendor email|PurchasingPanel|po_confirm_send" src -n
npm test -- <new-ordering-send-tests>
```

Expected: draft creation and send-email are separate, auditable states.

---

## Task 7: Renovate Dashboard Navigation Around Workbenches

**Purpose:** Make workbenches first-class in the UI while keeping issues as the command layer.

**Files:**
- Modify: `src/components/dashboard/command-board/CommandBoardShell.tsx`
- Modify: `src/components/dashboard/command-board/CommandNav.tsx`
- Create/modify: `src/components/dashboard/command-board/OpsWorkspace.tsx`
- Modify: `src/components/dashboard/command-board/panelRegistry.tsx`

**Navigation target:**

```text
Command
  Issues
  Agents
  Runs

Workbenches
  Ordering
  Receivings
  AP / Invoices
  Tracking
  Active POs
  Builds
  Statement Recon
```

**Rules:**

- Default view: Issues.
- Daily workbenches are visible in left nav, not buried.
- Only active workbench mounts.
- Related issue strip appears in each workbench shell.

**Check:**

```powershell
npm test -- src/components/dashboard/command-board/CommandBoardShell.layout.test.tsx src/components/dashboard/command-board/OpsWorkspace.test.tsx
```

Expected: pass.

---

## Task 8: Add Related Issue Strip To Workbenches

**Purpose:** Each workbench shows its open issues and lets Will create/attach an issue from the current domain.

**Files:**
- Create: `src/components/dashboard/command-board/RelatedIssuesStrip.tsx`
- Create: `src/components/dashboard/command-board/RelatedIssuesStrip.test.tsx`
- Modify: `src/components/dashboard/command-board/OpsWorkspace.tsx`

**UI:**

- Compact strip above active workbench.
- Shows top related issues.
- Buttons:
  - Open issue
  - Trigger work
  - Record human fix
  - Create issue

**Check:**

```powershell
npm test -- src/components/dashboard/command-board/RelatedIssuesStrip.test.tsx
```

Expected: pass.

---

## Task 9: Add Issue Detail Workbench And Trigger Controls

**Purpose:** Issue detail must be able to open the right tool and trigger agent work.

**Files:**
- Modify: `src/components/dashboard/command-board/IssueDetailWorkspace.tsx`
- Modify: `src/components/dashboard/command-board/IssueActionsBar.tsx`
- Test: `src/components/dashboard/command-board/IssueDetailWorkspace.test.tsx`

**Add controls:**

- Open in Workbench
- Trigger Investigation
- Run Next Step
- Retry Failed Step
- Record Human Fix

**Rules:**

- Side-effect triggers must respect control mode.
- Blocked issues show blocker reason and expected human fix.
- Human fix opens a small form, not raw JSON.

**Check:**

```powershell
npm test -- src/components/dashboard/command-board/IssueDetailWorkspace.test.tsx
```

Expected: pass.

---

## Task 10: Add Human Fix Form

**Purpose:** Make it easy to record how a blocker was resolved so agents can learn from the operational reality.

**Files:**
- Create: `src/components/dashboard/command-board/HumanFixForm.tsx`
- Create: `src/components/dashboard/command-board/HumanFixForm.test.tsx`
- Create: `src/app/api/command-board/issues/[id]/human-fix/route.ts`
- Test: `src/app/api/command-board/issues/[id]/human-fix/route.test.ts`

**Form fields:**

- Fix kind
- Summary
- Before value
- After value
- Clear blocker checkbox
- Optional note

**Route:**

```text
POST /api/command-board/issues/:id/human-fix
```

Calls `recordHumanFixFeedback()`.

**Check:**

```powershell
npm test -- src/components/dashboard/command-board/HumanFixForm.test.tsx src/app/api/command-board/issues/[id]/human-fix/route.test.ts
```

Expected: pass.

---

## Task 11: Feed Human Fixes Into Agent Flow Safely

**Purpose:** Let Aria use recorded fixes without silently changing business rules.

**Files:**
- Create: `src/lib/intelligence/human-fix-suggestions.ts`
- Create: `src/lib/intelligence/human-fix-suggestions.test.ts`
- Modify targeted agent flows only after tests:
  - AP vendor/PO matching path
  - Ordering vendor email path
  - Receivings variance path

**Behavior:**

- Agents may query recent relevant human fixes.
- Suggestions are included as context, not mandatory rules.
- If confidence is high, agent may propose an adjusted action.
- If side-effectful, still respect control mode.
- Every use records `human_fix_suggestion_used` or `human_fix_suggestion_ignored`.

**Check:**

```powershell
npm test -- src/lib/intelligence/human-fix-suggestions.test.ts
```

Expected: pass.

---

## Task 12: Browser And End-To-End Verification

**Purpose:** Verify command center, workbenches, triggers, and human feedback without overloading the browser.

**Commands:**

```powershell
npm run typecheck
npm run typecheck:cli
npm test -- src/lib/intelligence/issue-triggers.test.ts src/lib/intelligence/human-fix-feedback.test.ts src/lib/intelligence/human-fix-suggestions.test.ts
npm test -- src/lib/command-board src/app/api/command-board
npm test -- src/components/dashboard/command-board
```

**Browser smoke:**

Only after tests pass:

```powershell
npx playwright test tests/dashboard/dashboard-smoke.spec.ts --project=chromium
```

**Manual checks:**

- `/dashboard` opens into Issues.
- Ordering, Receivings, AP, Tracking, Builds are visible in nav.
- Only active workbench mounts.
- Workbench shows related issues.
- Issue detail opens the correct workbench.
- Trigger work creates a linked task or clear blocked response.
- Human fix records timeline event and memory entry.
- Ordering draft PO send email works or creates a clear blocker.
- Browser remains responsive after switching through workbenches.

---

## Definition Of Done

- Issues coordinate work but do not replace workbenches.
- Ordering, Receivings, AP, Tracking, Active POs, Builds, and Statement Recon are first-class dashboard screens.
- Every issue can deep-link to the correct workbench.
- Every workbench can show related issues.
- Identified issues can trigger bounded agent work until complete or blocked.
- Human fixes are recorded as structured feedback.
- Agents can consult human-fix memory as context, with audited usage.
- Ordering draft PO send email is fixed or explicitly blocked with an issue.
- Dashboard remains performant and does not mount every heavy panel at boot.
- Telegram and dashboard issue controls share backend services.

## Execution Recommendation

Do this in two PRs.

**PR 1: Backend/control foundation**

- Tasks 0-6
- Workbench mapping
- Issue links
- Related issues API
- Trigger service
- Human fix feedback
- Ordering send-email fix

**PR 2: Dashboard renovation**

- Tasks 7-12
- Workbench nav
- Related issue strips
- Issue trigger controls
- Human fix form
- Browser/performance verification

Do not combine this with unrelated orchestrator backend work unless the orchestrator branch already owns the same files and is ready for integration.
