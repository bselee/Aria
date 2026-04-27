# Aria Task Learning Loop — Design Spec

> Status: Proposed (2026-04-27). Branch: `claude/review-paperclip-control-plane-F9Qa4`.
> Builds on: `.agents/plans/control-plane.md` (phases 0+1 already live, phase 2 in flight).
> Decision: Three-layer architecture — hygiene → observation → confidence-graded auto-handling.
> Autonomy posture: hybrid (option C). Rules auto-promote `proposed → shadow → active` based on
> accuracy counters; promotion to `trusted` (silent operation) requires explicit Will-approval.
> Demotion is always automatic.

## 1. Why this exists

The `agent_task` hub is now live. Phase 1 backfill seeded 38 rows. **All 38 are the same task**
(`control_command/restart_bot` against `aria-bot` watchdog), accumulating between 2026-04-15 and
2026-04-23. Underlying `ops_control_requests` shows 38 rows all with `status='pending'`, none
ever closed. The watchdog re-emits `restart_bot` every time the heartbeat goes stale; the
consumer (`pm2 restart aria-bot`) does not update `ops_control_requests.status`. The same signal
piles up indefinitely.

This is the canonical case for what this design must solve:

1. **Hygiene first.** A "fewer tasks" goal cannot start with ML on dirty data. Hub volume must
   first reflect *real* outstanding work, not stale exhaust.
2. **Then learn.** Once signal is clean, observe what actually repeats. AP invoice approvals,
   dropship forwards, and known control_commands are the visible candidates.
3. **Then automate, with a trust gradient.** Repeated patterns that match Will's decisions
   ≥95% of the time get to act on his behalf, with rollback when outcomes diverge.

The spec preserves Will's stated guardrails: frugal (no unnecessary API costs), accountability
(every auto-decision lives in an audit ledger), and "fun" (Telegram/dashboard surfaces stay
the human-in-loop UI; learning happens in the background).

## 2. What already exists (verified)

These primitives ship in production today and are reused unchanged where possible:

| Primitive | File / Migration | Used as |
|---|---|---|
| `agent_task` hub | `20260428_create_agent_task.sql` (live) | Layer 1 dedup target |
| `task_history` | `20260417_create_task_history.sql` | Layer 2 observation log (extended in original plan §3.2) |
| `skills` | `20260417_create_skills.sql` | Layer 3 rule storage (extended with trust gradient) |
| `SkillCrystallizer` | `src/lib/intelligence/skill-crystallizer.ts` | Layer 2 candidate writer |
| `nightshift_queue` | `20260324_create_nightshift_queue.sql` | Layer 2 host queue |
| Ollama (qwen2.5:1.5b) → Haiku rail | `nightshift-agent.ts`, `llm.ts` | Layer 2 cluster summarization |
| OpsManager cron | `ops-manager.ts:220-302` | Layer 1 closeWhen + layer 2 nightly mine |
| `agent_heartbeats` | `20260415` | Layer 1 closeWhen evaluation source |

This spec **adds zero new services, queues, or auth domains.** It extends three existing tables
and adds one new audit ledger.

## 3. Data model

### 3.1 `agent_task` extensions

```sql
ALTER TABLE public.agent_task
  ADD COLUMN IF NOT EXISTS dedup_count    INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS input_hash     TEXT,
  ADD COLUMN IF NOT EXISTS closes_when    JSONB,
  ADD COLUMN IF NOT EXISTS auto_handled_by UUID REFERENCES public.skills(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_task_input_hash
  ON public.agent_task (source_table, input_hash)
  WHERE status IN ('PENDING','NEEDS_APPROVAL','RUNNING','CLAIMED');
```

- `dedup_count` — incremented when an identical signal arrives while an open task already exists.
- `input_hash` — SHA-256 of the canonical-stringified `inputs` JSONB. Used as the dedup key.
- `closes_when` — JSONB predicate the closure cron evaluates against current state. Examples:
  ```json
  { "kind": "agent_boot_after",  "agent": "aria-bot" }
  { "kind": "spoke_status",      "table": "ap_pending_approvals", "value": "approved" }
  { "kind": "deadline",          "max_age_hours": 24 }
  ```
- `auto_handled_by` — non-null if this task was resolved by an auto-rule. Audit lineage.

### 3.2 `skills` extensions (trust gradient)

```sql
ALTER TABLE public.skills
  ADD COLUMN IF NOT EXISTS trust_level       TEXT NOT NULL DEFAULT 'proposed'
    CHECK (trust_level IN ('proposed','shadow','active','trusted','retired')),
  ADD COLUMN IF NOT EXISTS accuracy_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disagree_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_decision_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS demoted_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS demotion_reason   TEXT,
  ADD COLUMN IF NOT EXISTS predicate_jsonb   JSONB,    -- match expression
  ADD COLUMN IF NOT EXISTS action_jsonb      JSONB,    -- side-effect spec
  ADD COLUMN IF NOT EXISTS last_disagreement_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shadow_to_active_threshold INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS trained_on_schema_version TEXT,
  ADD COLUMN IF NOT EXISTS trained_match_distribution JSONB;  -- for drift detection (vendor histogram, etc.)
```

`predicate_jsonb` shape:
```json
{
  "source_table": "ap_pending_approvals",
  "input_match": {
    "vendor_name": { "ilike": "%uline%" },
    "amount": { "lte": 500 },
    "diff_pct": { "lte": 0.03 }
  }
}
```

`action_jsonb` shape:
```json
{
  "kind": "auto_approve",
  "side_effect": "reconciler.applyApproval",
  "max_retries": 1,
  "override_kind": "rollback",
  "verifier_kind": "finale_write_then_billcom_label"
}
```

`override_kind` controls how a Will-override at +1h-to-+24h actually un-does the auto-decision:
- `rollback` — reversible side-effect (e.g., approval not yet propagated to Finale write).
  Override calls the side-effect's reverse function.
- `corrective_task` — irreversible (e.g., Finale write already landed and Bill.com forward
  already sent). Override opens a new `agent_task` of `type='corrective'` with the original
  task as `parent_task_id`, owner=`will`, priority=0. Will resolves the corrective action
  manually. The auto-rule still records `will_overrode=true`.

`verifier_kind` names the +24h outcome check (see §6.3). Rules whose action lacks a verifier
(`verifier_kind: null`) cap at `active`, never reach `trusted`.

JSONB matchers are deterministic (no LLM at runtime). Supported operators: `eq`, `lte`, `gte`,
`ilike`, `regex`, `in`. Anything more expressive becomes a code-defined skill (existing
`SkillCrystallizer` path with a real TS function).

### 3.3 `task_history` as observation log

Phase 3 of the original plan already adds `task_id UUID` and `event_type TEXT` to
`task_history`. This spec layers on top of that without further schema change. Each resolved
`agent_task` writes one summary row:

```ts
{
  task_id: <uuid>,
  agent_name: 'agent-task',
  task_type: 'resolution_summary',
  event_type: 'resolved',
  status: 'success' | 'failure',
  input_summary: '<vendor> <amount> <type>',
  output_summary: 'auto:<rule_id>' | 'manual:<approve|reject>',
  execution_trace: { latency_seconds, decision, will_overrode_after }
}
```

The pattern miner queries this table — it does not need a separate observation table.

### 3.4 New table: `auto_rule_decision`

```sql
CREATE TABLE public.auto_rule_decision (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         UUID NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  task_id         UUID NOT NULL REFERENCES public.agent_task(id) ON DELETE CASCADE,
  trust_level_at_decision TEXT NOT NULL,         -- 'shadow' | 'active' | 'trusted'
  decision        TEXT NOT NULL CHECK (decision IN ('approve','reject','skip')),
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome_at      TIMESTAMPTZ,
  outcome_status  TEXT CHECK (outcome_status IN ('agreed','overridden','outcome_failure',NULL)),
  will_overrode   BOOLEAN NOT NULL DEFAULT FALSE,
  override_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_auto_rule_decision_rule_recent
  ON public.auto_rule_decision (rule_id, applied_at DESC);
CREATE INDEX idx_auto_rule_decision_outcome
  ON public.auto_rule_decision (rule_id, outcome_status, applied_at DESC)
  WHERE outcome_status IS NOT NULL;
```

This is the audit ledger that powers (a) demotion logic, (b) the Telegram daily digest, and
(c) the `/dashboard/rules` accuracy view. It is the only **new** table this design adds.

## 4. Layer 1 — Hygiene

### 4.1 Dedup at insert (`incrementOrCreate`)

`src/lib/intelligence/agent-task.ts` gains:

```ts
export async function incrementOrCreate(input: AgentTaskInput): Promise<AgentTask> {
  const inputHash = sha256(canonicalize(input.inputs ?? {}));
  // Try to find an existing OPEN task with same source + hash
  const existing = await supabase.from('agent_task')
    .select('*')
    .eq('source_table', input.source_table)
    .eq('source_id', input.source_id)
    .eq('input_hash', inputHash)
    .in('status', ['PENDING','NEEDS_APPROVAL','RUNNING','CLAIMED'])
    .maybeSingle();
  if (existing.data) {
    // Bump count, update timestamp, return existing
    return await supabase.from('agent_task')
      .update({ dedup_count: existing.data.dedup_count + 1, updated_at: new Date().toISOString() })
      .eq('id', existing.data.id).select().single();
  }
  // Otherwise insert new with hash + closes_when from registry
  return await upsertFromSource({ ...input, input_hash: inputHash, closes_when: closesWhenFor(input) });
}
```

All phase-2 spoke writers route through `incrementOrCreate` (not `upsertFromSource`) so dedup
is transparent to the call-site.

### 4.2 closesWhen registry + cron

`src/lib/intelligence/agent-task-closure.ts` (new):

```ts
const CLOSURE_PREDICATES: Record<string, (task: AgentTask) => Promise<boolean>> = {
  agent_boot_after: async (t) => {
    const agent = t.closes_when.agent;
    const hb = await supabase.from('agent_heartbeats')
      .select('updated_at').eq('agent_name', agent).eq('status','healthy')
      .single();
    return hb.data && new Date(hb.data.updated_at) > new Date(t.created_at);
  },
  spoke_status: async (t) => {
    const { table, value } = t.closes_when;
    const r = await supabase.from(table).select('status').eq('id', t.source_id).single();
    return r.data?.status === value;
  },
  deadline: async (t) => {
    const maxAgeMs = t.closes_when.max_age_hours * 3600 * 1000;
    return Date.now() - new Date(t.created_at).getTime() > maxAgeMs;
  },
};

export async function closeFinishedTasks() {
  const open = await supabase.from('agent_task')
    .select('*')
    .in('status', ['PENDING','NEEDS_APPROVAL','RUNNING','CLAIMED'])
    .not('closes_when','is',null);
  for (const t of open.data ?? []) {
    const fn = CLOSURE_PREDICATES[t.closes_when.kind];
    if (fn && await fn(t)) {
      await supabase.from('agent_task')
        .update({ status: 'SUCCEEDED', completed_at: new Date().toISOString() })
        .eq('id', t.id);
    }
  }
}
```

`OpsManager` registers `closeFinishedTasks` as a 5-min cron job.

### 4.3 Stuck-source meta-task

When `incrementOrCreate` bumps `dedup_count` past 5 AND the task is older than 1h, emit a
new `agent_task` of type `stuck_source` with `priority=0` and a goal like `"Investigate: 38
restart_bot commands accumulated without closure"`. The meta-task has its own `parent_task_id`
linking back to the duplicated task. Will sees one investigation prompt instead of N
duplicates.

### 4.4 One-time hygiene migration

`20260501_hygiene_backfill.sql`:

1. For every group of open `agent_task` rows with same `(source_table, source_id, input_hash)`:
   keep the oldest, set `dedup_count = group_size`, delete the rest.
2. Populate `closes_when` for backfilled rows from a static map keyed on `type`.
3. Run `closeFinishedTasks()` once inline. Expected outcome on current DB: 38 → ~2 rows.

LOC estimate: ~250 (module + cron registration + migration).

## 5. Layer 2 — Observation + proposal

### 5.1 Nightly `pattern_mine` job

Added to existing nightshift rail. Runs at 2 AM (separate from email classification at 6 PM):

1. `OpsManager.enqueue('pattern_mine')` writes one `nightshift_queue` row.
2. Worker `src/lib/intelligence/workers/pattern-miner.ts` queries:
   ```sql
   SELECT
     th.task_type,
     at.source_table,
     at.inputs->>'vendor_name' AS vendor,
     th.execution_trace->>'decision' AS decision,
     count(*) AS n,
     count(*) FILTER (WHERE th.status='success' AND NOT (th.execution_trace->>'will_overrode_after' = 'true'))::float / count(*) AS agreement_rate
   FROM task_history th
   JOIN agent_task at ON at.id = th.task_id
   WHERE th.created_at > NOW() - INTERVAL '30 days'
     AND th.event_type = 'resolved'
   GROUP BY 1,2,3,4
   HAVING count(*) >= 5 AND agreement_rate >= 0.95;
   ```
3. Each row above is a **candidate**. Worker calls Ollama to draft a one-line description, then
   if `count >= 50 OR span_days >= 30`, escalates to Claude Haiku to generate
   `predicate_jsonb` + `action_jsonb`.
4. Inserts into `skills` with `trust_level='proposed'`. **No execution.**

### 5.2 `/dashboard/rules` page

New Next.js route. Tabs by trust_level. Per-rule view shows:

- Predicate (formatted JSONB)
- Last 30 days `task_history` matches the predicate would have caught (simulation)
- Accuracy counters
- Action buttons: `Approve → shadow`, `Reject (soft delete)`, `Promote → trusted` (only enabled
  when `trust_level='active'`)

Cost ceiling: max 10 candidates surfaced/week. Haiku per-candidate ≈ $0.0003. Cap: $0.10/week.

LOC estimate: ~400.

## 6. Layer 3 — Trust gradient state machine

### 6.1 State transitions

```
proposed ──[Will: approve on /dashboard/rules]──▶ shadow
shadow   ──[20 consecutive agreements]──▶ active        (auto)
active   ──[Will: "Promote to trusted" button]──▶ trusted   ← gated
                  ┃                  ┃
                  ▼ (anywhere)       ▼
   [≥2 disagreements in 7d]      ──▶ shadow + Telegram alert
   [≥1 outcome_failure]          ──▶ shadow + Telegram alert
```

**Counts and thresholds:**
- `accuracy_count` increments on each agreement (Will resolves the same way the rule would have,
  observed from `task_history`).
- `disagree_count` increments on each disagreement (Will overrides within 24h, OR `task_history`
  records the opposite decision in shadow mode).
- `last_disagreement_at` records the most recent `disagree_count` increment.
- Promotion gate `shadow → active`: `accuracy_count - disagree_count >= shadow_to_active_threshold`
  AND `last_disagreement_at IS NULL OR last_disagreement_at < NOW() - INTERVAL '14 days'`.
  (This is "≥N net agreements with a 14-day clean tail" — strictly stronger than literal
  "consecutive" since a single old disagreement doesn't reset the counter, but the rule must
  be *currently* clean.)
- `shadow_to_active_threshold` is **per-rule** (default 20). Set lower for high-cadence
  patterns: AP=20 (≈3-4 weeks of vendor coverage), dropships=15 (faster signal), runbook
  rules like control_command=5 (cadence is per-incident; 20 would mean 10 weeks). The miner
  sets this when proposing the rule, based on observed historical cadence.
- Demotion check runs at 8 AM daily. Threshold: `disagree_count` deltas in the trailing 7 days
  ≥ 2 → demote. **Demotion resets `accuracy_count = 0` and `disagree_count = 0`** (otherwise a
  rule at 30 + 2 demotes, then on day 15 still has 28 net and would auto-re-promote). A
  14-day cooldown after demotion blocks re-promotion regardless (Risk #4 in §10).
- Retirement: Will can retire any rule from `/dashboard/rules` (manual). A rule is also
  auto-retired after 90 days at `trust_level='shadow'` with no agreements (i.e., predicate
  never matched real traffic — the pattern dried up). **Retired rules block re-proposal of
  the same predicate hash for 60 days** (matches the soft-delete cooldown in §5.1). Older
  retirements unblock so seasonal patterns (year-end vendor surge, etc.) can be re-proposed
  when the data reappears.

### 6.2 Per-state behavior

| State | Predicate runs? | Side-effect runs? | Hub row visible to Will? | Telegram digest? |
|---|---|---|---|---|
| proposed | ❌ | ❌ | ❌ | ❌ |
| shadow | ✅ (logs only) | ❌ | ✅ (Will still decides) | ❌ |
| active | ✅ | ✅ | hidden by default (toggle to show) | ✅ ("Auto-handled overnight: …") |
| trusted | ✅ | ✅ | hidden by default | ❌ (silent) |
| retired | ❌ | ❌ | n/a | n/a |

Override window: 24h after `auto_rule_decision.applied_at`. Will can override via Telegram (tap
"undo" on digest entry) or `/dashboard/tasks`. Override → `auto_rule_decision.will_overrode=true`,
side-effect rolled back if reversible.

### 6.3 Outcome verification

For each `auto_rule_decision`, a follow-up cron at +24h checks downstream state via the
verifier named in `action_jsonb.verifier_kind`. Verifier registry:

| `verifier_kind` | Check |
|---|---|
| `finale_write_then_billcom_label` | Reconciler-approved invoice — Finale `orderItem.unitPrice` write returned success in audit log AND Gmail message in `ap@buildasoil.com` outbox has `Bill.com Forwarded` label applied |
| `gmail_send_with_label` | Dropship forward — Gmail message ID exists in sent items AND vendor-specific label applied (e.g., `Logan Labs (Dropship)`) |
| `agent_heartbeat_fresh` | Control command — `agent_heartbeats.heartbeat_at > applied_at` AND `status='healthy'` |
| `null` | No verifier available — rule capped at `active`, ineligible for `trusted` |

Note: there is **no Bill.com receive/ack API** — the closest signal we have is the Gmail
forward label. Verifiers are chosen for what's actually observable, not what would be ideal.

Failure → `outcome_status='outcome_failure'`, immediate demotion, Telegram alert.

LOC estimate: ~600 across `agent-task.ts` (auto_handled_by routing), new
`src/lib/intelligence/auto-rule-engine.ts`, and Telegram digest extension in `start-bot.ts`.

## 7. Telegram + dashboard surfaces

### 7.1 `/dashboard/tasks`

- New chip on rows where `auto_handled_by IS NOT NULL`: `🤖 <skill.name>` with hover showing
  predicate match and rule trust level.
- Filter toggle "Hide auto-handled" (default ON).
- Click chip → opens rule on `/dashboard/rules`.

### 7.2 `/dashboard/rules` (new)

Already specified in §5.2. Layout mirrors `/dashboard/tasks` — same card style, same status
badges (using trust_level), same action menu pattern.

### 7.3 Telegram

- **`/tasks` command** (already designed in option A from prior conversation): unchanged.
  Auto-handled tasks excluded from default view.
- **`/tasks --history`** (or `/tasks history`): paginated list of last 24h auto-handled
  decisions, with override buttons per row.
- **Daily digest** (extends existing 8 AM cron): new line `🤖 Auto-handled overnight: <count>
  tasks (<rule_count> rules). Tap to review.` Tap fires a Telegram callback that posts a
  follow-up message with one line per auto-handled task and an inline `[↩ Override]` button
  per row. Override resolves to the existing reconciler/spoke override path; the follow-up
  message is left in chat history (not auto-deleted).
- **Demotion alerts**: when a rule auto-demotes, send Telegram message:
  `⚠️ Rule "<name>" demoted to shadow — disagreed twice this week. Last disagreement: <task_goal>.
  See /dashboard/rules for details.`

## 8. Defaults Will should review

Set with rationale; tunable in code:

| Knob | Default | Rationale | Where |
|---|---|---|---|
| Cluster size threshold (launch) | **10** | 5 examples can be one weird vendor month. Code holds 5 as the floor for tuning down later if patterns are sparse; ship at 10. | `pattern-miner.ts` `MIN_CLUSTER_SIZE` (default 10, floor 5) |
| Agreement rate threshold | 95% | High bar; one disagreement per 20 still passes | `pattern-miner.ts` `MIN_AGREEMENT_RATE` |
| Span requirement for Haiku | 50 examples OR 30 days | Avoids burst patterns proposing | `pattern-miner.ts` `HAIKU_GATE` |
| Shadow → active threshold | **per-rule, default 20** | AP=20 (≈3-4 weeks vendor coverage), dropships=15 (faster signal), control_command=5 (incident-driven, 20 = 10 weeks). Miner sets per-rule on proposal based on observed cadence; column on `skills` table. | `skills.shadow_to_active_threshold` |
| Active → demotion | 2 disagreements / 7 days | Conservative; one bad week reverts | `auto-rule-engine.ts` `DEMOTE_AT` |
| Override window | 24h | Matches existing reconciler pending TTL | `auto-rule-engine.ts` `OVERRIDE_WINDOW_H` |
| Override semantics | per-rule, `override_kind ∈ {rollback, corrective_task}` | Some auto-actions can't be rolled back at +24h (Finale write + Bill.com forward already propagated). Rule sets which path applies. | `action_jsonb.override_kind` |
| Weekly Haiku cost cap | $0.10 | Frugal default, ~10 candidates/week | `pattern-miner.ts` `WEEKLY_BUDGET_USD` |

If any of these feel wrong, adjust in code — none change the architecture.

## 9. Phased rollout

Sequenced to ship value early, defer cost.

| # | Phase | What | Est. LOC | Reversible |
|---|---|---|---|---|
| **2.5** | Layer 1 hygiene | `incrementOrCreate`, closeFinishedTasks cron, stuck-source meta-task, one-time backfill | ~250 | Drop new agent_task columns; revert cron |
| **3** | task_history extension | Already in original plan §3.2 — adds task_id + event_type, written by agent_task on every state transition. Becomes the observation log. | ~250 | Columns nullable |
| **A1** | Layer 2 proposal | Nightly pattern_mine job, `predicate_jsonb`/`action_jsonb` on skills, `/dashboard/rules` review-only page | ~400 | `RULE_PROPOSAL_ENABLED=false` |
| **A2** | Layer 3 shadow + active | trust_level state machine, predicate matcher, side-effect runner, `auto_rule_decision` ledger, Telegram digest extension | ~600 | `RULE_AUTO_EXEC_ENABLED=false` per-rule |
| **A3** | Layer 3 trusted + demotion alerts | "Promote to trusted" button, demotion alert pipeline, `/tasks --history`, outcome verification cron | ~200 | Per-flag |

Total new LOC: **~1,700**, on top of the ~1,300 already committed for the original plan. Each
phase ships standalone behind an env flag.

**Critical sequencing dependencies (hard, do not violate):**
- Layer 2 (A1) cannot mine until phase 3 (`task_history` extension with `task_id` + `event_type`)
  lands and at least 7 days of resolved tasks have been observed.
- Layer 3 (A2) cannot run shadow mode until layer 2 has produced ≥1 proposed rule that Will
  has approved.
- Layer 3's `trusted` state cannot exist until at least one rule has accumulated 20+ net
  agreements at `active` (≥3-4 weeks of real traffic for AP cadence).

**Recommended order:** `2.5` → `original phase 2` → `original phase 3` → `A1` → `A2` → `A3`.
Phase 2.5 should ship *before* the existing plan's phase 2 because hygiene is independent of
spoke writers, fixes the 38-stale-rows problem immediately, and the `incrementOrCreate` path
is what phase-2 spoke writers will call into anyway. If phase 2.5 lands first, phase 2 just
swaps `upsertFromSource` calls for `incrementOrCreate` calls — net change is one method name
per call site.

## 10. Risks

1. **Pattern miner over-fits a noisy month.** A vendor sends one anomalous batch and the rule
   gets proposed. **Mitigation:** Haiku gate requires `≥50 examples OR ≥30 days span`. Low-volume
   patterns wait until they accumulate.
2. **Outcome verification has gaps.** Some side-effects don't have a clean +24h check (e.g.,
   forwarded emails — Bill.com doesn't ack). **Mitigation:** rules whose action lacks a
   verifier cap at `active`, never reach `trusted`. Add a `verifier_kind` field to
   `action_jsonb`; missing → `null` → ineligible for promotion to trusted.
3. **Telegram digest noise vs. silent trusted mode tension.** If `trusted` rules are silent,
   how does Will catch slow drift? **Mitigation:** weekly meta-digest every Monday: "Last week,
   12 rules auto-handled 87 tasks. Top 3: …". Trusted rules surface in this rollup but not
   daily.
4. **Demotion thrashing.** A rule on the `shadow ↔ active` boundary could oscillate.
   **Mitigation:** enforce 14-day cooldown after demotion before any promotion path can fire.
5. **"Stuck source" meta-task itself becomes a source of noise.** If the watchdog bug isn't
   fixed, every 5-min cron tick re-creates the meta-task. **Mitigation:** the meta-task has its
   own input_hash on `(stuck_source_table, stuck_source_id_pattern)`, so it dedups too.
6. **Predicate operator drift.** `ilike: '%uline%'` matches `ULINE`, `ULINE-RTNS`,
   `Uline-via-ProcessUS` — a rule fit on Q1 vendor variants could silently match new ones added
   later. **Mitigation:** the miner stamps a `trained_match_distribution` on the rule (vendor
   histogram + amount bucket histogram from training data). At each promotion gate, compute the
   trailing 7-day match distribution and require Jaccard overlap ≥ 0.8 with the trained
   distribution. Drift below threshold blocks promotion and Telegram-alerts Will.
7. **Schema drift in `inputs` JSONB.** If a field is added to the `reconciliation_result` shape
   (or any other source's input shape), a rule's predicate referencing the old shape could
   silently never match (or worse, match wrongly because a new field's absence/null is treated
   as falsy). **Mitigation:** every spoke writer stamps `inputs._schema_version` (string, e.g.
   `"reconciler@v3"`); rule stores `trained_on_schema_version` at proposal time; a mismatch at
   match time → predicate skipped, rule auto-demoted to shadow with `demotion_reason='schema_drift'`,
   Telegram alert.
8. **First-rule chicken-and-egg.** The miner needs ≥30 days of `task_history` resolved rows to
   produce its first proposal, but phase 3 starts that table's clock at zero. **Mitigation:** the
   A1 PR includes a one-shot import that backfills `task_history` from the existing 6+ months of
   `ap_activity_log` decisions (resolved invoice approvals + dropship forwards), normalized into
   the `(task_id=NULL, agent_name='ap-agent', task_type='resolution_summary', event_type='resolved',
   execution_trace=…)` shape. Miner can run on day 1 of A1 with a real corpus.
9. **Stuck-source era pollutes early observation.** Layer 1 hygiene collapses 38 → 1+meta on day
   0; the miner reading `task_history` for the first 30 days of fresh data sees mostly the messy
   pre-hygiene past if not constrained. **Mitigation:** `pattern_mine` only considers
   `task_history` rows where `created_at > deployed_at(layer_1)` (the `agent_task` table's
   `created_at` of its first non-backfill row). Don't try to learn from the bug-disguised-as-load
   era.

## 11. Verification

- **Phase 2.5:** apply migration, run cron once, verify `SELECT count(*) FROM agent_task WHERE
  status IN ('PENDING','NEEDS_APPROVAL')` drops from 38 to ~2. The remaining rows include the
  new `stuck_source` meta-task plus the 1 `ap_pending_approval`.
- **Phase A1:** run pattern_mine manually against 30 days of seeded `task_history`. Confirm at
  least one candidate proposal appears in `skills` with `trust_level='proposed'`.
- **Phase A2:** approve one proposed rule. Process a real matching task (e.g., next ULINE
  invoice if ≤$500 / ≤3% diff). Confirm `auto_rule_decision` row appears with
  `trust_level_at_decision='shadow'` and `decision` matches what Will would have done. Override
  once via dashboard, confirm `disagree_count` increments.
- **Phase A3:** force-fail an outcome verifier (e.g., delete the Finale write before
  verifier runs). Confirm rule auto-demotes and Telegram alert fires.

## 12. Critical files

**New:**
- `supabase/migrations/20260501_hygiene_backfill.sql`
- `supabase/migrations/20260502_skills_trust_gradient.sql`
- `supabase/migrations/20260503_auto_rule_decision.sql`
- `src/lib/intelligence/agent-task-closure.ts` (closesWhen registry + cron)
- `src/lib/intelligence/workers/pattern-miner.ts` (nightshift worker)
- `src/lib/intelligence/auto-rule-engine.ts` (predicate matcher + state machine)
- `src/app/api/dashboard/rules/route.ts`
- `src/app/dashboard/rules/page.tsx`
- `src/components/dashboard/RulesPanel.tsx`

**Edited:**
- `src/lib/intelligence/agent-task.ts` — `incrementOrCreate`, `recordObservation` writes to
  `task_history`, `auto_handled_by` routing
- `src/lib/intelligence/ops-manager.ts` — register `closeFinishedTasks` cron, register
  `pattern_mine` nightly enqueue, register outcome-verifier cron
- `src/lib/intelligence/nightshift-agent.ts` — handle `pattern_mine` task_type
- `src/cli/start-bot.ts` — extend daily digest, add `/tasks history`, add demotion alerts
- `src/components/dashboard/TasksPanel.tsx` — auto-handled chip + filter toggle
- `.agents/plans/control-plane.md` — link to this spec, update phase ordering

## 13. First-rule sequencing (decision)

Ordered list of which auto-rules get wired first in A2. Decision is locked, not a question.

### First: dropship-forward (lowest risk, pure observability win)

Dropships are already 100% deterministic in `ap-agent.ts:60-86` — they auto-forward today
with no human approval. Wrapping that path in a rule **changes nothing operationally**; it
just makes the existing safe behavior observable + attributable through the rule engine
(`auto_handled_by` lineage, audit ledger, demotion if a forward fails). Outcome verifier is
clean (`gmail_send_with_label`). Failure mode is contained — an email goes wrong, no money
moves. Pure observability win, zero new risk surface. Use `shadow_to_active_threshold=15`.

### Second: ULINE small-invoice auto-approve (real value, real care needed)

Higher-value, real downside risk. The reconciler already auto-approves at ≤3% diff. The rule
pushes the gate to a tighter sub-zone: `vendor ilike '%uline%' AND amount <= $500 AND diff_pct
<= 0.03`. Train ONLY on already-auto-approved historical decisions so the training data is
pre-validated. Verifier is solid (`finale_write_then_billcom_label`). Use
`shadow_to_active_threshold=20`.

### NOT: control_command/restart_bot

**Explicitly excluded.** Auto-restart can mask real bugs — if `aria-bot` crashes from a code
error and a rule auto-restarts it 38 times, we lose the signal. Layer 1 hygiene already solves
the visible problem: the `closes_when: agent_boot_after` predicate auto-resolves the
watchdog's stale `restart_bot` tasks when a healthy heartbeat lands. No rule needed. Adding a
rule on top is double-handling for no value, with negative downside.

### Subsequent candidates (defer until first two have ≥30 days of clean operation)

- TeraGanix invoice forwarding (Shopify-source, deterministic)
- FedEx weekly billing reconcile alerts (failure-only dedup)
- AP statement-classification archive (no money path, low risk)

## 14. Open questions

None blocking. Tunable post-implementation:

- **Should `/dashboard/rules` allow manual rule authoring** (Will writes a predicate by hand,
  skips the proposal phase)? Punt to A3.
- **Multi-channel demotion alerts** (Slack #purchasing in addition to Telegram)? Punt — Telegram
  is the canonical Will channel.
