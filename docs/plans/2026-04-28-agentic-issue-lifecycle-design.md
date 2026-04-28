# Plan D — Agentic Issue Lifecycle (Design Doc)

> **Status:** Design doc, not an executable plan. Review + decide on the data-model questions below before I write the implementation plan. The five `## Open Questions` at the bottom are blockers to proceeding.

## Context

The command board today is a **task viewer**. Each row is one `agent_task` representing one decision point. Empty lanes look broken even when the system is healthy. Blocked / Failed implies stopped. Recently Closed is a graveyard of duplicated `restart_bot` rows, not an audit trail.

What you actually want is a **case ledger**. Each row is one operational *issue* — an invoice arriving, a receipt missing, an alert firing. The system attempts to advance the issue through agents and known guides. The card shows where it is, what was tried, what's next, and only escalates to "Needs Will" after autonomy has been exhausted.

The existing primitives — `agent_task`, `task_history`, spoke writers, closure cron, playbook runner — are the *plumbing* for that. They're at the wrong level of abstraction in the UI. We need an issue layer that owns multiple tasks/attempts and tracks lifecycle.

## Core model

```
Issue           ← the operational thing ("Invoice 124618 from Colorado Worm Co.")
 ├─ Steps       ← agent attempts on this issue (= existing agent_task rows)
 ├─ Handoffs    ← agent A → agent B (= ledger events on the issue)
 ├─ Lifecycle   ← detected | triaging | working | waiting_external | blocked | complete
 ├─ Autonomy    ← working | waiting | retrying | resolved | needs_policy
 ├─ Blocker     ← explicit string: missing_receipt | po_not_found | policy_required | …
 └─ Next action ← human-readable summary of what the agent will try next
```

### Why a separate `agent_issue` table

The alternative is "use existing `agent_task` with `parent_task_id`" — top-level row is the issue, children are steps. This avoids a migration but conflates two concepts that have different lifecycles and different schemas. Steps are short-lived attempts; issues persist for hours-to-days and aggregate state.

Concrete schema sketch:

```sql
CREATE TABLE public.agent_issue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,            -- "Invoice 124618 from Colorado Worm Co."
    source_table    TEXT,                     -- "ap_inbox_queue" or null for synthetic issues
    source_id       TEXT,                     -- gmail message id or similar
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (
        'detected','triaging','working','waiting_external','blocked','complete'
    )),
    autonomy_state  TEXT CHECK (autonomy_state IN (
        'working','waiting','retrying','resolved','needs_policy'
    )),
    current_handler TEXT,                     -- agent id, e.g. "ap-agent"
    blocker_reason  TEXT,                     -- enum-like: 'missing_receipt' | 'po_not_found' | …
    next_action     TEXT,                     -- human-readable
    priority        SMALLINT NOT NULL DEFAULT 2,
    owner           TEXT NOT NULL DEFAULT 'aria',  -- 'aria' or 'will'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    inputs          JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs         JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (source_table, source_id)
);

ALTER TABLE public.agent_task ADD COLUMN issue_id UUID REFERENCES agent_issue(id) ON DELETE SET NULL;
CREATE INDEX idx_agent_task_issue_id ON agent_task (issue_id);
```

Existing `agent_task` rows stay as-is and become "steps" linked to a parent issue. The `task_history` ledger already records every state change — handoff events become `event_type='handoff'`.

## What changes for each surface

| Surface | Before | After |
|---|---|---|
| Telegram `/tasks` | Lists `agent_task` rows | Lists `agent_issue` rows; tap shows steps |
| Dashboard board | 5 task lanes | Active Issues list + autonomy badge per row |
| Recently Closed | Closed tasks (mostly noise) | Closed issues (rare; meaningful) |
| Task detail panel | Raw event ledger | Timeline: Detected → Routed → Step 1 → Step 2 → Escalated |
| AP pipeline | Creates approval task on price variance | Creates issue at email-arrival, advances through ap-agent → reconciler → approval |
| Reconciler approval | Manual_only task | A *step* on an existing issue, marked manual_only |

## Lifecycle state machine

```
detected
   ↓ agent picks up
triaging
   ↓ figures out which playbook/agent
working
   ↓
   ├─ resolved → complete
   ├─ blocked (with reason) → blocked
   └─ external dep (e.g. waiting on vendor email) → waiting_external
              ↓ external responded
              working
```

`autonomy_state` is orthogonal — describes the *attempt loop*, not the case state:
- `working` — currently running a step
- `waiting` — between cron ticks; a playbook is queued
- `retrying` — last step failed, retry budget remains
- `resolved` — terminal success
- `needs_policy` — exhausted automation, policy decision required (= "Needs Will" lane)

## Migration / backfill strategy

Phase 1 — additive only:
- Create `agent_issue` table.
- Add `agent_task.issue_id` (nullable).
- Spoke writers continue creating tasks as today.
- A new `IssueProjectionCron` reads recent tasks, groups by `(source_table, source_id)`, creates/updates issue rows.
- UI renders issues if available, falls back to task view.

Phase 2 — direct writes:
- Spoke writers (ap-agent, reconciler, dropship) create issues directly.
- Existing tasks become steps under the issue.
- Projection cron stops.

Phase 3 — UI cutover:
- Dashboard switches to issue-primary.
- Telegram `/tasks` becomes `/issues` (alias kept).

This staging keeps every release shippable independently.

## Handoff modeling

A handoff is a state transition recorded as a single `task_history` row on the issue:

```jsonb
{
    "event_type": "handoff",
    "from_handler": "email-agent",
    "to_handler": "ap-agent",
    "reason": "Email classified as INVOICE",
    "at": "2026-04-28T14:30:00Z"
}
```

Plus an update on `agent_issue.current_handler`. The timeline view groups events around handoffs to show "the case was with X, then handed to Y, who tried Z".

## Open questions (need your call before I plan implementation)

1. **Granularity:** is "one email = one issue" right? Or should a single PO that spawns a PO-send + invoice-arrival + receiving-confirmation be ONE issue spanning all three?
2. **Blocker enum:** what's the closed list? My starting set: `missing_receipt`, `po_not_found`, `vendor_mismatch`, `extraction_failed`, `policy_required`, `external_pending`. Is that complete?
3. **Manual issues:** do you ever want to create an issue by hand from the dashboard ("Investigate why Q1 inventory variance is off")? Or are issues always system-detected?
4. **Telegram:** keep the existing `/tasks` command or rename to `/issues`? Risk of muscle memory either way.
5. **Backfill window:** when the projection cron runs the first time, how far back does it group tasks into issues? Last 7 days? All open tasks regardless of age?

## What I'd do first if you say yes

Smallest valuable slice:
1. Migration: `agent_issue` table + `agent_task.issue_id` column. Non-destructive.
2. `agent-issue.ts` lib: `createOrAdvance`, `recordHandoff`, `setBlocker`, `complete`. Mirrors the agent-task surface.
3. AP pipeline rewires `processIncomingEmail` to create an issue, then call existing reconciler — reconciler's hub-write becomes a step on that issue.
4. Dashboard renders issues list (feature-flagged). Tasks view stays available behind `?view=tasks`.
5. Iterate.

That's roughly the same shape as Plan A — 6–8 tasks, ~1500 LOC, achievable in a single PR.

---

**Decision needed:** answer the five open questions above, then I'll write Plan D as an executable plan and ship it.
