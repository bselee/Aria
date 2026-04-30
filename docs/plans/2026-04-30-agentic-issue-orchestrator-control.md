# Agentic Issue Orchestrator Control Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Aria agentic by turning `agent_issue` into the controlled parent unit, giving each issue a clear next action, autonomy/control mode, handler, executable capabilities, and human override paths from Telegram and a lightweight dashboard control panel.

**Architecture:** Keep `agent_issue` as the source of truth for business problems, `agent_task` as the step/work queue, `task_history` as the append-only event ledger, `tool-registry` as the audited action gate, and playbooks/skills as executable capability definitions. Add a small issue orchestrator that evaluates issues, chooses the next safe step, and only executes within an explicit control mode. Do not put Codex in the production loop; Codex remains the engineering/review assistant, while Aria runtime controls production issues.

**Tech Stack:** Next.js App Router, React, Tailwind CSS, Supabase, Vitest, Testing Library, existing `agent_issue`, `agent_task`, `task_history`, Tool Registry, Memory Manager, Telegram bot, and command-board APIs.

---

## Non-Negotiable Guardrails

- Do not expand the heavy dashboard command board. The browser has already been unstable. Dashboard work in this plan is limited to lightweight issue-control APIs and the existing `IssuesPanel`.
- Telegram remains the daily driver. Any dashboard control must have a Telegram-equivalent or share the same service function.
- Codex must not control production flows. Codex writes/reviews code and plans; Aria runtime executes bounded issue orchestration.
- Do not overload `autonomy_state` as permission. Existing `autonomy_state` describes current operational posture. New control permissions live in a typed `inputs.control` object first; promote to schema only after the shape proves stable.
- `blocked` remains explicit only. Projection must never set blocked. Only `setBlocker()` or an issue-control service may set or clear true blockers.
- All issue actions are audited in `task_history` with `issue_id`.
- All tool execution goes through `withToolAudit()` where an issue or task context exists.
- Hub writes stay best-effort for spoke agents; orchestration failures must degrade into events/blockers, not crash AP or Telegram flows.
- No new board-level realtime subscriptions. Poll or manual refresh only.
- Every task below ends with an explicit check step and a commit.

## Subagent Ownership

Use one subagent per task or per closely related task group. Do not let two subagents edit the same files.

- Verification worker: Task 0 only.
- Issue model worker: Tasks 1 and 2.
- Capability worker: Task 3.
- Orchestrator worker: Task 4.
- Control API worker: Task 5.
- Telegram worker: Task 6.
- Dashboard worker: Task 7 only, scoped to `IssuesPanel`.
- Integration reviewer: Task 8.

Recommended flow: run tasks sequentially until Task 4 is green. Tasks 5 and 6 may run in parallel if they both depend only on the Task 4 service surface. Task 7 runs after Task 5.

---

## Control Codes

Use these exact codes in tests, API responses, and UI labels.

```ts
export type IssueControlMode =
  | "observe_only"       // Aria may read, summarize, and propose only.
  | "suggest"            // Aria may propose the next action, but not enqueue work.
  | "act_with_approval"  // Aria may prepare work; Will must approve side effects.
  | "autonomous";        // Aria may enqueue safe registered steps within budget.

export type IssueControlIntent =
  | "set_control_mode"
  | "assign_handler"
  | "run_next_step"
  | "pause"
  | "resume"
  | "set_blocker"
  | "clear_blocker"
  | "complete";

export type IssueNextActionKind =
  | "none"
  | "ask_will"
  | "wait_external"
  | "run_playbook"
  | "create_task"
  | "call_tool"
  | "handoff";
```

Store control metadata in `agent_issue.inputs.control` for v1:

```ts
export type IssueControlProfile = {
  mode: IssueControlMode;
  paused?: boolean;
  assignedBy?: string;
  updatedAt: string;
  reason?: string;
};
```

Default control mode:

- `human_approval_required` or `policy_required` blocker: `act_with_approval`
- `owner = "will"`: `suggest`
- AP/finale write path: `act_with_approval`
- read-only investigation: `autonomous`
- unknown source: `observe_only`

---

## Task 0: Verify The 4/29 Foundation Is Actually Complete

**Purpose:** Before adding orchestration, prove the merged issue ledger, AP issue wiring, Tool Registry, Memory Manager, budget, and Telegram issue surface are reachable.

**Files:**
- Read only: `docs/plans/2026-04-29-aria-state-and-path-forward.md`
- Read only: `docs/plans/2026-04-29-merge-summary.md`
- Read only: `src/cli/smoke-merged-state.ts`
- Read only: `src/lib/intelligence/agent-issue.ts`
- Read only: `src/lib/intelligence/ap-issue.ts`
- Read only: `src/lib/agents/tool-registry.ts`
- Read only: `src/lib/memory/index.ts`
- Read only: `src/lib/agents/budget.ts`

**Step 1: Confirm clean-enough worktree**

Run:

```powershell
git status --short --branch
```

Expected:

- Branch is `main` or a dedicated worktree branch.
- Any unrelated local changes are identified and ignored.
- Do not touch `.gitignore`, `.github/`, or `tools/excel-mcp-server` unless this task explicitly owns them.

**Step 2: Run foundation tests**

Run:

```powershell
npm test -- src/lib/intelligence/agent-issue.test.ts src/lib/intelligence/issue-projection.test.ts src/lib/intelligence/ap-issue.test.ts src/lib/command-board/task-actions.test.ts src/lib/agents/tool-registry.test.ts src/lib/memory/index.test.ts src/lib/agents/budget.test.ts
```

Expected: all selected tests pass.

**Step 3: Run typechecks**

Run:

```powershell
npm run typecheck
npm run typecheck:cli
```

Expected: both pass, or any pre-existing failure is captured with file path and reason before proceeding.

**Step 4: Run non-dashboard smoke**

Run:

```powershell
node --import tsx src/cli/smoke-merged-state.ts
```

Expected:

- Issue ledger returns open/recent issues or an explicit empty state.
- Tool Registry returns registered tools.
- Budget table is reachable or cleanly skipped if Supabase is unavailable.
- Command-board issue service returns list/detail without opening `/dashboard`.

**Step 5: Checkpoint**

If any foundation check fails, stop and fix that first. Do not implement orchestrator code on a failing foundation.

Commit only if this task required a doc/test correction:

```powershell
git add <changed-files>
git commit -m "test: verify agentic foundation before orchestration"
```

---

## Task 1: Add Issue Control Profile Helpers

**Purpose:** Add typed helpers for reading and writing issue control metadata without a schema migration.

**Files:**
- Create: `src/lib/intelligence/issue-control.ts`
- Create: `src/lib/intelligence/issue-control.test.ts`
- Modify only if needed: `src/lib/intelligence/agent-issue.ts`

**Step 1: Write failing tests**

Create `src/lib/intelligence/issue-control.test.ts` covering:

```ts
import {
  getIssueControlProfile,
  patchIssueControlProfile,
  defaultIssueControlMode,
} from "./issue-control";

it("defaults human approval issues to act_with_approval", () => {
  expect(defaultIssueControlMode({
    lifecycle_state: "blocked",
    blocker_reason: "human_approval_required",
    owner: "will",
    source_table: "ap_pending_approvals",
  } as any)).toBe("act_with_approval");
});

it("reads existing inputs.control without losing unrelated inputs", () => {
  const issue = {
    inputs: {
      vendor_name: "Axiom",
      control: { mode: "suggest", updatedAt: "2026-04-30T00:00:00.000Z" },
    },
  } as any;
  expect(getIssueControlProfile(issue).mode).toBe("suggest");
});

it("patches control profile while preserving existing inputs", async () => {
  // Mock Supabase update and assert patch.inputs keeps vendor_name plus control.
});
```

**Step 2: Run test to verify red**

Run:

```powershell
npm test -- src/lib/intelligence/issue-control.test.ts
```

Expected: fails because module does not exist.

**Step 3: Implement minimal helper**

Create `src/lib/intelligence/issue-control.ts`:

```ts
import { createClient } from "@/lib/supabase";
import type { AgentIssue, IssueBlockerReason } from "./agent-issue";

export type IssueControlMode =
  | "observe_only"
  | "suggest"
  | "act_with_approval"
  | "autonomous";

export type IssueControlProfile = {
  mode: IssueControlMode;
  paused?: boolean;
  assignedBy?: string;
  updatedAt: string;
  reason?: string;
};

const VALID = new Set<IssueControlMode>([
  "observe_only",
  "suggest",
  "act_with_approval",
  "autonomous",
]);

export function defaultIssueControlMode(issue: Pick<AgentIssue,
  "owner" | "source_table" | "blocker_reason" | "lifecycle_state"
>): IssueControlMode {
  if (issue.blocker_reason === "human_approval_required" || issue.blocker_reason === "policy_required") {
    return "act_with_approval";
  }
  if ((issue.owner ?? "").toLowerCase() === "will") return "suggest";
  if (issue.source_table?.startsWith("ap_")) return "act_with_approval";
  if (issue.lifecycle_state === "blocked") return "suggest";
  return "observe_only";
}

export function getIssueControlProfile(issue: AgentIssue): IssueControlProfile {
  const raw = (issue.inputs as any)?.control;
  const mode = typeof raw?.mode === "string" && VALID.has(raw.mode)
    ? raw.mode as IssueControlMode
    : defaultIssueControlMode(issue);
  return {
    mode,
    paused: raw?.paused === true,
    assignedBy: typeof raw?.assignedBy === "string" ? raw.assignedBy : undefined,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : issue.updated_at,
    reason: typeof raw?.reason === "string" ? raw.reason : undefined,
  };
}

export async function patchIssueControlProfile(
  issue: AgentIssue,
  patch: Partial<Omit<IssueControlProfile, "updatedAt">>,
): Promise<AgentIssue | null> {
  const supabase = createClient();
  if (!supabase) return null;
  const current = getIssueControlProfile(issue);
  const control: IssueControlProfile = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const inputs = { ...(issue.inputs ?? {}), control };
  const { data, error } = await supabase
    .from("agent_issue")
    .update({ inputs, updated_at: control.updatedAt })
    .eq("id", issue.id)
    .select()
    .single();
  if (error) {
    console.warn("[issue-control] patch failed:", error.message);
    return null;
  }
  return data as AgentIssue;
}
```

**Step 4: Run focused test**

Run:

```powershell
npm test -- src/lib/intelligence/issue-control.test.ts
```

Expected: pass.

**Step 5: Checkpoint**

Run:

```powershell
npm test -- src/lib/intelligence/agent-issue.test.ts src/lib/intelligence/issue-control.test.ts
```

Expected: pass. Confirm no migration was added.

**Step 6: Commit**

```powershell
git add src/lib/intelligence/issue-control.ts src/lib/intelligence/issue-control.test.ts
git commit -m "feat(issues): add control profile helpers"
```

---

## Task 2: Add Issue State Machine Rules

**Purpose:** Centralize legal issue transitions so the orchestrator, Telegram, and dashboard do not each invent lifecycle behavior.

**Files:**
- Create: `src/lib/intelligence/issue-state-machine.ts`
- Create: `src/lib/intelligence/issue-state-machine.test.ts`
- Modify: `src/lib/intelligence/agent-issue.ts` only if a shared type export is needed.

**Step 1: Write failing tests**

Test cases:

- Projection-style update cannot move `blocked` to `working`.
- `clear_blocker` can move `blocked` to `working`.
- `complete` can close non-blocked issue.
- `set_blocker` is always legal from open states.
- `complete` from `blocked` requires `clear_blocker` first unless `force: true` is provided by a human actor.

Suggested test:

```ts
import { canTransitionIssue } from "./issue-state-machine";

it("prevents projection from clearing blocked", () => {
  expect(canTransitionIssue({
    from: "blocked",
    to: "working",
    intent: "projection",
    actor: "issue-projection",
  }).ok).toBe(false);
});

it("allows clear_blocker to resume blocked issue", () => {
  expect(canTransitionIssue({
    from: "blocked",
    to: "working",
    intent: "clear_blocker",
    actor: "will-telegram",
  }).ok).toBe(true);
});
```

**Step 2: Run red**

```powershell
npm test -- src/lib/intelligence/issue-state-machine.test.ts
```

Expected: module missing.

**Step 3: Implement rules**

Create `src/lib/intelligence/issue-state-machine.ts`:

```ts
import type { IssueLifecycleState } from "./agent-issue";

export type IssueTransitionIntent =
  | "projection"
  | "set_blocker"
  | "clear_blocker"
  | "handoff"
  | "complete"
  | "manual_control"
  | "orchestrator";

export type IssueTransitionCheck = {
  from: IssueLifecycleState;
  to: IssueLifecycleState;
  intent: IssueTransitionIntent;
  actor: string;
  force?: boolean;
};

export function canTransitionIssue(input: IssueTransitionCheck): { ok: true } | { ok: false; reason: string } {
  if (input.from === input.to) return { ok: true };
  if (input.from === "complete" && !input.force) {
    return { ok: false, reason: "complete issues cannot be reopened without force" };
  }
  if (input.from === "blocked" && input.to !== "blocked") {
    if (input.intent === "clear_blocker") return { ok: true };
    if (input.intent === "complete" && input.force && input.actor.startsWith("will-")) return { ok: true };
    return { ok: false, reason: "blocked issues require clear_blocker before lifecycle advance" };
  }
  if (input.to === "blocked") {
    return input.intent === "set_blocker"
      ? { ok: true }
      : { ok: false, reason: "blocked requires set_blocker intent" };
  }
  return { ok: true };
}
```

**Step 4: Run focused test**

```powershell
npm test -- src/lib/intelligence/issue-state-machine.test.ts
```

Expected: pass.

**Step 5: Checkpoint**

Search for direct lifecycle updates:

```powershell
rg "lifecycle_state" src/lib src/app/api src/cli -n
```

Expected: all direct lifecycle writes are either existing known paths or planned for Task 5 service consolidation. Record any suspicious direct update in the PR notes.

**Step 6: Commit**

```powershell
git add src/lib/intelligence/issue-state-machine.ts src/lib/intelligence/issue-state-machine.test.ts
git commit -m "feat(issues): add lifecycle transition guard"
```

---

## Task 3: Register Issue Capabilities From Skills, Playbooks, And Tools

**Purpose:** Make skills/playbooks/tools visible as issue capabilities so the orchestrator can decide what Aria can actually do.

**Files:**
- Create: `src/lib/agents/issue-capabilities.ts`
- Create: `src/lib/agents/issue-capabilities.test.ts`
- Modify: `src/lib/intelligence/playbooks/registry.ts` only if an exported `listPlaybooks()` helper is needed.
- Modify: `src/app/api/command-board/tools/route.ts` only if the existing tool API should expose capability names.

**Step 1: Write failing tests**

Test:

- Capability list includes registered playbooks from `PLAYBOOK_BY_KIND`.
- Capability list includes registered tools from `listTools()`.
- Capability list includes `.agents/skills/*/SKILL.md` catalog references through `loadCommandBoardCatalog()`.
- Capability filter by handler excludes write tools outside agent scope.

Example:

```ts
import { listIssueCapabilities } from "./issue-capabilities";

it("lists skills, playbooks, and tools as capabilities", async () => {
  const caps = await listIssueCapabilities({ handler: "ap-reconciler" });
  expect(caps.some(c => c.kind === "playbook")).toBe(true);
  expect(caps.some(c => c.kind === "tool")).toBe(true);
  expect(caps.some(c => c.kind === "skill")).toBe(true);
});
```

**Step 2: Run red**

```powershell
npm test -- src/lib/agents/issue-capabilities.test.ts
```

Expected: module missing.

**Step 3: Implement capability catalog**

Create:

```ts
import { listTools } from "./tool-registry";
import { loadCommandBoardCatalog } from "@/lib/command-board/catalog";
import { PLAYBOOK_BY_KIND } from "@/lib/intelligence/playbooks/registry";

export type IssueCapabilityKind = "skill" | "playbook" | "tool";

export type IssueCapability = {
  id: string;
  kind: IssueCapabilityKind;
  label: string;
  description: string;
  safeByDefault: boolean;
  requiresApproval: boolean;
  handlerScope: string[];
};

export async function listIssueCapabilities(opts: { handler?: string } = {}): Promise<IssueCapability[]> {
  const catalog = await loadCommandBoardCatalog();
  const tools = listTools(opts.handler ? { agentScope: opts.handler } : {});
  const out: IssueCapability[] = [];

  for (const skill of catalog.skills) {
    out.push({
      id: `skill:${skill.id}`,
      kind: "skill",
      label: skill.name,
      description: skill.description,
      safeByDefault: true,
      requiresApproval: false,
      handlerScope: [],
    });
  }

  for (const [kind, playbook] of PLAYBOOK_BY_KIND) {
    out.push({
      id: `playbook:${kind}`,
      kind: "playbook",
      label: kind,
      description: playbook.description,
      safeByDefault: false,
      requiresApproval: true,
      handlerScope: [],
    });
  }

  for (const tool of tools) {
    out.push({
      id: `tool:${tool.name}`,
      kind: "tool",
      label: tool.name,
      description: tool.description,
      safeByDefault: tool.scope === "read",
      requiresApproval: tool.scope !== "read",
      handlerScope: [...tool.agentScope],
    });
  }

  return out.sort((a, b) => `${a.kind}:${a.label}`.localeCompare(`${b.kind}:${b.label}`));
}
```

**Step 4: Run focused test**

```powershell
npm test -- src/lib/agents/issue-capabilities.test.ts src/lib/agents/tool-registry.test.ts src/lib/command-board/catalog.test.ts
```

Expected: pass.

**Step 5: Checkpoint**

Run:

```powershell
node --import tsx -e "import('./src/lib/agents/issue-capabilities.ts').then(async m => console.log((await m.listIssueCapabilities()).slice(0,5)))"
```

Expected: prints capability objects without hitting dashboard.

**Step 6: Commit**

```powershell
git add src/lib/agents/issue-capabilities.ts src/lib/agents/issue-capabilities.test.ts src/lib/intelligence/playbooks/registry.ts src/app/api/command-board/tools/route.ts
git commit -m "feat(agents): expose issue capabilities"
```

---

## Task 4: Add Issue Orchestrator Service

**Purpose:** Add the small production controller that evaluates open issues and chooses/executes the next bounded step.

**Files:**
- Create: `src/lib/intelligence/issue-orchestrator.ts`
- Create: `src/lib/intelligence/issue-orchestrator.test.ts`
- Modify: `src/lib/intelligence/agent-issue.ts` only if a public `appendIssueEvent` wrapper is needed.
- Modify: `src/lib/scheduler/cron-registry.ts`
- Modify: `src/lib/intelligence/ops-manager.ts`

**Step 1: Write failing tests**

Required tests:

- `observe_only` only writes a proposed next action event.
- `suggest` updates `next_action` but does not create a task.
- `act_with_approval` creates or updates a `NEEDS_APPROVAL` task for side-effect steps.
- `autonomous` can enqueue safe read-only/playbook steps within budget.
- Paused issues are skipped.
- Blocked issues are skipped unless the next action is `ask_will`.
- Tool/playbook failures become issue events and do not crash the cycle.

Example:

```ts
import { evaluateIssue, runIssueOrchestratorOnce } from "./issue-orchestrator";

it("does not enqueue work in observe_only mode", async () => {
  const result = await evaluateIssue(mockIssue({ control: { mode: "observe_only" } }));
  expect(result.action.kind).toBe("ask_will");
  expect(result.enqueuedTaskId).toBeNull();
});

it("skips paused issues", async () => {
  const result = await evaluateIssue(mockIssue({ control: { mode: "autonomous", paused: true } }));
  expect(result.skipped).toBe(true);
});
```

**Step 2: Run red**

```powershell
npm test -- src/lib/intelligence/issue-orchestrator.test.ts
```

Expected: module missing.

**Step 3: Implement evaluator first**

Create these types in `issue-orchestrator.ts`:

```ts
import type { AgentIssue } from "./agent-issue";

export type IssueNextAction =
  | { kind: "none"; reason: string }
  | { kind: "ask_will"; reason: string }
  | { kind: "wait_external"; reason: string }
  | { kind: "run_playbook"; playbookKind: string; reason: string }
  | { kind: "create_task"; taskType: string; goal: string; requiresApproval: boolean }
  | { kind: "handoff"; handler: string; reason: string };

export type IssueEvaluation = {
  issueId: string;
  action: IssueNextAction;
  skipped: boolean;
  enqueuedTaskId: string | null;
};
```

Initial decision rules:

- `complete`: `none`
- paused: skip
- `blocked` with `human_approval_required`: `ask_will`
- `waiting_external`: `wait_external`
- AP issue with no linked open task and not complete: `create_task` with `requiresApproval = true`
- issue with `playbook_kind` in inputs: `run_playbook`
- unknown: `ask_will`

Keep this deliberately boring. The first win is control and auditability, not smart planning.

**Step 4: Implement executor**

`runIssueOrchestratorOnce()` should:

- Fetch open issues via `listIssues({ limit })`.
- Evaluate each issue.
- Respect `IssueControlProfile.mode`.
- For `suggest`: patch `next_action` only.
- For `act_with_approval`: create `agent_task` requiring approval.
- For `autonomous`: enqueue only safe actions.
- Append an issue event for every decision.
- Cap cycle at 10 issues.
- Use a single-flight mutex like `playbooks/runner.ts`.

**Step 5: Wire cron registry and OpsManager**

Add a cron definition:

```ts
{
  name: "IssueOrchestrator",
  description: "Evaluates open agent_issue rows and advances safe next actions",
  schedule: "*/5 * * * *",
  scheduleHuman: "Every 5 minutes",
  category: "intelligence",
}
```

In `src/lib/intelligence/ops-manager.ts`, register the job beside `IssueProjection`, but make it env-gated:

```ts
if ((process.env.ISSUE_ORCHESTRATOR_ENABLED ?? "false").toLowerCase() === "true") {
  // runIssueOrchestratorOnce(...)
}
```

Default disabled until Task 8 smoke passes.

**Step 6: Run focused tests**

```powershell
npm test -- src/lib/intelligence/issue-orchestrator.test.ts src/lib/scheduler/cron-registry.test.ts
```

Expected: pass.

**Step 7: Checkpoint**

Run with env disabled:

```powershell
npm run typecheck:cli
```

Expected: pass. Confirm the cron does not run unless `ISSUE_ORCHESTRATOR_ENABLED=true`.

**Step 8: Commit**

```powershell
git add src/lib/intelligence/issue-orchestrator.ts src/lib/intelligence/issue-orchestrator.test.ts src/lib/scheduler/cron-registry.ts src/lib/intelligence/ops-manager.ts
git commit -m "feat(issues): add gated issue orchestrator"
```

---

## Task 5: Add Shared Issue Control Service And API Routes

**Purpose:** Give Telegram and dashboard one shared control path for assigning handlers, setting control mode, running next step, pausing, resuming, blocking, clearing blockers, and completing.

**Files:**
- Create: `src/lib/intelligence/issue-control-actions.ts`
- Create: `src/lib/intelligence/issue-control-actions.test.ts`
- Modify: `src/app/api/command-board/issues/[id]/actions/route.ts`
- Modify: `src/app/api/command-board/issues/[id]/route.ts`
- Modify: `src/lib/command-board/types.ts`
- Modify: `src/lib/command-board/service.ts`

**Step 1: Write failing tests**

Required tests:

- `set_control_mode` patches `inputs.control.mode`.
- `assign_handler` calls `recordHandoff`.
- `pause` sets `inputs.control.paused = true`.
- `resume` clears pause.
- `set_blocker` calls `setBlocker`.
- `clear_blocker` calls `clearBlocker`.
- `run_next_step` calls `runIssueOrchestratorOnce({ issueId })` or an issue-scoped evaluator.
- API returns `Cache-Control: no-store` on 200/400/404/500.

**Step 2: Run red**

```powershell
npm test -- src/lib/intelligence/issue-control-actions.test.ts src/app/api/command-board/issues/route.test.ts
```

Expected: new tests fail.

**Step 3: Implement service**

`issue-control-actions.ts` exports:

```ts
export type IssueControlActionInput =
  | { action: "set_control_mode"; mode: IssueControlMode; actor: string; reason?: string }
  | { action: "assign_handler"; handler: string; actor: string; reason: string }
  | { action: "pause"; actor: string; reason?: string }
  | { action: "resume"; actor: string; reason?: string }
  | { action: "set_blocker"; reason: IssueBlockerReason; nextAction: string; actor: string }
  | { action: "clear_blocker"; actor: string; resumeState?: IssueLifecycleState }
  | { action: "run_next_step"; actor: string }
  | { action: "complete"; actor: string; resolution: string };

export async function applyIssueControlAction(issueId: string, input: IssueControlActionInput): Promise<{
  ok: boolean;
  message: string;
  issue?: AgentIssue | null;
}> { /* route to agentIssue + issue-control + orchestrator */ }
```

All branches must write or trigger an issue event.

**Step 4: Update API route**

Extend `POST /api/command-board/issues/:id/actions` to accept both legacy:

```json
{ "action": "approve" }
```

and new:

```json
{ "action": "set_control_mode", "mode": "autonomous", "reason": "safe read-only investigation" }
```

Keep approve/reject/resolve behavior unchanged and routed through existing task-action/AP paths.

**Step 5: Add detail fields**

Update `getCommandBoardIssueDetail()` to include:

- `control`
- `available_capabilities`
- `recommended_next_action`

Do not make the dashboard fetch huge catalogs per row. Detail only.

**Step 6: Run focused tests**

```powershell
npm test -- src/lib/intelligence/issue-control-actions.test.ts src/app/api/command-board/issues/route.test.ts
```

Expected: pass.

**Step 7: Checkpoint**

Use API without dashboard:

```powershell
Invoke-RestMethod 'http://localhost:3001/api/command-board/issues?limit=1&bust=1' | ConvertTo-Json -Depth 8
```

Then, against a known test/staging issue id only:

```powershell
Invoke-RestMethod 'http://localhost:3001/api/command-board/issues/<id>/actions' -Method POST -ContentType 'application/json' -Body '{"action":"pause","reason":"control smoke"}' | ConvertTo-Json -Depth 8
```

Expected: JSON response includes `ok: true`; issue detail shows `control.paused = true`.

**Step 8: Commit**

```powershell
git add src/lib/intelligence/issue-control-actions.ts src/lib/intelligence/issue-control-actions.test.ts src/app/api/command-board/issues src/lib/command-board/types.ts src/lib/command-board/service.ts
git commit -m "feat(issues): add shared control action service"
```

---

## Task 6: Add Telegram Issue Control Commands

**Purpose:** Make Telegram the primary safe control surface for issue control modes, handler assignment, pausing/resuming, blockers, and run-next-step.

**Files:**
- Modify: `src/cli/start-bot.ts`
- Create or modify: `src/lib/copilot/channels/telegram-callbacks.test.ts`
- Modify: `src/lib/intelligence/issue-control-actions.test.ts` if shared mocks need coverage.

**Step 1: Write failing tests**

Cover commands/callbacks:

- `/issue <id>` shows control mode, paused state, handler, blocker, next action.
- Inline buttons include pause/resume and run-next-step.
- `issue_pause_<id>` calls `applyIssueControlAction(..., { action: "pause", actor: "will-telegram" })`.
- `issue_resume_<id>` calls shared service.
- `issue_run_<id>` calls shared service.
- Existing callbacks still work: `issue_approve_`, `issue_reject_`, `issue_resolve_`, `issue_detail_`, `task_approve_`, `task_reject_`, `task_dismiss_`.

**Step 2: Run red**

```powershell
npm test -- src/lib/copilot/channels/telegram-callbacks.test.ts
```

Expected: new tests fail, old tests still compile.

**Step 3: Implement Telegram controls**

In `src/cli/start-bot.ts`:

- Import `applyIssueControlAction`.
- Add buttons to issue rows:
  - `Pause` if not paused
  - `Resume` if paused
  - `Run next`
  - existing `Approve`, `Reject`, `Resolve`, `Detail`
- Keep plain text output.
- Do not rename existing callback prefixes.

**Step 4: Run Telegram tests**

```powershell
npm test -- src/lib/copilot/channels/telegram-callbacks.test.ts src/lib/command-board/task-actions.test.ts
```

Expected: pass.

**Step 5: Checkpoint**

Run CLI typecheck:

```powershell
npm run typecheck:cli
```

Expected: pass.

Manual after deploy, not during unit test:

- `/issues`
- `/issue <id>`
- tap `Pause`
- tap `Resume`
- tap `Run next`

**Step 6: Commit**

```powershell
git add src/cli/start-bot.ts src/lib/copilot/channels/telegram-callbacks.test.ts src/lib/intelligence/issue-control-actions.test.ts
git commit -m "feat(bot): add issue control actions"
```

---

## Task 7: Add Lightweight Dashboard Issue Controls

**Purpose:** Provide a modest dashboard control panel for issues without reviving the heavy browser-killing command-board UI.

**Files:**
- Modify: `src/components/dashboard/command-board/IssuesPanel.tsx`
- Modify: `src/components/dashboard/command-board/CommandBoardShell.test.tsx` or create `src/components/dashboard/command-board/IssuesPanel.test.tsx`
- Modify: `src/lib/command-board/types.ts` if UI types need control fields.

**Step 1: Write failing UI tests**

Mock fetch responses and assert:

- Issue row shows lifecycle, handler, control mode, paused state, and next action.
- Clicking pause posts `{ action: "pause" }`.
- Clicking resume posts `{ action: "resume" }`.
- Clicking run-next posts `{ action: "run_next_step" }`.
- Human approval buttons still post approve/reject.
- No dashboard-wide data fetch is added beyond `/api/command-board/issues` and issue action POSTs.

Run:

```powershell
npm test -- src/components/dashboard/command-board/IssuesPanel.test.tsx
```

Expected: fail until UI is updated.

**Step 2: Implement compact controls**

Only update `IssuesPanel.tsx`:

- Add a compact control strip per issue:
  - control mode label
  - pause/resume button
  - run-next button
  - detail link
- Avoid expensive nested panels.
- Avoid loading catalog/tool data in list rows.
- Keep polling at 30 seconds.
- Keep icon buttons accessible with `aria-label`.

**Step 3: Run focused UI tests**

```powershell
npm test -- src/components/dashboard/command-board/IssuesPanel.test.tsx
```

Expected: pass.

**Step 4: Checkpoint**

Run component tests only:

```powershell
npm test -- src/components/dashboard/command-board
```

Expected: pass. Do not open browser preview. Do not hit `/dashboard`.

**Step 5: Commit**

```powershell
git add src/components/dashboard/command-board/IssuesPanel.tsx src/components/dashboard/command-board/IssuesPanel.test.tsx src/components/dashboard/command-board/CommandBoardShell.test.tsx src/lib/command-board/types.ts
git commit -m "feat(dashboard): add lightweight issue controls"
```

---

## Task 8: Integration Verification And Controlled Enablement

**Purpose:** Verify the whole system without using the unstable dashboard preview, then decide whether to enable the orchestrator cron.

**Files:**
- Modify only if fixing bugs found by verification.
- Optional docs update: `docs/plans/2026-04-29-aria-state-and-path-forward.md`
- Optional docs update: `docs/plans/2026-04-29-merge-summary.md`

**Step 1: Run all targeted tests**

```powershell
npm test -- src/lib/intelligence/agent-issue.test.ts src/lib/intelligence/issue-control.test.ts src/lib/intelligence/issue-state-machine.test.ts src/lib/intelligence/issue-orchestrator.test.ts src/lib/intelligence/issue-control-actions.test.ts src/lib/intelligence/ap-issue.test.ts src/lib/command-board/task-actions.test.ts src/lib/agents/tool-registry.test.ts src/lib/agents/issue-capabilities.test.ts src/lib/memory/index.test.ts src/lib/agents/budget.test.ts src/app/api/command-board/issues/route.test.ts src/components/dashboard/command-board/IssuesPanel.test.tsx
```

Expected: pass.

**Step 2: Run typechecks**

```powershell
npm run typecheck
npm run typecheck:cli
```

Expected: pass.

**Step 3: Run non-dashboard smoke**

```powershell
node --import tsx src/cli/smoke-merged-state.ts
```

Expected:

- Issues list/detail reachable.
- Tool/capability counts populated.
- Budget checks reachable.
- Timeline shows issue events and tool-call events where available.

**Step 4: Run API smoke**

With dev server already running on a safe port, not by opening a browser:

```powershell
Invoke-RestMethod 'http://localhost:3001/api/command-board/issues?limit=5&bust=1' | ConvertTo-Json -Depth 8
Invoke-RestMethod 'http://localhost:3001/api/command-board/tools?bust=1' | ConvertTo-Json -Depth 8
```

Expected:

- `Cache-Control: no-store` on command-board routes.
- Issues include control fields after Task 5.
- Tools/capabilities route returns registered tools.

**Step 5: Run Telegram smoke after deploy**

Commands:

```text
/issues
/blockers
/issue <known_issue_id>
```

Expected:

- Shows issue lifecycle, handler, control mode, blocker, next action.
- Pause/resume/run-next callbacks work.
- Existing approve/reject AP behavior unchanged.

**Step 6: Enable orchestrator only after green smoke**

Set:

```powershell
$env:ISSUE_ORCHESTRATOR_ENABLED="true"
```

Production deploy/restart:

```powershell
pm2 restart aria-bot --update-env
```

Expected:

- `IssueOrchestrator` appears in cron registry.
- It processes at most 10 issues/cycle.
- It writes decisions to `task_history`.
- It does not execute side-effect tools outside control mode.

**Step 7: Update docs**

Update `docs/plans/2026-04-29-aria-state-and-path-forward.md`:

- Mark Tool Registry, Memory Manager, budget, and issue controls as current state.
- State that dashboard remains forensic/lightweight until separately profiled.
- State that Aria runtime, not Codex, controls production issue flow.

**Step 8: Final checkpoint**

Run:

```powershell
git status --short
git log --oneline -n 10
```

Expected:

- Only intended files changed.
- Commits are task-sized.
- No generated local data files included.

Commit:

```powershell
git add docs/plans/2026-04-29-aria-state-and-path-forward.md docs/plans/2026-04-29-merge-summary.md
git commit -m "docs: update agentic runtime state"
```

---

## Definition Of Done

- Foundation checks pass before new orchestration work begins.
- Each issue has a typed control profile in `inputs.control`.
- Issue lifecycle transitions are guarded by one shared state-machine helper.
- Skills, playbooks, and tools are visible as issue capabilities.
- Issue Orchestrator can evaluate open issues and choose a bounded next action.
- Orchestrator is env-gated and disabled by default until smoke verification passes.
- Telegram can pause/resume/run-next/control issues through shared services.
- Dashboard has only lightweight issue controls; no heavy command-board expansion.
- Approve/reject AP paths still route through the reconciler/task-action path.
- Every issue control action appends an issue-scoped event.
- Tool calls with issue/task context are audited through Tool Registry.
- Typecheck, CLI typecheck, targeted tests, and non-dashboard smoke pass.

## Execution Options

**1. Subagent-Driven In This Session**

Dispatch one fresh subagent per task or task group. Review after every checkpoint. Best fit for this plan because ownership boundaries are clear and dashboard risk needs tight control.

**2. Parallel Session**

Open a dedicated worktree and run this plan with `superpowers:executing-plans`. Use this if you want a separate long-running implementation session while this session stays available for review.

Recommended: **Subagent-driven, sequential through Task 4, then Task 5 and Task 6 can split.**
