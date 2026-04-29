# Aria — State & Path Forward (2026-04-29)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` for the executable phases below. Steps use checkbox (`- [ ]`) syntax for tracking. **Read the entire State section before touching code.**

**Goal:** Lock down the post-Phase-2 state of Aria and define the smallest path to make the system *feel* like an agentic operations company control plane (Paperclip-shaped) on a load-bearing kernel (AIOS-shaped). Stop adding new concepts; migrate existing primitives to be load-bearing; merge the in-flight branches; THEN consider new schema.

**Architecture:**

```
Paperclip   ── operational surface — issues with goals, blockers, work products,
                governance pipeline, per-agent budgets, activity audit, org chart UI
   ⇕
AIOS        ── kernel — Tool Registry · Memory Manager · Scheduler · Storage Manager
                · Permission Gates (load-bearing, every external call routes through it)
   ⇕
Aria today  ── agent_task hub · agent_issue ledger · task_history · 12 ops panels ·
                cron-registry · self-heal A/B/C · 5 vendor reconcilers · heartbeats
```

The foundation is real. The cutover is what's missing.

**Tech Stack:** Next.js 15, TypeScript, Supabase (Postgres), Telegraf, Vitest, existing `command-board` + `agent-task` + `agent-issue` + `cron-registry` + `OpsManager` + `playbooks` infrastructure.

---

## Non-Negotiable Guardrails

- **Stop adding new concepts.** Tool Registry, Memory Manager, Scheduler scaffolding all exist. Migrate existing call-sites through them; don't build a 5th abstraction.
- **No new schema until existing JSONB outputs prove insufficient.** `agent_task.outputs`, `reconciliation_runs`, `documents`, `vendor_invoices` already act as work products. Promote them in the UI before adding `work_product` table.
- **Branches first, code second.** 6 PR-ready branches contain ~13K LOC of unmerged real work. Land them before starting any new feature.
- **`blocked` is reserved for true exhaustion.** Inherited from Phase 1. Projection cron must NOT mark issues blocked just because a task is FAILED.
- **All hub writes are best-effort.** Inherited from agent-task.ts. A ledger failure must never block the spoke action.
- **Every kernel call is audited.** `withToolAudit` must wrap every external API call once a subsystem is migrated. Per-call cost + duration + agent attribution lands in `task_history`.
- **Telegram is the daily driver.** Dashboard is forensic — designed to drill in when something looks wrong, not to be a primary surface.

---

## State Inventory (2026-04-29)

### Shipped on `main` and live in production

| Layer | Implementation | Where |
|---|---|---|
| Control plane | `agent_task` hub w/ dedup, closure predicates, 14 migrations | `20260428_create_agent_task.sql` + follow-ons |
| Issue ledger | `agent_issue` w/ lifecycle/blockers/handoffs/projection (Phase 1) | `20260509_create_agent_issue.sql` |
| Issue ledger Phase 2 | AP pipeline writes issues directly; dashboard approve/dismiss/rematch wired | today's branch `feature/agentic-issue-lifecycle-phase1` |
| Self-heal | Layers A (tripwires) + B (`playbook_kind/state`) + C (autonomous runner) | `20260507_*`, `20260508_*`, `playbooks/` module |
| Vendor reconcilers | 5 reconcilers (ULINE, Axiom, TeraGanix, FedEx, AAA) two-phase ChangeSet validation + idempotency gate | recent feat commits |
| Heartbeats | Per-agent staleness reporting | `20260417_create_agent_heartbeats.sql` |
| Skills (DB) | DB-backed catalog | `20260417_create_skills.sql` |
| Memories | Pinecone + DB recall | `20260421_create_memories.sql` + `pinecone.ts` |
| Reconciliation runs | Per-run audit log | `20260423_reconciliation_runs.sql` |
| FedEx Invoice API | Replaces CSV scraping | `feat(fedex): add FedEx Invoice API client` |
| Telegram surface | `/issues`, `/blockers`, `/issue <id>`, `/tasks`, `/crons`, 13 BotFather-registered commands | `start-bot.ts` |
| Dashboard | Module-tab full-canvas layout (today). 12 ops panels accessible. | `command-board/CommandBoardShell.tsx` |
| Tool Registry (scaffold) | Typed registry + `withToolAudit` + `/api/command-board/tools`. **NOTHING ROUTES THROUGH IT YET.** | `src/lib/agents/tool-registry.ts` |

### In-flight on origin (PR-ready, awaiting review)

| Branch | LOC | Risk | Verdict |
|---|---:|---|---|
| `feature/slack-request-tracking` | +3129 | High conflict | Land first — Finale write hardening + AP recon surgical updates |
| `po-lifecycle-evidence` | +1950 | High conflict | Land second — PO lifecycle evidence chain |
| `feature/bill-selee-email-overwatch` | +1628 | Low conflict | Land third — net-new outbox monitor agent |
| `feature/uline-friday-flow` | +2153 | Medium conflict | Review for merge — Stagehand+BrowserManager hybrid |
| `feature/purchasing-data-fixes` | +1104 | Medium conflict | Review for merge — line-aware multi-line PO receipts |
| `feature/build-demand-oracle` | +700 | High (cherry-pick failed) | Cherry-pick by hand or close |

### Deleted in cleanup pass

13 branches (7 already merged, 4 superseded duplicates, 1 prototype, 1 stale refactor).

### Not built yet

- Per-agent USD/token budget enforcement (LLM tier routing exists, no hard-stop)
- Memory Manager facade (4 fragmented patterns: Pinecone direct, vendor-memory, kaizen, dropship-store)
- Scheduler dispatch w/ budget gates (each cron calls its own logic)
- Multi-stage governance pipeline (current: 1-stage approve/reject)
- Goal/project hierarchy
- Per-issue cost-to-date

---

## Scope

**In scope (this plan):**

- Phase 1 — Land the 6 PR-ready branches (or formally close them). No new code.
- Phase 2 — Make the Tool Registry load-bearing for the AP pipeline. Migration only; no new tools.
- Phase 3 — Memory Manager facade. Collapse 4 patterns into 1. Migrate AP pipeline first.
- Phase 4 — Per-agent budget enforcement. Small schema add + LLM tier routing wire-up.

**Out of scope:**

- New schema for goals/projects/work-products until JSONB outputs prove inadequate.
- Dashboard redesign beyond today's tab cutover.
- Heartbeat queue rewrite (Paperclip's wakeup-queue pattern). Crons work; revisit only after budgets exist.
- Multi-stage governance — single-stage approve/reject covers AP and dashboard today.

---

## Preflight

```bash
# Confirm we're on the post-cutover branch with all of today's work.
git log --oneline -1                # expect: 23f28fb or later

# Confirm bot is healthy.
pm2 status aria-bot                 # expect: online, recent uptime

# Confirm DATABASE_URL works.
node -e "require('dotenv').config({path:'.env.local'}); console.log(Boolean(process.env.DATABASE_URL))"

# Confirm dashboard boots clean.
NODE_OPTIONS='--max-old-space-size=12288 --dns-result-order=ipv4first' npx next dev -p 3001
# Expect: Ready in <15s
```

All four green before starting any phase.

---

## File Structure

| Path | Responsibility |
|---|---|
| (Phase 1) | Branch merges happen via GitHub PR review. No new files. |
| `src/lib/agents/tool-registry.ts` | (Phase 2) Already exists. Add per-call audit context to migrated callers. |
| `src/lib/intelligence/ap-agent.ts` | (Phase 2) Wrap every Finale/Gmail/Pinecone call with `withToolAudit`. |
| `src/lib/finale/reconciler.ts` | (Phase 2) Wrap every Finale write with `withToolAudit`. |
| `src/lib/memory/index.ts` | (Phase 3) NEW — Memory Manager facade `memory.{put,get,query}(namespace, …)`. |
| `src/lib/memory/types.ts` | (Phase 3) NEW — types + namespaces enum. |
| `src/lib/memory/index.test.ts` | (Phase 3) NEW — unit tests. |
| `supabase/migrations/20260510_create_agent_budget.sql` | (Phase 4) NEW — `agent_budget` table. |
| `src/lib/agents/budget.ts` | (Phase 4) NEW — `checkBudget(agent)` + `chargeBudget(agent, usd)` helpers. |
| `src/lib/intelligence/llm.ts` | (Phase 4) Hook `chargeBudget` into the unified generation path. |

---

## Phase 1: Land the in-flight work (highest priority)

**Goal:** Reduce drift before adding anything new. Each PR review is independent.

### Task 1.1 — Land `feature/slack-request-tracking` (Finale write hardening + AP recon surgical)

- [ ] **Step 1.1.1:** Open PR: `gh pr create --base main --head feature/slack-request-tracking --title "feat: Finale write hardening + AP reconciliation surgical updates"`
- [ ] **Step 1.1.2:** Conflict resolution against today's `feature/agentic-issue-lifecycle-phase1` work — focus on `reconciler.ts` and `client.ts` overlap.
- [ ] **Step 1.1.3:** Verify the branch's `write-access.ts` gate doesn't break the dashboard purchasing flow (`/api/dashboard/purchasing/commit/route.ts` is the only allowed write path).
- [ ] **Step 1.1.4:** Run `npm run typecheck:cli && npm test -- src/lib/finale/`. Both green.
- [ ] **Step 1.1.5:** Merge.

### Task 1.2 — Land `po-lifecycle-evidence` (PO lifecycle chain)

- [ ] **Step 1.2.1:** Rebase onto main. Heavy conflict on `ops-manager.ts`, `tracking-agent.test.ts`, `calendar-lifecycle.ts`.
- [ ] **Step 1.2.2:** The branch's `PurchasingCalendarStatus` enum must merge with current calendar logic, not replace.
- [ ] **Step 1.2.3:** Open PR. Acceptance: PO lifecycle stage visible in `ActivePurchasesPanel` and `PurchasingCalendarPanel`.
- [ ] **Step 1.2.4:** Merge.

### Task 1.3 — Land `feature/bill-selee-email-overwatch` (outbox-monitor agent)

- [ ] **Step 1.3.1:** Rebase onto main. Net-new files (`email-overwatch-agent.ts`, `email_overwatch_threads` migration); only minor conflicts on `ops-manager.ts` + `cron-registry.ts`.
- [ ] **Step 1.3.2:** Verify the 9-state lifecycle (`po_sent_waiting_for_reply` → `closed_confident`) doesn't duplicate today's `agent_issue` lifecycle. They're complementary (outbox vs inbox).
- [ ] **Step 1.3.3:** Migration applied via `_run_migration.js`.
- [ ] **Step 1.3.4:** Merge.

### Task 1.4 — Review and decide `feature/uline-friday-flow`, `feature/purchasing-data-fixes`, `feature/build-demand-oracle`

- [ ] **Step 1.4.1:** For each branch, read the diff against main; either rebase + merge or close with a note in the PR.
- [ ] **Step 1.4.2:** `feature/build-demand-oracle` cherry-pick attempt failed in this session — Will should rebase manually or close.

**Acceptance for Phase 1:** Origin has main + the current Phase-2 branch + at most 1 in-flight branch. All others merged or closed.

---

## Phase 2: Tool Registry becomes load-bearing for AP pipeline

**Goal:** Every external call in the AP pipeline routes through the registry with audit + cost attribution. Pattern proven on one subsystem before expanding.

### Task 2.1 — Migrate AP pipeline Finale calls

- [ ] **Step 2.1.1:** Audit all `FinaleClient` instantiations + method calls in `src/lib/intelligence/ap-agent.ts` and `src/lib/finale/reconciler.ts`.
- [ ] **Step 2.1.2:** Register each Finale method used by AP as a tool: `finale_lookup_product`, `finale_get_order_summary`, `finale_update_order_item_price`, `finale_add_order_adjustment`, `finale_update_order_status`. Categories: `finale`. Scope: mostly `read` except the three writes which are `write` with `agentScope: ["ap-reconciler"]`.
- [ ] **Step 2.1.3:** Replace direct calls with `withToolAudit("tool_name", ctx, args, () => finaleClient.method(...))` where `ctx = { agent: HANDLER.AP_RECONCILER, issueId }`.
- [ ] **Step 2.1.4:** Verify `task_history` rows now appear with `event_type='tool_call'` and `task_type='tool_call'` after each AP poll cycle.
- [ ] **Step 2.1.5:** Add to `/api/command-board/issues/[id]` detail response: tool-call count + total duration so the issue timeline shows "AP-Reconciler called lookup_product 3 times (842ms)".

### Task 2.2 — Migrate Gmail calls

- [ ] **Step 2.2.1:** Same pattern for `gmail.users.messages.list/get/modify` in `ap-agent.ts`.
- [ ] **Step 2.2.2:** Register: `gmail_search`, `gmail_get_message`, `gmail_modify_labels`, `gmail_send`. All scope `read` except `gmail_modify_labels` (`write`) and `gmail_send` (`write` with strict agent scope).

### Task 2.3 — Tests

- [ ] **Step 2.3.1:** Update `ap-agent.test.ts` to mock through the registry.
- [ ] **Step 2.3.2:** Add a test that asserts every external call in a single AP poll cycle produces an audit row.

**Acceptance for Phase 2:** Single AP poll cycle generates 5–15 audit rows in `task_history`. Issue timeline shows tool-call line items.

---

## Phase 3: Memory Manager facade

**Goal:** Collapse 4 fragmented memory patterns (Pinecone direct, vendor-memory, kaizen, dropship-store) into one API. Backward compatibility — old call sites keep working until migrated.

### Task 3.1 — Build the facade

- [ ] **Step 3.1.1:** Write `src/lib/memory/index.ts` with `memory.put(namespace, key, value, opts?)`, `memory.get(namespace, key)`, `memory.query(namespace, text, opts?)`. Namespaces: `aria-memory`, `vendor-memory`, `kaizen-memory`, `dropship-memory`, `email-context`.
- [ ] **Step 3.1.2:** Backend dispatches per-namespace to existing implementations under the hood. No data migration.
- [ ] **Step 3.1.3:** Tests with mocked Pinecone client.

### Task 3.2 — Migrate AP pipeline calls

- [ ] **Step 3.2.1:** `ap-agent.ts` `recall(...)` calls → `memory.query("aria-memory", ...)`.
- [ ] **Step 3.2.2:** `reconciler.ts` `remember(...)` calls → `memory.put("aria-memory", ...)`.
- [ ] **Step 3.2.3:** `vendor-memory.ts` callers in AP path → `memory.{get,put}("vendor-memory", ...)`.

### Task 3.3 — Audit

- [ ] **Step 3.3.1:** Wrap memory calls with `withToolAudit` (same as Phase 2 pattern). Memory ops are tools too.

**Acceptance for Phase 3:** AP pipeline imports only `memory` from `@/lib/memory` — no direct `pinecone`, `vendor-memory`, or `kaizen` imports remain in `ap-agent.ts` / `reconciler.ts`.

---

## Phase 4: Per-agent budget enforcement

**Goal:** Each agent has a monthly USD cap. Exceeding pauses the agent's LLM calls until next billing cycle.

### Task 4.1 — Schema

- [ ] **Step 4.1.1:** Migration: `agent_budget` table with `agent_id`, `monthly_usd_cap`, `monthly_token_cap`, `current_period_start`, `current_period_usd_spent`, `current_period_tokens_spent`, `paused_until`. Backfill defaults.
- [ ] **Step 4.1.2:** Apply via `_run_migration.js`.

### Task 4.2 — Library

- [ ] **Step 4.2.1:** `src/lib/agents/budget.ts` with `checkBudget(agentId): Promise<{allowed: boolean, reason?: string}>` and `chargeBudget(agentId, usd, tokens, model)`.
- [ ] **Step 4.2.2:** Period roll-over logic (calendar month).
- [ ] **Step 4.2.3:** Tests.

### Task 4.3 — Wire into LLM tier routing

- [ ] **Step 4.3.1:** `src/lib/intelligence/llm.ts` `unifiedTextGeneration` / `unifiedObjectGeneration` accept an `agentId` parameter. Before each call, `await checkBudget(agentId)`. After successful call, `chargeBudget(agentId, usd, tokens, model)`.
- [ ] **Step 4.3.2:** Migrate all callers to pass an `agentId`. Default to `"unspecified"` for un-migrated paths so nothing breaks.
- [ ] **Step 4.3.3:** When budget hits, throw a typed `BudgetExceededError` that callers catch and gracefully degrade (skip non-essential LLM steps, use cached responses, etc.).

### Task 4.4 — Surface in dashboard

- [ ] **Step 4.4.1:** Add per-agent budget bars to the `/api/command-board/agents` response (current_period_usd_spent / monthly_usd_cap).
- [ ] **Step 4.4.2:** When you eventually add the agent rail back to the dashboard, this is what justifies it.

**Acceptance for Phase 4:** Hitting an agent's budget cap pauses its LLM calls. Visible in `agent_budget` table and via the agents API.

---

## What Phase 5+ might look like (NOT scoped here)

- Multi-stage governance pipeline on `agent_task` (review → approve → execute) for high-risk writes.
- `work_product` table once JSONB outputs prove insufficient.
- `goal` / `project` hierarchy if BuildASoil grows to multi-business operations.
- Heartbeat wakeup-queue rewrite (Paperclip pattern).
- Dashboard redesign with org chart + budget bars + per-agent drill-in.

These are reconsidered after Phases 1–4 land. Don't scope them now.

---

## Decision Log

- **2026-04-29:** Branch cleanup pass — 16 origin branches → 9. Deleted 13 (merged or dead). Committed `chore: gitignore local noise (SQLite WAL + dev-server logs)` (`1dbbb80`). Untracked `aria-local.db-*` from git tracking (`23f28fb`).
- **2026-04-29:** Dashboard cutover from 3-column grid + bottom dock → top-tab full-canvas layout (`eb8a99a` then `31de1c5`). Right-rail killed.
- **2026-04-29:** AIOS-borrowed Tool Registry scaffold landed (`bb8cca6`). NOT load-bearing — Phase 2 of this plan migrates AP pipeline through it.
- **2026-04-29:** Phase 2 of agentic issue lifecycle wired (`0401c33` → `8db1e43` → `7772c66` → `a75daa9` → `033695f`). Issue ledger now has direct AP writes.
- **2026-04-28:** Phase 1 of agentic issue lifecycle merged via PR #10 (covers `agent_issue` table, projection cron, `/issues` Telegram).

---

**For future-me reading this:** if a new feature is being scoped, check this doc first. The answer is probably "land the in-flight branches and migrate the existing primitive through the kernel before adding anything new."
