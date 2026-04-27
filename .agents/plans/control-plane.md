# Aria Control Plane — Plan

> Status: Proposed (2026-04-27). Branch: `claude/review-paperclip-control-plane-F9Qa4`.
> Decision: Physical `agent_task` hub from PR #1; phases 0-3 ship as the accountability spine,
> then phase 6 (thin GitHub coding-task adapter), then phases 4-5 (skill registry + injection)
> once phase 6 has provided the second skill-consumer.

## 1. Context

Will likes Paperclip's "one place for info" + ticket/issue model. Aria already has most of the
control-plane primitives wired and writing to Supabase, but they're scattered across ~10 tables
with no unifying ticket abstraction.

Today:
- No single pane of glass for "what is Aria doing right now / waiting on me / blocked".
- The dashboard, Telegram, cron logs, and Supabase tables each show one slice.
- New work (skills, GitHub coding tasks, manual asks) has no obvious place to land.

The goal is **not** to import Paperclip's architecture or become a generic coding-agent platform.
It is to add a thin **hub-and-spoke ticket layer** over the primitives that already exist so:

1. Every unit of work — cron failure, AP invoice approval, dropship forward, vendor scrape,
   manual ask, future code-change request — appears as a row in one `agent_task` table with a
   consistent status + owner + priority + approval gate.
2. Specialized tables (`ap_inbox_queue`, `ap_pending_approvals`, `cron_runs`, etc.) keep their
   domain columns and indexes; they gain a nullable FK to the hub.
3. Will gets one dashboard page + one Telegram command that lists every open task across the
   whole system.
4. A single GitHub coding-task adapter is added at the end as a sub-feature — not the
   architecture.

Telegram stays the human-in-loop UI. Dashboard becomes the visualizer. GitHub becomes a sink for
code-change tasks only.

## 2. What Already Exists (Verified)

These are working in production today; the plan **must not break them**.

| Primitive | File / Migration | Purpose |
|---|---|---|
| `OpsManager.safeRun()` | `src/lib/intelligence/ops-manager.ts:220-302` | Wraps every cron tick; writes to `cron_runs`, registers heartbeat, escalates to SupervisorAgent on failure |
| `OversightAgent` | `src/lib/intelligence/oversight-agent.ts` | 5m polling, 15m staleness; recovery cascade (retry → restart → reset → escalate) writes to `ops_control_requests` |
| `SupervisorAgent.supervise()` | `src/lib/intelligence/supervisor-agent.ts:73-159` | Polls `ops_agent_exceptions`, classifies via Claude (RETRY/ESCALATE/IGNORE), records decisions |
| `SkillCrystallizer` | `src/lib/intelligence/skill-crystallizer.ts` | Persists discovered skills into `skills` table with confidence + invocation stats |
| `cron_runs` | `20260415_create_ops_control_plane.sql` | Per-job execution log |
| `agent_heartbeats` | `20260415_create_ops_control_plane.sql` (live) | Liveness per agent — `heartbeat_at`, `metadata`, lowercase status |
| `task_history` | `20260417_create_task_history.sql` | Skill execution audit (success/failure/shadow) |
| `skills` | `20260417_create_skills.sql` | Registry: name, trigger, steps JSONB, confidence, review_status |
| `ops_control_requests` | `20260415` | Durable runbook commands (restart_bot, run_ap_poll_now, …) |
| `ops_agent_exceptions` | `20260305` | Exception queue, polled by SupervisorAgent |
| `ops_alert_events` | `20260415` | Alert dedup ledger |
| `ops_health_summary` VIEW | `20260415` + `20260416` fix | Single-row health roll-up |
| `email_inbox_queue` / `ap_inbox_queue` / `nightshift_queue` | `20260305` / `20260324` | Domain processing pipelines |
| `ap_pending_approvals` | (existing, hydrated at `reconciler.ts:127-194`) | Reconciler approvals **already persisted**; in-memory Map is just a cache |
| `copilot_action_sessions` | `20260325_create_copilot_artifacts_and_sessions.sql` | Durable pending-action sessions: PO send confirms, dropship-forward approvals, reconcile approvals. `action_type` ∈ `po_send` \| `po_review` \| `reconcile_approve` \| ...; replaces in-memory pendingDropships / pendingPOSends per `copilot/types.ts:55`. |

**Dropship note:** the `pending_dropships` table in `20260310_create_pending_dropships.sql`
exists but **no code writes to it**. The dropship store was refactored: deterministic dropships
matching a `routingRules` entry (`ap-agent.ts:60-86`) are forwarded inline to Bill.com with no
human in the loop (`ap-agent.ts:409-489`); the no-match dropship case that does need Will's
approval flows through `copilot_action_sessions`. The orphan `pending_dropships` table can be
dropped in a future cleanup migration but is out of scope for this plan.

**Correction to CLAUDE.md (applied in phase 1):** the "in-memory state lost on pm2 restart"
warning for the reconciler and PO sender is stale — both persist to Supabase and rehydrate on
boot. The dropship-store warning is also stale: the in-memory `pendingDropships` Map referenced
in CLAUDE.md no longer exists; durable dropship-approval state lives in `copilot_action_sessions`.
This plan focuses on **unification**, not adding persistence.

## 3. Design — Hub-and-Spoke

### 3.1 Hub: `agent_task` (new physical table)

Single source of truth for "what work exists." Writable; can be edited from the dashboard.

```sql
CREATE TABLE public.agent_task (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL,          -- 'cron_failure' | 'approval' | 'dropship_forward'
                                          --  | 'po_send_confirm' | 'control_command'
                                          --  | 'manual' | 'code_change' (phase 6)
  source_table    TEXT,                   -- spoke table name (audit aid)
  source_id       TEXT,                   -- spoke row id as text (UUID/BIGINT mixed)
  goal            TEXT NOT NULL,          -- one-line human-readable summary
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','CLAIMED','RUNNING',
                                    'NEEDS_APPROVAL','APPROVED','REJECTED',
                                    'SUCCEEDED','FAILED','EXPIRED','CANCELLED')),
  owner           TEXT NOT NULL DEFAULT 'aria',  -- 'aria' | 'will' | github username
  priority        SMALLINT NOT NULL DEFAULT 2,    -- 0 high, 4 low
  parent_task_id  UUID REFERENCES public.agent_task(id) ON DELETE SET NULL,
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approval_decision TEXT CHECK (approval_decision IN ('approve','reject') OR approval_decision IS NULL),
  approval_decided_by TEXT,
  approval_decided_at TIMESTAMPTZ,
  inputs          JSONB NOT NULL DEFAULT '{}'::jsonb,
  outputs         JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  retry_count     SMALLINT NOT NULL DEFAULT 0,
  max_retries     SMALLINT NOT NULL DEFAULT 0,
  deadline_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at      TIMESTAMPTZ,
  claimed_by      TEXT,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_agent_task_status_priority ON public.agent_task (status, priority, created_at DESC)
  WHERE status IN ('PENDING','CLAIMED','RUNNING','NEEDS_APPROVAL');
CREATE INDEX idx_agent_task_owner_status ON public.agent_task (owner, status);
CREATE INDEX idx_agent_task_source ON public.agent_task (source_table, source_id);
CREATE INDEX idx_agent_task_parent ON public.agent_task (parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE UNIQUE INDEX uq_agent_task_source ON public.agent_task (source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;
```

The `uq_agent_task_source` partial unique index is the dedup gate so a spoke can call
`createTaskFromSource()` idempotently.

### 3.2 Ledger: repurpose existing `task_history`

No new fourth audit table. Add `task_id UUID REFERENCES agent_task(id)` and `event_type TEXT` to
`task_history`. Existing `agent_name`, `task_type`, `input_summary`, `output_summary`, `status`,
`execution_trace` columns stay. New writes append per state transition.

### 3.3 Spokes (FK only when needed)

Only spokes whose rows can plausibly require human attention or dashboard surfacing get a
`task_id UUID NULL REFERENCES agent_task(id)`:

- `ap_pending_approvals`        — every row → hub row (always needs Will)
- `copilot_action_sessions`     — every pending row → hub row. `action_type` maps to hub `type`:
  `reconcile_approve` → `approval`; `po_send` / `po_review` / fallback → `po_send_confirm`;
  `dropship_forward` (when present) → `dropship_forward`. Every `action_type` that lands here
  needs Will.
- `ops_agent_exceptions`        — every row → hub row (Supervisor-resolved ones close fast)
- `ops_control_requests`        — every row → hub row (runbook command tracking)
- `cron_runs`                   — **failures only** → hub row (success path is high-volume noise)

`pending_dropships` is **not** a spoke. It exists in migration only; no production writer. The
dropship code path in `ap-agent.ts:409-489` forwards to Bill.com inline. If we ever reintroduce a
pending-dropship-review flow it will be via `copilot_action_sessions` (already a spoke).

High-volume domain queues (`email_inbox_queue`, `ap_inbox_queue`, `nightshift_queue`) do **not**
get a `task_id` for happy-path rows. They only spawn a hub row when escalating to
`NEEDS_APPROVAL` or `FAILED`.

### 3.4 Writers (no Postgres triggers)

Hub rows are inserted from TypeScript at the same call-sites that already write the spoke row.
This keeps control flow visible and testable.

| Spoke writer | File | New behavior |
|---|---|---|
| `safeRun()` failure path | `src/lib/intelligence/ops-manager.ts:270-300` | After `cron_runs` update + `ops_agent_exceptions` insert, call `agentTask.upsertFromSource('cron_runs', cronRunId, …)` |
| `storePendingApproval()` | `src/lib/finale/reconciler.ts:60-101` | After Supabase insert, call `agentTask.upsertFromSource('ap_pending_approvals', dbId, { status: 'NEEDS_APPROVAL', requires_approval: true, … })` |
| `createSession()` (copilot) | `src/lib/copilot/actions.ts` and `src/lib/copilot/actions.po-send.ts` | After `copilot_action_sessions` insert, call `agentTask.upsertFromSource('copilot_action_sessions', sessionId, …)`. One call-site per `action_type` (`po_send`, `po_review`, `reconcile_approve`, future `dropship_forward`). Replaces the older standalone `storePendingPOSend` writer. |
| `OversightAgent.escalate()` | `src/lib/intelligence/oversight-agent.ts` | After `ops_control_requests` insert |
| `SupervisorAgent.supervise()` | `src/lib/intelligence/supervisor-agent.ts:101-147` | Update hub row's `status`/`approval_decision` when classifying |

All writes are gated by `HUB_TASKS_ENABLED` env flag (default true in prod, false in test) so
rollback is a one-line config change.

### 3.5 Approval flow

Telegram callback handlers (`start-bot.ts:786-836` for approve/reject) read the spoke row as
today, then **also** write `agent_task.approval_decision` + `approval_decided_by` +
`approval_decided_at`. The dashboard sees the same decision in real time.

## 4. Phased Rollout

| # | Phase | Files | Est. LOC | Rollback | Success criterion |
|---|---|---|---|---|---|
| **0** | Fix duplicate `agent_heartbeats` migration | `supabase/migrations/20260417_create_agent_heartbeats.sql` (convert to ALTER no-op against the 0415 schema) | ~30 | Revert file | `supabase db reset` produces 0415 schema regardless of migration order |
| **1** | Hub schema + dashboard `/tasks` page + read-only display | `supabase/migrations/20260428_create_agent_task.sql` (CREATE TABLE + indexes + one-time backfill from existing pending rows in 3 spokes), `src/lib/intelligence/agent-task.ts` (new module), `src/app/api/dashboard/tasks/route.ts`, `src/app/dashboard/tasks/page.tsx`, `src/components/dashboard/TasksPanel.tsx` | ~600 | Drop table, delete page | Will sees one URL with every pending approval, dropship-forward action, exception, control request, recent cron failure |
| **2** | Wire spoke writers (`safeRun` failure, reconciler, copilot_action_sessions writers, po-send, oversight escalate, supervisor classify). Add `task_id` FK columns to spoke tables. | `supabase/migrations/20260429_add_task_id_to_spokes.sql`, edits to 5 call-sites in §3.4 | ~450 | `HUB_TASKS_ENABLED=false`; FK column nullable | After 24h, every new spoke row has a matching hub row; dashboard list updates without backfill |
| **3** | Repurpose `task_history` as ledger. Add `task_id` + `event_type` columns. Wire `agentTask.appendEvent()` at every status transition. | `supabase/migrations/20260430_extend_task_history.sql`, `src/lib/intelligence/agent-task.ts` (appendEvent) | ~250 | Columns nullable; old writers untouched | Every hub row has ≥1 ledger row by completion; dashboard shows event timeline |
| **4** ⏸ | Skill registry sync on boot. Scan `.agents/skills/*.md` + `.agents/workflows/*.md`, content-hash-gated upsert into `skills`, embed via Pinecone (`gravity-memory` index, namespace `aria-memory`). | `src/lib/skills/loader.ts` (new), edit `src/cli/start-bot.ts` boot sequence | ~250 | `SKILL_SYNC_ENABLED=false` | `SELECT count(*) FROM skills WHERE created_by='auto'` matches markdown file count after boot; re-boot is no-op (hash unchanged) |
| **5** ⏸ | Skill injection at runtime. Hybrid: keyword/agent_name filter, then Pinecone embedding lookup if >5 matches. Inject top-3 skills' `description` + `steps` into task context. | `src/lib/skills/resolver.ts` (new), call sites in `safeRun()` and bot tool handlers | ~250 | `SKILL_INJECTION_ENABLED=false` | `times_invoked` increments on real runs; success rate tracked per skill |
| **6** ⏸ | GitHub coding-task adapter. New `agent_task.type='code_change'`. Worker: open Issue → spawn Claude Code in worktree → open PR → webhook updates task status on PR review/merge. | `src/lib/intelligence/code-task-runner.ts`, `src/app/api/webhooks/github/route.ts` (extend), `.agents/workflows/code-task.md` | ~600 | Disable webhook subscription + `CODE_TASKS_ENABLED=false` | Manually filed `code_change` task produces a real PR; close-on-merge updates hub row |

⏸ = **sequenced behind phases 0-3.** Phases 0-3 are the committed accountability spine
(~1,300 LOC). Phase 6 is the next sequenced milestone (not indefinite). Phases 4-5 sequence
behind phase 6 because phase 6 is what creates the second consumer that justifies them.

**Sequencing rationale (revised 2026-04-27 after Paperclip recalibration):**

The Paperclip primitives worth keeping:
- Heartbeat ledger — agents that go silent get noticed (already exists; phase 0 fixes its schema bug).
- Ticket lifecycle (PENDING → CLAIMED → NEEDS_APPROVAL → SUCCEEDED/FAILED) — every unit of work
  has state, owner, deadline (phase 1).
- Agent handoff — Aria can hand a task to Claude Code, get it back, hand it to Will for approval,
  all in one timeline (phase 6, thin).
- Skills/workflows as runtime metadata — not just markdown that the supervisor never reads
  (phases 4-5).
- Run history with cost + decisions per run — auditable accountability (phase 3).

What we explicitly do NOT chase: adapter breadth (Codex + Cursor + CLI + HTTP all on day one),
multi-tenancy / org-chart ceremony, generic policy engine before there are 3+ rule consumers.

- **Phase 6 (GitHub coding-task adapter) is the next milestone after phase 3.** Ship it minimum
  viable: ONE adapter (Claude Code), ONE task type (`code_change`), ONE trigger (filed from
  `/tasks` page or Telegram). Resist Codex / Cursor / CLI / HTTP in the same PR — that is where
  Paperclip-style scope creep would actually hurt. The hub already absorbs `type='code_change'`
  without schema change.
- **Phase 4 (skill registry sync) and phase 5 (skill injection)** sequence after phase 6, because
  phase 6 creates the second consumer beyond `start-bot.ts` that justifies the loader: the GitHub
  adapter will want skills like "follow our PR conventions" or "always run typecheck:cli before
  commit" injected into its task context. Today the `skills` table already exists and
  `SkillCrystallizer` already populates it organically; a loader without two consumers is
  scaffolding.

The "is Aria becoming Paperclip?" answer remains **no.** Aria is an ops bot that adopts
Paperclip's primitives selectively. If general-purpose coding-agent breadth ever becomes a real
need, the right move is to use Paperclip itself, not rebuild it inside Aria.

**Committed roadmap order:** phases 0 → 1 → 2 → 3 → 6 → 4 → 5. Phases 0-3 ~1,300 LOC; phase 6
~600 LOC for the thin version; phases 4-5 ~500 LOC combined when phase 6 makes them necessary.

**Dropped from scope** (per review, not contested):
- Generic `task_policies` engine. Inline thresholds in `reconciler.ts` (3% / 10× / $500) stay as
  the only enforcement until ≥3 distinct call-sites need the same rule.
- A 4th audit log (`agent_task_events`). Use `task_history` instead.

**Acknowledged weak spots in current schema:**
- `cost_cents` ships unused. Phase 2 spoke writers will set it from `outputs.cost_cents` only
  where the call-site already tracks LLM/API spend (e.g. AP reconciler Claude calls). It stays
  `0` everywhere else. Don't add a "cost tracker" abstraction.

## 5. Smallest First PR (Phase 0 + Phase 1)

**One PR, ships standalone, delivers visible value:**

1. Fix `20260417_create_agent_heartbeats.sql` to ALTER the live 0415 schema instead of recreating
   it (real bug — fresh DB resets currently produce a divergent schema if migration order shifts).
2. New migration `20260428_create_agent_task.sql` — CREATE TABLE + indexes + one-time backfill
   that inserts hub rows for every currently-pending row in `ap_pending_approvals`,
   `copilot_action_sessions`, `ops_agent_exceptions`, plus `cron_runs` failures from the last 24h.
3. New module `src/lib/intelligence/agent-task.ts` — `upsertFromSource()`, `appendEvent()`,
   `decideApproval()`, `complete()`, `fail()`. No call-sites wired yet.
4. New API route `/api/dashboard/tasks` — list with filters (status, owner, type).
5. New page `/dashboard/tasks` — table with status badges, age, source link, action menu
   (approve/reject for `NEEDS_APPROVAL`, restart for `FAILED`). Supabase realtime subscription.
6. Update `CLAUDE.md` to remove the stale "in-memory state lost on pm2 restart" warning.

Estimated total: ~600 LOC. Reversible in <10 minutes (drop table + delete files).

After this PR ships and Will confirms it is useful, phases 2-6 follow on individual PRs.

## 6. Top 3 Risks

1. **`safeRun()` is hot path.** Adding hub writes for every cron failure is fine, but adding for
   every cron *success* would 12× write QPS. **Mitigation:** explicit "failure-only" gating in
   phase 2 — successes are tracked by `cron_runs` and `agent_heartbeats` only. Hub rows for
   successful runs are deferred until a real product need surfaces.
2. **Backfill race in phase 1 migration.** Inserting hub rows during a live AP poll could miss an
   in-flight approval. **Mitigation:** run backfill inside a transaction; the partial unique
   index `uq_agent_task_source` makes the migration retry-safe; phase 2 writers use upsert so any
   row missed by backfill self-heals on next event.
3. **Skill sync hammers Pinecone on dev churn (phase 4).** Edits to `.agents/skills/*.md` during
   active development would re-embed on every boot. **Mitigation:** content-hash gate stored in
   `skills.metadata.content_sha256`; only re-embed if hash differs.

## 7. Verification

End-to-end checks per phase:

- **Phase 0:** `npx supabase db reset --local && npm run typecheck:cli`. Confirm
  `\d agent_heartbeats` shows the 0415 column shape.
- **Phase 1:** `node _run_migration.js supabase/migrations/20260428_create_agent_task.sql`.
  Then: `SELECT count(*) FROM agent_task` ≈ sum of pending rows in 3 spokes + last-24h cron
  failures. Open `http://localhost:3000/dashboard/tasks`, confirm rows render with correct
  status badges.
- **Phase 2:** Trigger a known-failing cron via `ops_control_requests` insert with
  `command='run_ap_poll_now'` against an invalid token. New row appears in `agent_task` with
  `type='cron_failure'`, `status='FAILED'`. Approve a real reconciler discrepancy via Telegram —
  confirm `agent_task.approval_decision='approve'` and dashboard reflects it within 5s.
- **Phase 3:** Approve a hub row from the dashboard; confirm `task_history` gains an
  `event_type='approved'` row with `task_id` set.
- **Phase 4:** `pm2 restart aria-bot`; check `SELECT count(*) FROM skills WHERE created_by='auto'`
  matches `find .agents/skills .agents/workflows -name '*.md' | wc -l`. Re-restart; confirm count
  unchanged and no Pinecone upsert in logs.
- **Phase 5:** Run a known cron task that has a matching skill; confirm
  `times_invoked` increments and the skill's `steps` appear in the task's `inputs.injected_skills`.
- **Phase 6:** From dashboard, file a `code_change` task ("rename `foo` to `bar` in `src/util/x.ts`").
  Confirm Issue is opened, branch created, PR appears, hub row transitions to `SUCCEEDED` on
  merge.

## 8. Critical Files

New:
- `supabase/migrations/20260428_create_agent_task.sql`
- `supabase/migrations/20260429_add_task_id_to_spokes.sql`
- `supabase/migrations/20260430_extend_task_history.sql`
- `src/lib/intelligence/agent-task.ts`
- `src/lib/skills/loader.ts`
- `src/lib/skills/resolver.ts`
- `src/lib/intelligence/code-task-runner.ts`
- `src/app/api/dashboard/tasks/route.ts`
- `src/app/dashboard/tasks/page.tsx`
- `src/components/dashboard/TasksPanel.tsx`
- `.agents/workflows/code-task.md`

Edited:
- `supabase/migrations/20260417_create_agent_heartbeats.sql` (convert to ALTER no-op)
- `src/lib/intelligence/ops-manager.ts` — `safeRun()` failure path emits hub row
- `src/lib/finale/reconciler.ts` — `storePendingApproval()` emits hub row
- `src/lib/copilot/actions.ts` and `src/lib/copilot/actions.po-send.ts` — every `copilot_action_sessions` insert emits hub row (covers `po_send`, `po_review`, `reconcile_approve`, future `dropship_forward`)
- `src/lib/intelligence/oversight-agent.ts` — `escalate()` emits hub row
- `src/lib/intelligence/supervisor-agent.ts` — `supervise()` updates hub row's status
- `src/cli/start-bot.ts` — approve/reject callbacks update hub row (phase 2); boot calls skill loader (phase 4, deferred)
- `src/app/api/webhooks/github/route.ts` — extend for code-change PRs (phase 6, deferred)
- `CLAUDE.md` — remove stale in-memory warning; add `/dashboard/tasks` reference

**Removed from earlier draft:** `src/lib/intelligence/dropship-store.ts` and `src/lib/purchasing/po-sender.ts` (`storePendingPOSend`).
The dropship store does not exist; dropships flow inline through `ap-agent.ts`. PO-send state
already routes through `copilot/actions.po-send.ts` writing to `copilot_action_sessions`, which
is covered by the copilot writer above.

## 9. Open Questions for Will

None blocking. To revisit during phase 1 review:
- Owner field default: should manual asks default to `owner='will'` or `owner='aria'`?
- Telegram `/tasks` command: list top 5 PENDING + NEEDS_APPROVAL? Add in phase 1 or phase 2?
- Should the dashboard `/tasks` page poll every 5s or use Supabase realtime subscriptions?
  (Realtime is preferred but adds a dependency on `supabase-js` realtime client setup.)
