# Aria — agents, skills, and the cron framework

> Drafted in response to "if you were to break Aria down into agents and skills, what would that look like — without being excessive?" plus "crons need framework and fixing." This is the architectural skeleton the kaizen punchlist should land inside, so the 12 fixes also reduce *future* kaizen surface instead of becoming 12 disconnected patches.

---

## Today's reality (mental model)

Aria is already organized along clear lines, but the boundaries aren't *named*. Code lives in `src/lib/{intelligence,purchasing,finale,gmail,pdf,reconciliation,...}` — that's an *implementation* taxonomy. There is no *operational* taxonomy that answers "who owns this," "what is this called when I want to invoke it on demand," or "what runs on a schedule and why."

The cost is visible in three places:
- **`start-bot.ts` is 2500+ lines** because every Telegram tool is defined inline next to every handler.
- **`ops-manager.ts` is one file with ~12 inline `cron.schedule()` calls**, each with bespoke try/catch noise, no shared retry, no shared budget, no consistent failure path.
- **The audits found ~50 waste findings that collapse to 4 cross-cutting patterns** — meaning we keep re-introducing the same shape of bug because no central abstraction makes the right thing easy.

The fix is structural, not point-by-point.

---

## Proposed shape — minimal, not excessive

### 7 agents (capability boundaries, not files)

Each agent owns a domain. Today's code largely respects these boundaries already; what's missing is a *named* surface.

| Agent | Owns | Existing files |
|---|---|---|
| **Purchasing** | What to order, when, how much. Recommender, calibration, MOQs, reservations. | `lib/purchasing/`, `lib/finale/client.ts → getPurchasingIntelligence` |
| **Lifecycle** | A PO from drafted → sent → acked → shipped → tracked → received. ETAs, tracking, vendor profiles. | `lib/purchasing/active-purchases.ts`, `lib/finale/lifecycle*`, `lib/tracking/` |
| **Accounts Payable** | Incoming invoice flow. Classify, forward to bill.com, dropship routing, reconcile to PO. | `lib/intelligence/ap-agent.ts`, `lib/intelligence/workers/`, `lib/finale/reconciler.ts` |
| **Vendor** | Vendor identity. Reconcilers (ULINE, FedEx, Axiom, TeraGanix), MOQ knowledge, lead-time history, communication patterns. | `cli/reconcile-*.ts`, `lib/storage/vendor-invoices.ts`, `lib/intelligence/vendor-memory.ts` |
| **Manufacturing** | Calendar → BOM → build risk. Build completion detection. | `lib/intelligence/build-parser.ts`, `lib/builds/`, `lib/google/calendar.ts` |
| **Observability** | Supervisor, oversight, ledger, kaizen, agent_task hub, calibration retros. | `lib/intelligence/{supervisor,oversight}-agent.ts`, `lib/intelligence/agent-task.ts`, `lib/purchasing/calibration-engine.ts` |
| **Conversation** | Telegram + Dashboard chat. Routing requests to the other 6 agents. *Not a domain — a thin facade.* | `cli/start-bot.ts`, `app/api/dashboard/chat/` |

That's it. Seven. No agent_for_each_table_in_supabase. The split mirrors how Will already thinks about the business.

### Skills (procedures, agent-invoked or user-invoked)

Skills are the *verbs* of the system. Each skill is a single function with a contract: takes a typed input, returns a typed result, has a budget, can be invoked from a Telegram tool, a dashboard button, a cron, or another skill. Today these exist as a mix of CLI scripts, ad-hoc functions, and OpenAI tool definitions — same logic, three different invocation surfaces.

A non-excessive skill catalog (~25, mapped to agents):

```
purchasing/
  recommend-qty          → reads stock+vel, returns recommendations
  draft-po               → creates Finale draft, stamps rec link
  send-po                → commits + emails vendor
  survey-moqs            → today's CLI
  snooze-vendor / unsnooze-vendor

lifecycle/
  sync-po-conversations  → walks Gmail label:PO, updates Supabase
  fetch-tracking         → carrier API per shipment
  detect-vendor-ack      → parses PO email replies
  backfill-po-sent-verification

accounts-payable/
  classify-email         → Haiku-first, Sonnet-fallback intent classifier
  forward-to-billcom     → queues + sends invoice forward
  reconcile-invoice      → invoice→PO matcher with guardrails
  approve-pending / reject-pending

vendor/
  reconcile-uline / -fedex / -axiom / -teraganix    (one entrypoint each)
  enrich-vendor          → web search + Firecrawl
  resolve-vendor-eta     → tracking → reply → median → default cascade

manufacturing/
  parse-build-calendar   → calendar event → builds[]
  assess-build-risk      → BOM × stock → CRITICAL/WARN/OK
  detect-build-completions

observability/
  calibrate-recs         → daily 8:30 AM (today's cron)
  recompute-vendor-stats
  summarize-aria-vs-finale
  cleanup-expired-reservations
  close-finished-tasks
  escalate-to-supervisor

conversation/
  (no skills — pure dispatcher to others)
```

Every Telegram bot tool collapses to a `dispatchSkill(name, args)`. Every cron entry collapses to a `runSkill(name)`. Every CLI script becomes `tsx src/cli/skill.ts <skill> [args]`. Three invocation surfaces, one definition.

### Pdf, Llm, Storage — these are *infrastructure*, not agents

`lib/pdf/`, `lib/intelligence/llm.ts`, `lib/supabase.ts`, `lib/finale/client.ts`, `lib/gmail/`, `lib/anthropic.ts` — none of these are agents. They're shared services. Skills compose them. This is already how the code works — we just need to stop treating "the LLM call" as a domain.

---

## The cron framework

Today: 12 inline `cron.schedule(expr, handler, opts)` calls in `ops-manager.ts`, each with bespoke try/catch, no shared retry, no shared budget, no `/jobs` command, no failure routing.

Proposed: a single `defineJob` registry + tick runner.

```ts
// lib/cron/registry.ts
defineJob({
  name: "qty-calibration",
  schedule: "30 8 * * *",
  tz: "America/Denver",
  skill: "observability/calibrate-recs",
  args: { daysBack: 30 },
  ownerAgent: "observability",
  concurrency: 1,                // never overlap with itself
  budget: { llm: 0, finale: 60, durationMs: 90_000 },
  onFail: "escalate-to-supervisor",
  enabled: true,
});

defineJob({
  name: "ap-polling",
  schedule: "*/15 * * * *",
  tz: "America/Denver",
  skill: "accounts-payable/poll-inbox",
  ownerAgent: "accounts-payable",
  concurrency: 1,
  budget: { llm: 50, finale: 0, durationMs: 120_000 },
  onFail: "log-and-continue",
  enabled: true,
});
```

What the framework gives you for free:

1. **`/jobs` Telegram command** — list every registered job with status, last run, next run, last result, failure count. Disable/enable inline.
2. **One unified place to see `enabled: false`** — no more guessing if `ISSUE_ORCHESTRATOR_ENABLED=true` is what gates anything.
3. **Concurrency lock** — "never run two `qty-calibration` ticks at once" is one config field, not a flag in every handler.
4. **Budget envelope** — if a job exceeds its budget, the framework cancels it and emits a kaizen meta-task.
5. **`onFail`** routing — `"escalate-to-supervisor"` writes to `agent_task` hub. `"log-and-continue"` logs warn. `"telegram-will"` pages immediately. No more bespoke try/catch.
6. **Job dependencies** — `defineJob({ ..., dependsOn: ["nightshift-classify"], runAfter: "08:00" })` lets you state "morning AP pass needs nightshift to have completed first" declaratively. Solves the redundant-Sonnet-pass kaizen item structurally.
7. **Observability built-in** — every tick writes to a `cron_runs` table with start/end/duration/status. Dashboard can render a heatmap.
8. **On-demand parity** — every job has a Telegram command auto-derived: `/run qty-calibration` triggers it now, with the same budget+concurrency rules.

This is ~200 LOC of framework + a one-time migration of `ops-manager.ts` to use it. After that, every kaizen finding about crons (#4, #5, #6 in the punchlist, plus several deferred items) becomes a single config edit, not a code change.

---

## How the kaizen punchlist maps onto this skeleton

| Punchlist item | Where it lives in the new shape |
|---|---|
| #1 Prompt caching in `llm.ts` | Infrastructure — the central `unifiedTextGeneration` already exists; add `cacheControl`. *Every* skill benefits without each remembering. |
| #2 Pre-warm vendor caches | Infrastructure — `leadTimeService` and `partyCache` are already shared. Tighten the loop pattern in `purchasing/recommend-qty` skill. |
| #3 Honor nightshift pre-class | Solved structurally by job dependencies in the cron framework: `ap-classify` job declares `dependsOn: ["nightshift-classify"]` and reads its output. No "remember to check getPreClassification" at the callsite. |
| #4 POSync 30m → 4h | One-line cron config edit. |
| #5 Fold POSweep into APPolling | Either (a) merge skills, or (b) `ap-polling` job has `chains: ["po-sweep-postpass"]`. Cron framework makes (b) natural. |
| #6 Watchdog Mon-Fri | Cron expr edit: `0 9 * * 1-5`. |
| #7 Batch Supabase in `active-purchases.ts` | Lives in `lifecycle/sync-po-conversations` skill — clean place to fix once. |
| #8 PDF base64 cache | Infrastructure — `pdf/extractor.ts` is already shared. Cache by file hash. Every skill that calls extract benefits. |
| #9 `backfillPOSentVerificationFromGmail` batch | Lives in `lifecycle/backfill-po-sent-verification` skill. |
| #10 Merge `pdf-pipeline` agent into `ap-pipeline` | This *is* the consolidation — `accounts-payable` agent owns the AP pipeline; PDF extraction is infrastructure. The `pdf-pipeline` agent goes away. |
| #11 Delete `.agent/skills/firecrawl/` orphan | Hygiene — does not survive the consolidation either way. |
| #12 DailySummary stub | Becomes `observability/morning-summary` skill, scheduled by cron framework, can also be invoked via `/summary` Telegram command. |

The architecture *is* the kaizen. Most of the punchlist becomes either (a) a single edit in shared infrastructure that fixes every callsite, or (b) declarative config in the cron registry.

---

## What this is *not*

- **Not a rewrite.** Every skill maps to existing code. The work is naming + extracting + thin facades, not new logic.
- **Not micro-services.** Single Node process, single Supabase, single Finale. "Agents" are just named capability boundaries with explicit owners.
- **Not a framework explosion.** The "cron framework" is ~200 LOC. The "skill registry" is a `Map<name, fn>` with a typed schema, not a dependency-injection container.
- **Not opinionated about transport.** Skills don't care if they're called from Telegram, dashboard, cron, CLI, or another skill. That's the point.

---

## Proposed phasing

### Phase 1 — frame the structure (1–2 days)
1. Create `src/agents/{purchasing,lifecycle,accounts-payable,vendor,manufacturing,observability,conversation}/index.ts` — each just re-exports current functions under named slots. No logic moves yet.
2. Create `src/skills/registry.ts` with a typed `defineSkill` + `runSkill`. Migrate ~5 highest-traffic skills (recommend-qty, classify-email, draft-po, reconcile-invoice, sync-po-conversations) into the registry.
3. Create `src/cron/registry.ts` with `defineJob` + tick runner. Migrate `ops-manager.ts` jobs one at a time. Add `/jobs` Telegram command.

### Phase 2 — kaizen fixes against the new skeleton (1 day)
4. Punchlist #1 (prompt caching central) — single edit in `llm.ts`.
5. Punchlist #2 + #7 (batch-then-loop + Promise.all) — inside `purchasing/recommend-qty` and `lifecycle/sync-po-conversations`.
6. Punchlist #3 — declared as job dependency in cron registry, not a callsite check.
7. Punchlist #4, #5, #6 — config edits in cron registry.
8. Punchlist #8 (PDF base64 cache) — central in `pdf/extractor.ts`.

### Phase 3 — catalog hygiene (half day)
9. Punchlist #10, #11, #12 + deferred items (vendor workflow flatten, etc.).
10. Update CLAUDE.md to point at the new agent boundaries.

### Phase 4 — earn back the slack (no ticket — observe)
11. Watch the `/jobs` dashboard for a week. Crons that never matter get `enabled: false`. Crons that fire often without producing anything become `/command` instead. The cron framework makes both decisions one-line.

Total budget: ~3 dev-days for Phases 1–3. Not 1.5 — this is bigger because we're paying down structure debt, not just patching. But every future kaizen audit gets cheaper.

---

## What I want to confirm before executing

1. **Is the agent split right?** Seven agents — Purchasing, Lifecycle, Accounts Payable, Vendor, Manufacturing, Observability, Conversation. Anything missing or merged wrong from your perspective?
2. **Is "Conversation" the right framing for Telegram + Dashboard chat?** Or do you see it as separate (Telegram = ops chat, Dashboard chat = analytical chat)?
3. **Do you want phases 1–3 in one big PR or three sequential PRs?** Sequential is safer (each rebases on a working main) but stretches the visible cost over a week. One PR is faster but riskier.
4. **Existing `.claude/agents/` directory** — do those subagent definitions get rewritten to match the seven domain agents, or do those stay as their current "Claude Code helper" character (different layer of the system from Aria's runtime agents)?

If those four are roughly right, I'd start Phase 1 step 1 (the agent re-export shims) immediately — it's pure addition, breaks nothing, and unblocks every later step.
