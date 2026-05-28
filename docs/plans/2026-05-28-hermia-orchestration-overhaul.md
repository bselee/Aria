# Hermia Orchestration Overhaul — Master Plan

> @file    2026-05-28-hermia-orchestration-overhaul.md
> @purpose Full-system hardening plan. Kill waste, add cognition, decompose monoliths.
> @author  Hermia + Will
> @created 2026-05-28
> @deps    aria-local.db, Supabase, Pinecone (to retire), all src/lib/intelligence/*

## Philosophy

Hermia (Hermes Agent, this session) IS the unified cognition layer.
OpsManager is a cron clock — reliable but dumb. Hermia owns:
- Strategic priority decisions (what matters right now)
- Cross-agent state awareness (what's failing, what's stale)
- Cron frequency tuning (reduce waste, increase signal)
- Memory architecture (kill Pinecone, go local-first)
- Monolith decomposition (testable, debuggable modules)

---

## Phase 1: Kill the Waste (Week 1)

### 1.1 Pinecone → Local SQLite Migration
**Goal:** Retire Pinecone. $70-250/mo savings. <1ms memory queries.

**Files to create:**
- `src/lib/storage/memory-store.ts` — SQLite vector store (sqlite-vss or manual cosine)
- `src/lib/storage/vendor-pattern-store.ts` — SQLite vendor pattern CRUD

**Files to modify:**
- `src/lib/intelligence/memory.ts` — swap Pinecone getIndex() → local store
- `src/lib/intelligence/vendor-memory.ts` — swap Pinecone getIndex() → local store
- `src/lib/intelligence/embedding.ts` — keep for embedding generation (still needed)
- `src/lib/memory/index.ts` — update facade dispatch
- `src/lib/intelligence/memory-layer-manager.ts` — update Pinecone refs

**Migration steps:**
1. Export all existing Pinecone vectors (aria-memory + vendor-memory namespaces)
2. Create SQLite tables with embedding column (1024d float32 blob)
3. Import exported vectors
4. Swap callers one module at a time, testing with `recall()` queries
5. Validate results match Pinecone (same top-K, same scores within 0.01)
6. Remove PINECONE_API_KEY from .env.local (keep for rollback for 1 week)
7. Remove `@pinecone-database/pinecone` from package.json

**Rollback:** Re-enable PINECONE_API_KEY, revert memory.ts + vendor-memory.ts

**Estimated work:** 4-6 hours

### 1.2 Cron Frequency Optimization
**Goal:** Reduce 864 daily invocations to ~400. Save LLM tokens and CPU.

**Changes in `src/cron/jobs/index.ts` (or ops-manager.ts registrations):**

| Job | Current | New | Rationale |
|-----|---------|-----|-----------|
| close-finished-tasks | 5 min | 15 min | Cleanup doesn't need 5-min urgency |
| issue-projection | 5 min | 15 min | Expensive, rarely finds new projections |
| issue-orchestrator | 5 min | 15 min | Gated on env var anyway |
| stat-indexing | hourly | 6-hourly | Pinecone/op-context index rarely changes |
| migration-tripwire | 30 min | hourly | Migrations don't happen every 30 min |
| task-self-healer | 10 min | 30 min | Self-heal backlog is rarely large |

**Estimated savings:** ~464 fewer invocations/day, ~$2-5/day token savings

### 1.3 Supervisor Deterministic Classification
**Goal:** Replace LLM error classification with regex rules. Save ~$0.05/day + 2-5s latency per error.

**File:** `src/lib/intelligence/supervisor-agent.ts`

**Rules:**
```typescript
function classifyError(agent: string, message: string, stack: string): "RETRY" | "ESCALATE" | "IGNORE" {
  // Network/transient → RETRY
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(message)) return "RETRY";
  if (/429|rate.?limit|quota|too many requests/i.test(message)) return "RETRY";
  if (/500|502|503|504|server error/i.test(message)) return "RETRY";
  if (/EAI_AGAIN|ENOTFOUND|DNS/i.test(message)) return "RETRY";
  
  // Expected/noisy → IGNORE
  if (/expired|invalid_grant|token.*expired/i.test(message)) return "IGNORE";
  if (/no.*gmail.*credentials|oauth.*not.*configured/i.test(message)) return "IGNORE";
  if (/cancelled|aborted/i.test(message)) return "IGNORE";
  
  // Logic/code errors → ESCALATE (need human)
  if (/TypeError|ReferenceError|undefined is not/i.test(message)) return "ESCALATE";
  if (/Cannot read propert/i.test(message)) return "ESCALATE";
  if (/null|undefined.*not.*object/i.test(message)) return "ESCALATE";
  
  // Unknown → ESCALATE (safe default)
  return "ESCALATE";
}
```

**Fallback:** If regex can't classify (no match), fall through to LLM for the first 3 occurrences, then cache the pattern. After that, deterministic.

### 1.4 stat-indexing Cron Removal
**Goal:** The hourly `indexOperationalContext()` cron calls `pinecone.ts` which is already
a Supabase shim writing to `email_context_log`. This is just an audit log — it doesn't
need hourly execution. Move to every 6 hours or remove the cron entirely and let the
AP pipeline call it on each processed email.

---

## Phase 2: Decompose Monoliths (Week 2)

### 2.1 AP Agent Decomposition (2428 → 6 modules)
**File:** `src/lib/intelligence/ap-agent.ts`

**Target modules:**
```
src/lib/intelligence/ap/
  ├── vendor-router.ts       — Deterministic VENDOR_ROUTING_RULES (autopay/dropship/ignore)
  ├── classifier.ts          — LLM classification (INVOICE/STATEMENT/AD/HUMAN_INTERACTION)
  ├── pdf-pipeline.ts        — PDF extraction (local → LLM fallback), retry logic
  ├── invoice-parser.ts      — (already exists at src/lib/pdf/invoice-parser.ts — wire in)
  ├── po-matcher.ts          — Finale PO matching (Fuse.js + direct query)
  ├── reconciliation.ts      — (already exists at src/lib/finale/reconciler.ts — wire in)
  ├── billcom-forwarder.ts   — Forward to buildasoilap@bill.com
  ├── dropship-handler.ts    — Dropship detection + forwarding + agent_task creation
  ├── retry-policy.ts        — OCR retry logic (currently inline in ap-agent.ts)
  └── index.ts               — Thin orchestrator that sequences the above
```

Each module: 200-400 lines, independently testable, clear input/output types.
The orchestrator (`index.ts`) is a ~100-line function that calls each step in sequence.

### 2.2 OpsManager Decomposition (1560 → 5 modules)
**File:** `src/lib/intelligence/ops-manager.ts`

**Target modules:**
```
src/lib/intelligence/ops/
  ├── scheduler.ts           — Cron registration + node-cron wiring (keep existing pattern)
  ├── email-cycle.ts         — runEmailPollingCycle orchestration (already mostly extracted)
  ├── summaries.ts           — Daily/weekly/build-risk summary generation
  ├── purchasing-watch.ts    — PO completion, receiving, calendar lifecycle watchers
  ├── tracking-watch.ts      — Tracking agent, build completion, shipment intelligence
  └── index.ts               — OpsManager class: constructor + lifecycle only
```

OpsManager becomes a thin shell that imports the above and wires cron → handler.

### 2.3 Finale Client Decomposition (6317 lines! — noted in STATUS.md)
**File:** `src/lib/finale/client.ts`

This is already flagged in STATUS.md. Plan:
```
src/lib/finale/
  ├── client.ts              — Core HTTP client, auth, rate limiting (keep)
  ├── products.ts            — (already exists — absorb more from client.ts)
  ├── purchasing.ts          — (already exists — absorb more)
  ├── receivings.ts          — (already exists — absorb more)
  ├── orders.ts              — PO CRUD, status mutations, adjustments
  ├── parties.ts             — Vendor/supplier resolution (resolveParty, etc.)
  └── graphql.ts             — GraphQL query builders (currently inline in client.ts)
```

---

## Phase 3: Cognitive Orchestrator (Week 3)

### 3.1 Cognitive Round System
**New file:** `src/lib/intelligence/cognitive-round.ts`

```typescript
interface CognitiveState {
  inboxDepth: { default: number; ap: number };
  pendingApprovals: number;
  cronFailures: { job: string; count: number; lastFailed: Date }[];
  agentHeartbeats: { agent: string; status: string; lastBeat: Date }[];
  poPipeline: { stage: string; count: number }[];
  trackingFollowups: number;
  timeContext: { hour: number; dayOfWeek: number; isBusinessHours: boolean };
}

interface CognitiveDecision {
  priority: "critical" | "high" | "medium" | "low";
  action: string;
  suppress: string[];  // Jobs to skip this round
  boost: string[];     // Jobs to run immediately
  summary: string;     // Human-readable "what I decided and why"
}

async function runCognitiveRound(): Promise<CognitiveDecision> {
  const state = await gatherState();
  
  // Rules engine (no LLM needed — this is deterministic)
  const decisions: CognitiveDecision[] = [];
  
  if (state.inboxDepth.ap > 10) {
    decisions.push({ priority: "critical", action: "AP inbox overload — prioritize email pipeline", suppress: ["stat-indexing", "housekeeping"], boost: ["ap-polling"], summary: "AP inbox has 10+ unprocessed emails" });
  }
  
  if (state.pendingApprovals > 5) {
    decisions.push({ priority: "high", action: "Resend approval reminders", boost: ["approval-reminder"], summary: "5+ pending approvals" });
  }
  
  if (state.cronFailures.length > 3) {
    decisions.push({ priority: "high", action: "Multiple cron failures — escalate", boost: ["supervisor-cycle"], summary: "3+ cron failures in backlog" });
  }
  
  if (!state.timeContext.isBusinessHours) {
    decisions.push({ priority: "low", action: "Night mode — suppress non-critical", suppress: ["daily-summary", "issue-projection"], summary: "Off-hours, quiet mode" });
  }
  
  return mergeDecisions(decisions);
}
```

### 3.2 Wire Cognitive Round into OpsManager
**File:** `src/lib/intelligence/ops/scheduler.ts` (post-decomposition)

Every 15 minutes, before running the email polling cycle:
1. Run `runCognitiveRound()`
2. Apply suppressions (skip low-priority crons)
3. Apply boosts (run high-priority immediately)
4. Log decision to `cognitive_rounds` table (Supabase)

### 3.3 Cognitive Round Dashboard
**New API route:** `src/app/api/dashboard/cognitive-rounds/route.ts`
**New dashboard panel:** Shows last 24h of cognitive decisions with rationale.

### 3.4 Night Mode / Business Hours Awareness
Add time-aware scheduling:
- **Business hours (7 AM - 6 PM MT):** Full polling, summaries, Slack posts
- **Extended hours (6 PM - 10 PM):** Nightshift enqueue, reduced polling
- **Quiet hours (10 PM - 7 AM):** AP polling only (invoices can't wait), everything else deferred

---

## Phase 4: Hardening (Week 4)

### 4.1 Agent Budget Enforcement
**File:** `src/lib/agents/budget.ts` (exists but not fully wired)

- Wire `agentId` into every `unifiedTextGeneration` / `unifiedObjectGeneration` call
- Set monthly caps per agent (AP: $30, Supervisor: $5, Nightshift: $10, etc.)
- Dashboard panel showing per-agent spend
- Alert Will when any agent hits 80% of cap

### 4.2 PM2 Crash Loop Protection
- Add `max_restarts: 20` (current: 10) 
- Add exponential backoff to `restart_delay` (5s → 10s → 20s → 40s → 60s cap)
- Add Telegram alert on 3rd consecutive restart within 5 minutes

### 4.3 Dropship Persistence
**Problem:** In-memory dropship store (48h TTL) lost on PM2 restart.
**Fix:** Persist to `agent_task` with type `dropship_pending` — already have the infrastructure.

### 4.4 AP Pipeline Idempotency Audit
- Trace every code path from inbox poll → email processed
- Verify `gmail_message_id` dedup is checked BEFORE any side effect
- Add test: process same email twice, second run must be a complete no-op

---

## Phase 5: Polish (Week 5+)

### 5.1 Local Memory Hot/Cold Tier
- Hot: SQLite (recent 30 days, fast queries)
- Cold: Supabase pgvector (all-time, durable backup)
- Sync job: every 6 hours, push new SQLite vectors to Supabase

### 5.2 Unified Memory Facade
- `src/lib/memory/index.ts` already exists as a facade
- Complete the migration — all callers use `memory.put/get/query`
- Remove direct imports of `pinecone.ts`, `memory.ts`, `vendor-memory.ts`

### 5.3 Observability
- Per-agent execution time metrics (SQLite table: `agent_metrics`)
- Per-cron cost tracking (Supabase table: `cron_cost_log`)
- Weekly cost report in daily summary email

### 5.4 Vendor Cycle Guard (existing PLAN.md)
- Implement the vendor-order-cycle guard from PLAN.md
- Tests: Grassroots/TeaLAB fragmentation patterns
- Wire into dashboard + Telegram

---

## Execution Order

```
Week 1: Phase 1 (Kill Waste) — highest ROI, lowest risk
  1.1 Cron frequency optimization     (30 min, zero risk)
  1.2 Supervisor deterministic rules   (1 hr, low risk)
  1.3 stat-indexing cron removal       (30 min, zero risk)
  1.4 Pinecone migration              (4-6 hr, medium risk)

Week 2: Phase 2 (Decompose Monoliths) — enables testing
  2.1 AP agent decomposition           (4 hr, low risk — pure refactor)
  2.2 OpsManager decomposition         (4 hr, low risk — pure refactor)
  2.3 Finale client decomposition      (6 hr, medium risk — large file)

Week 3: Phase 3 (Cognitive Orchestrator) — the "soul"
  3.1 Cognitive round system           (4 hr, new code)
  3.2 Wire into OpsManager            (2 hr, integration)
  3.3 Dashboard panel                  (2 hr, new UI)
  3.4 Night mode awareness            (2 hr, new code)

Week 4: Phase 4 (Hardening) — reliability
  4.1 Agent budget enforcement         (3 hr, wiring)
  4.2 PM2 crash loop protection        (1 hr, config)
  4.3 Dropship persistence            (2 hr, new code)
  4.4 AP idempotency audit            (3 hr, testing)
```

## Verification

After each phase:
1. `npm run ship:bot` — typecheck + restart
2. `npm run smoke:bot` — verify clean logs
3. Monitor PM2 for 1 hour post-deploy
4. Check Telegram for successful cron summaries

---

## Files Created/Modified Summary

### New Files
- `src/lib/storage/memory-store.ts`
- `src/lib/storage/vendor-pattern-store.ts`
- `src/lib/intelligence/cognitive-round.ts`
- `src/lib/intelligence/ap/vendor-router.ts`
- `src/lib/intelligence/ap/classifier.ts`
- `src/lib/intelligence/ap/pdf-pipeline.ts`
- `src/lib/intelligence/ap/po-matcher.ts`
- `src/lib/intelligence/ap/billcom-forwarder.ts`
- `src/lib/intelligence/ap/dropship-handler.ts`
- `src/lib/intelligence/ap/retry-policy.ts`
- `src/lib/intelligence/ap/index.ts`
- `src/lib/intelligence/ops/scheduler.ts`
- `src/lib/intelligence/ops/email-cycle.ts`
- `src/lib/intelligence/ops/summaries.ts`
- `src/lib/intelligence/ops/purchasing-watch.ts`
- `src/lib/intelligence/ops/tracking-watch.ts`
- `src/lib/intelligence/ops/index.ts`
- `src/lib/finale/orders.ts`
- `src/lib/finale/parties.ts`
- `src/lib/finale/graphql.ts`
- `src/app/api/dashboard/cognitive-rounds/route.ts`

### Modified Files
- `src/lib/intelligence/memory.ts` — Pinecone → SQLite
- `src/lib/intelligence/vendor-memory.ts` — Pinecone → SQLite
- `src/lib/intelligence/embedding.ts` — keep, no changes
- `src/lib/memory/index.ts` — update dispatch
- `src/lib/intelligence/supervisor-agent.ts` — deterministic classifier
- `src/lib/intelligence/ops-manager.ts` → thin shell
- `src/lib/intelligence/ap-agent.ts` → thin orchestrator
- `src/cron/jobs/index.ts` — frequency changes
- `ecosystem.config.cjs` — PM2 tuning
- `package.json` — remove Pinecone dep

### Deprecated/Removed
- `src/lib/intelligence/pinecone.ts` — already a shim, can remove
- `@pinecone-database/pinecone` — npm dependency (after migration verified)
