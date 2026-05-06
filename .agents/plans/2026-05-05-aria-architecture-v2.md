# Aria Architecture — v2 (with honest assessment)

> Supersedes `2026-05-05-aria-architecture.md`. Incorporates Will's reframe
> (2026-05-05): "seeking standardization any LLM could call on, understand,
> work with. Streamline, not waste tokens."
>
> This doc ends with a candid section called **What I'm not sure about** —
> read that first if you only have 5 minutes.

---

## 1. Goal (one paragraph)

Aria today is functional but the structure is *implicit*. Capabilities are
scattered across `lib/`, `cli/`, `app/api/`, and inline definitions in
`start-bot.ts`. The same verb ("classify this email", "draft this PO") has 2-3
different invocation surfaces with different shapes. We want to give Aria a
**named, typed, machine-discoverable surface** so that:

- Code is organized by ownership ("Purchasing owns this", "Lifecycle owns this")
- Each capability has *one* canonical entry point with a typed contract
- Schedules are declarative, observable, and on-demand-runnable
- An LLM (Claude Code, Cursor, future-Aria, an MCP client) can enumerate and
  call any capability without us writing tool wrappers each time
- Cross-cutting concerns (LLM caching, retries, budgets, observability) are
  *centralized* so individual callsites don't have to remember them

The kaizen punchlist already identified 4 cross-cutting waste patterns
(prompt caching, batch-then-loop, polling-vs-event, redundant LLM passes).
This skeleton is what makes those fixes structural rather than point-in-time.

---

## 2. Mental model

```
                 Conversation surface
   (Telegram bot · Dashboard chat · Claude Code · MCP client)
                          │
                          ▼
                   ┌─────────────┐
                   │   skills    │  typed verbs · one canonical impl per verb
                   │  registry   │  · MCP-shaped (JSON Schema)
                   └──────┬──────┘
                          │
                          ▼
                ┌──────────────────┐
                │      modules      │  capability boundaries (DDD bounded contexts)
                │  (the seven)      │  · purely re-export shims, no new logic
                └──────────────────┘
                          │
                          ▼
                ┌──────────────────┐
                │   lib (impl)     │  existing code, mostly unchanged
                │ infrastructure   │  · llm.ts · pdf · supabase · finale client
                └──────────────────┘

    Schedules layer (orthogonal):
                ┌──────────────────┐
                │   cron registry  │  defineJob({skill, schedule, budget, …})
                │   + tick runner  │  → /jobs Telegram command + run history
                └──────────────────┘
                          │ invokes
                          ▼
                       skills
```

Three new layers (`modules/`, `skills/`, `cron/`) on top of the existing `lib/`.
`lib/` is treated as infrastructure — none of its code moves.

---

## 3. The seven modules (capability boundaries)

These are **not** LLM agents. They're DDD bounded contexts. Each is one
directory with an `index.ts` that re-exports the public surface of one domain.

| Module | Owns | Skill prefix |
|---|---|---|
| `purchasing` | What to order, when, how much. Recommender, calibration, MOQs, reservations. | `purchasing.*` |
| `lifecycle` | A PO from drafted → sent → acked → shipped → tracked → received. ETAs, tracking, vendor profiles. | `lifecycle.*` |
| `accounts-payable` | Incoming invoice flow. Classify, forward to bill.com, dropship routing, reconcile to Finale PO. | `ap.*` |
| `vendor` | Vendor identity. Reconcilers (ULINE/FedEx/Axiom/TeraGanix), MOQ knowledge, lead-time history. | `vendor.*` |
| `manufacturing` | Calendar → BOM → build risk. Build completion detection. | `mfg.*` |
| `observability` | Supervisor, oversight, ledger, kaizen, agent_task hub, calibration retros. | `obs.*` |
| `conversation` | Telegram + dashboard chat. *Pure dispatcher to other modules.* | `conv.*` |

These mirror how Will already thinks about the business. Seven, not seventy.

---

## 4. The skill spec (MCP-compatible, but not MCP-required)

A skill is **the canonical typed verb** of the system. One definition, multiple
invocation surfaces.

```ts
// src/skills/registry.ts
import { z } from "zod";

export interface SkillDef<I, O> {
    name: string;                         // "purchasing.recommend_qty" (dotted, namespaced)
    description: string;                  // ONE sentence, ≤ 15 tokens
    input: z.ZodType<I>;
    output: z.ZodType<O>;
    handler: (input: I, ctx: SkillCtx) => Promise<O>;
    tags?: string[];                      // for UI filtering: "read" | "write" | "expensive" | …
    permissions?: SkillPermission[];      // e.g. "writes-finale", "sends-email", "uses-llm"
    budget?: { llmTokens?: number; finaleCalls?: number; durationMs?: number };
    confirmation?: "auto" | "soft" | "hard";  // soft = window.confirm, hard = telegram approval
}

export interface SkillCtx {
    invokedBy: "telegram" | "dashboard" | "cron" | "mcp" | "skill" | "cli";
    invokedAt: Date;
    correlationId: string;
    log: (msg: string) => void;
}

export function defineSkill<I, O>(def: SkillDef<I, O>): SkillDef<I, O>;
export function runSkill(name: string, input: unknown, ctx?: Partial<SkillCtx>): Promise<unknown>;
export function listSkills(filter?: { tag?: string; module?: string }): SkillSummary[];
export function getSkillJsonSchema(name: string): { input: object; output: object };
```

**Why MCP-shaped, even if we never expose MCP externally:**
- MCP requires JSON-Schema'd inputs/outputs. Zod → JSON Schema is one helper call.
- MCP requires tight descriptions (the spec literally caps tool descriptions at small lengths).
- MCP requires namespaced names (no collisions).
- These constraints are *all good discipline regardless of MCP*.

**What gets auto-derived from a skill def:**
1. TypeScript types (`z.infer<typeof input>`)
2. JSON Schema for inputs/outputs (via `zod-to-json-schema`)
3. OpenAI tool def for `start-bot.ts` (already JSON Schema)
4. Telegram inline command `/run <skill.name> {json}` (auto-registered)
5. Cron entry: `defineJob({ skill: "purchasing.recommend_qty", args: {...} })`
6. CLI: `tsx src/cli/skill.ts <skill.name> [args]`
7. (Optional, later) MCP server tool entry — single endpoint exposes all skills

**Token budget for the registry surface:**
~25 skills × (15-token description + ~80-token JSON Schema input) ≈ **2,400 tokens**
to expose Aria's full capability surface to any LLM. That's a fraction of a
single Sonnet system prompt today.

---

## 5. The cron framework

Today: 12 inline `cron.schedule()` calls in `ops-manager.ts`, each with bespoke
try/catch, no shared retry, no shared budget envelope, no observability.

Proposed:

```ts
// src/cron/registry.ts
defineJob({
    name: "qty-calibration",
    schedule: "30 8 * * *",              // standard cron expr
    tz: "America/Denver",
    skill: "obs.calibrate_recs",         // ← references a skill, doesn't define logic
    args: { daysBack: 30 },
    concurrency: 1,                      // never overlap with itself
    budget: { llmTokens: 0, finaleCalls: 60, durationMs: 90_000 },
    onFail: "escalate-to-supervisor",    // | "log" | "telegram-will" | "silent"
    dependsOn: ["nightshift-classify"],  // declarative dependency chain
    enabled: true,
});
```

What the framework provides for free:

| Feature | Saves |
|---|---|
| `/jobs` Telegram command | Visibility of all scheduled work in one place |
| Concurrency lock | "Never run two ticks of X simultaneously" — one config field |
| Budget envelope | If a job exceeds its budget, framework cancels + emits kaizen meta-task |
| `onFail` routing | No more bespoke try/catch in every handler |
| `dependsOn` | Declarative job dependencies (kills the redundant-Sonnet-pass pattern) |
| `cron_runs` history table | Every tick recorded for the dashboard heatmap |
| `/run <job-name>` parity | Every job is also a manual command — kills the "should this be a cron or a slash command" debate |
| `enabled: false` | Disable without removing code, visible via `/jobs` |

Implementation: `~150 LOC + bottleneck (NPM dep)`. We compose `node-cron`
(already a dep) for the scheduling and `bottleneck` (new dep, 6KB) for
concurrency/rate-limiting. Don't reinvent either primitive.

**Existing alternatives we considered:**
- **Inngest** — TypeScript SDK, hosted. Free tier sufficient. Gives the framework + a UI dashboard for free. Tradeoff: jobs run on their infra calling back to ours; loses the Telegram-first `/jobs` surface.
- **BullMQ** — Local + Redis. Adds Redis to the stack. Overkill.
- **Temporal / Trigger.dev** — Way overkill for 12 jobs.

**Recommendation:** bespoke registry + `bottleneck`. ~150 LOC isn't prohibitive,
keeps Telegram-native observability, no external service dependency.

---

## 6. MCP — make skills compatible, but don't expose the endpoint *yet*

This is the part where I want to push back on my own earlier suggestion.

**The pull toward MCP-now:** if every skill is MCP-shaped, then exposing
`/api/mcp` is one route handler away. Future Aria, Claude Code on Will's
laptop, Cursor in another project, etc. could enumerate and call Aria's
capabilities with no wrapper code.

**The honest pushback:** Will doesn't currently have an external LLM consumer
that needs to call Aria. Claude Code (me) accesses the codebase via
filesystem; Cursor likewise. The Telegram bot uses OpenAI internally with its
own tool format. There's no concrete "I want X to call Aria's reconcile-invoice
capability" use case today.

Building the **endpoint** without a consumer is speculative — exactly the kind
of thing Will's own memory ("don't design for hypothetical future requirements")
warns against.

**Compromise that costs nothing:**
- Make the skill registry MCP-*compatible in shape* (JSON Schema, tight
  descriptions, namespaced names). That's free discipline.
- *Don't* expose `/api/mcp` until a real consumer needs it. When one shows up
  (Will runs Claude Code in the project and wants `/mcp connect aria`, etc.),
  it's ~30 minutes of glue code to expose, since the registry is already MCP-shaped.

**Net effect:** we get the standardization benefit (any LLM that learns the
registry shape can use it) without the maintenance burden of a public endpoint
and its versioning.

---

## 7. How the kaizen punchlist lands inside this skeleton

| Punchlist item | Where it lives in the new shape |
|---|---|
| #1 Prompt caching central | `unifiedTextGeneration` in `lib/intelligence/llm.ts` (infrastructure) — every skill that calls LLM gets it for free |
| #2 Pre-warm vendor caches | Inside `purchasing.recommend_qty` skill handler — one place, fix once |
| #3 Honor nightshift pre-class | Declarative `dependsOn: ["nightshift-classify"]` in cron registry. No callsite logic. |
| #4 POSync 30m → 4h | One-line config edit in cron registry |
| #5 Fold POSweep into APPolling | Either merge skills, or `chains: ["po-sweep-postpass"]` |
| #6 Watchdog Mon-Fri | Cron expr edit `0 9 * * 1-5` |
| #7 Batch Supabase in active-purchases | Inside `lifecycle.load_active_purchases` skill |
| #8 PDF base64 cache | Central in `lib/pdf/extractor.ts` (infrastructure) — every PDF skill benefits |
| #9 backfillPOSentVerification batch | Inside `lifecycle.backfill_po_sent_verification` skill |
| #10 Merge pdf-pipeline agent into ap-pipeline | Falls out for free; PDF is infra, not a module |
| #11 Delete .agent/skills/firecrawl orphan | Hygiene |
| #12 DailySummary stub | Becomes `obs.morning_summary` skill, on cron + `/run obs.morning_summary` |

Most of the punchlist becomes either (a) a single edit in shared infrastructure
or (b) declarative config in the cron registry. The skeleton **is** the kaizen.

---

## 8. Phasing options (with honest cost estimates)

I want to give three real options, not pretend the medium one is the only viable shape.

### Option A — Just the kaizen, no skeleton (~1.5 days)

Skip modules/skills/cron framework. Land the 12 punchlist fixes as 12 small PRs
against existing code. Add a single shared helper for prompt caching in `llm.ts`.

**Pros:** ships the cost savings *this week*. Zero structural risk. Nothing new
to maintain.
**Cons:** doesn't address the structural cause of the kaizen patterns. Future
audits will find the same shapes of waste in new places. `start-bot.ts` stays
2500 lines. `ops-manager.ts` stays a try/catch jungle.

### Option B — Cron framework + kaizen, skip modules/skills (~2.5 days)

Build `src/cron/registry.ts` (~150 LOC + bottleneck dep). Migrate
`ops-manager.ts` jobs into it. Add `/jobs` Telegram command. Then land the
12 kaizen fixes (most become one-line config edits in the new registry).

**Pros:** the highest-leverage piece (cron framework) ships. Punchlist items
#3, #4, #5, #6, #12 become trivial. Bot and dashboard stay as-is for now.
**Cons:** doesn't give you the "any-LLM-can-discover" property. Skill
duplication across `start-bot.ts` / CLI / dashboard endpoints stays.

### Option C — Full skeleton + kaizen (~3-4 days)

All three new layers (`modules/`, `skills/`, `cron/`). MCP-shaped skill
registry. Migrate ~10 high-traffic skills (recommend-qty, classify-email,
draft-po, reconcile-invoice, sync-po-conversations, etc.) into the registry.
Land all 12 kaizen items inside the new structure.

**Pros:** the whole vision. One canonical entry per verb. Token efficiency
across the registry surface. Future external-LLM consumers (when they show up)
are 30 min of glue away. Future kaizen audits get cheaper.
**Cons:** biggest risk. Not all 25 skills will migrate cleanly on day one;
inevitably some will have ugly edge cases that take longer than expected. Most
of the value is realized only after migration is mostly complete (~2 weeks of
incidental skill migrations on top of Phase 1's bootstrap).

### My honest read

The 12 kaizen items are real. The cron framework pays back fast. The modules
+ skills layer is *correct in shape* but the value depends on actually
migrating skills into it consistently — which takes ongoing discipline, not a
one-time refactor.

**My recommendation: Option B.** Build the cron framework, ship the kaizen,
and *defer* modules + skills until either:
- An external LLM consumer becomes a real ask (then jump to MCP shape)
- Or `start-bot.ts` / CLI / dashboard duplication becomes the limiting factor
  in shipping new features (then build the skill registry to dedupe)

Today, neither is true. The bot works, the CLI scripts work, the dashboard
works. The waste is in **what we run on schedule** (cron) and **how we call
LLMs** (caching, dedup), not in the skill-vs-tool-vs-endpoint duplication.

Option C is the *right* destination but it's not the *right next step.*

---

## 9. What I'm not sure about

Honest list of where I have less confidence:

1. **Is the cron framework worth 150 LOC + a dep?** Maybe. If the answer is
   "every cron we have is ~3 lines and works fine" then it's overinvestment.
   The argument *for* is that the audits found 6 cron pathologies in 12 jobs —
   50% rate, structural, recurring. The framework prevents the structural
   recurrence. But this is a judgment call and I could be wrong.

2. **Will the modules layer stay disciplined?** Re-export shims rot easily —
   developers (and me, future-Claude) bypass them and import from `lib/`
   directly when convenient. Without lint enforcement, the layer becomes
   advisory. With enforcement (an ESLint rule banning deep imports outside
   the module's own directory), it stays clean. I haven't proposed the
   enforcement, which is a hole.

3. **MCP standardization vs YAGNI.** I keep flipping between "MCP-shape is free
   discipline" and "no external consumer exists." The compromise (MCP-shape
   without endpoint) is reasonable, but I might be rationalizing — Will's
   memory explicitly warns against speculative design. The honest cut might be
   "skip MCP framing entirely; design the registry for our needs and convert
   later if MCP becomes relevant."

4. **The 7-module split.** "Conversation" as a 7th module feels weak — it's a
   pure dispatcher with no logic of its own. Maybe that should just be the
   skill registry's invocation surfaces (Telegram, Dashboard, CLI, MCP) and
   not a "module" at all. Six modules with a clean dispatcher pattern might
   be cleaner than seven where the seventh is mostly empty.

5. **`.claude/agents/*.md` alignment.** Those exist for *me* (Claude Code) to
   work *on* Aria. They're a separate plane from Aria's runtime modules.
   They probably should *also* be slimmed/dedup'd (per Audit C), but that's a
   separate body of work from the runtime architecture. I haven't decided how
   to talk about both at once without confusion.

6. **Velocity vs. discipline tradeoff.** Three days of skeleton work means
   three days of *not* shipping operational features. The cost of that delay
   is real — Will is the only operator. If skeleton-3-days delays a feature
   that would save Will 30 min/day, the math is bad. I don't have visibility
   into what's queued operationally.

---

## 10. What I'd like from you before proceeding

1. **Pick A, B, or C** (or redirect — if B is right but you want a smaller cron framework, say so)
2. **Confirm or push back on my "skip MCP endpoint for now" position**
3. **Tell me if there's an operational backlog** I'm not seeing that should bump in front of architectural work
4. **Tell me if the 7-module list misses anything** — most importantly: am I missing a domain (Slack? Memory? Documents?)

I'd rather be told "no, just do A and stop overthinking" than build the wrong
thing for three days.
