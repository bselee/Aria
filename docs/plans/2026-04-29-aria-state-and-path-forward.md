# Aria — Current State as of merge `b16a60a` (2026-04-29 → 30)

> **Reference doc, not a plan.** This file used to be a forward-looking 4-phase plan written BEFORE Phases 2–4 landed. It now describes what's actually merged on `main` and what's still open. Update it when major work lands; otherwise let it serve as the canonical "where Aria stands" reference.

**Last merge:** `b16a60a` (Merge `feature/agentic-issue-lifecycle-phase1` → `main`) on 2026-04-29.
**Stabilization commit:** `ba4d9a7` (working-tree triage, hygiene).
**Bot rev:** PID changes per restart; `pm2 status aria-bot` for current.

---

## What's now load-bearing on `main`

### Issue Ledger (Plan D Phase 1 + Phase 2)

`agent_issue` table is the parent operational unit. Tasks are steps under issues via `agent_task.issue_id`.

- **Lifecycle:** `detected | triaging | working | waiting_external | blocked | complete`
- **Autonomy:** `working | waiting | retrying | resolved | needs_policy`
- **Blocker enum (13):** missing_receipt · po_not_found · vendor_mismatch · extraction_failed · policy_required · external_pending · duplicate_or_conflict · source_unavailable · auth_required · data_integrity_error · retry_exhausted · human_approval_required · unknown
- **Lib:** `src/lib/intelligence/agent-issue.ts` — `createOrAdvance`, `recordHandoff`, `setBlocker`, `clearBlocker`, `complete`, `linkTask`, `getById`, `getBySource`, `getByBusinessFlowKey`, `getCurrentlyHandlingCounts`, `findLinkedOpenTask`, `listIssues`.
- **Producers writing directly to issues:** AP-pipeline (`reconcileAndUpdate` per verdict; `storePendingApproval`; dropship FAILED), `task-actions.ts` cross-cutting linked-issue resolver (closing a task closes the issue too), dashboard reconciliation-action route.
- **Projection cron** still runs as a backstop for legacy paths that haven't been migrated to direct issue writes.
- **Behavioral guardrail:** `blocked` is reserved for explicit `setBlocker()` calls — projection NEVER sets blocked from FAILED status alone.

### AIOS-borrowed kernel

- **Tool Registry** (`src/lib/agents/tool-registry.ts`) — typed `RegisteredTool` + `withToolAudit(name, ctx, args, fn)` + permission gates by `agentScope`. Catalog at `GET /api/command-board/tools`.
- **Registered tools (28 across 6 categories — verified by 2026-04-30 smoke):** build (1), finale (11), gmail (7), memory (4), scraping (1), supabase (4). Finale + gmail writes scoped to specific agents.
- **Memory Manager facade** (`src/lib/memory/index.ts`) — `memory.{put,get,query}(namespace, ...)` collapsing 4 backends (aria-memory, vendor-memory, kaizen-memory, dropship-memory). AP path migrated.
- **Per-agent budgets** (`agent_budget` table; `src/lib/agents/budget.ts`) — `assertBudget(agent)` before LLM call; `chargeBudget` after. Calendar-month rollover. 14 agents seeded with caps. `unifiedTextGeneration` + `unifiedObjectGeneration` accept optional `agentId`.
- **Audit:** every wrapped call writes `task_history` with `event_type='tool_call'`, agent, args summary, duration, success/failure.
- **Coverage caveat:** Phase 2 migrated AP-pipeline Finale write path + the bill.com forward Gmail send. **Other call sites (most of `ap-agent.ts` Gmail calls, all reconciler scripts in `src/cli/reconcile-*.ts`, copilot core, dashboard routes) still call APIs directly.** This is intentional — migration is incremental. See "Open migration debt" below.

### Telegram surface

- `/issues` — blocking-first list with inline ✅ Approve / ❌ Reject / ✓ Resolve / 🔍 Detail buttons.
- `/blockers` — blocked subset.
- `/issue <id>` — detail timeline, linked tasks, blocker reason, next action.
- `/tasks` — task hub (approval surface preserved for muscle memory).
- BotFather command list published at boot — autocomplete dropdown.
- Issue-action handlers route through `findLinkedOpenTask` → `approveTask` (so AP-source flows hit reconciler) or directly via `clearBlocker`+`complete` for blocked-non-approval issues.

### Dashboard

- Module-tab shell: **Blocking Me** (default IssuesPanel) · AP · Receivings · Ordering · Tracking · Build Risk · Build Schedule · Statement Recon · Active POs · Tasks · Oversight · Activity.
- All 12 ops panels render full-canvas; tabs stay mounted after first visit (instant switching once JIT compile lands).
- Right rail killed (agent tree was display-only — didn't earn the space).
- `POST /api/command-board/issues/[id]/actions` — issue-level approve/reject/resolve.
- **Status:** dashboard is **forensic only** — Will reports it occasionally crashes Chrome under heavy use. Do NOT promote it back to operational primary until profiled in isolation.

### Paid-invoice pipeline (`default-inbox-invoice.ts`)

- Multi-strategy PO correlation: `exact → sku-overlap → amount-proximity → vendor-recent → create-draft`.
- `resolveFinalePo` shared helper — parens / digits-only / adjacent-digit-swap variants + vendor-name disambiguation.
- `correlatePo` returns `{orderId, strategy, confidence, note, candidate}`.
- `FinaleClient.listRecentPosByVendor` for vendor-name-fuzzy correlation.
- No-PO# early gate REMOVED. Haiku always runs. Job Name field added to schema + prompt.
- Axiom-aware enrichment: post-Haiku, when fromEmail/vendorName matches Axiom, fills `finaleSku` from the static `AXIOM_TO_FINALE` map.
- Telegram alerts on every non-exact correlation ("🔍 Fallback Correlation Used") so Will can audit before changes apply.

### Self-heal (Layers A/B/C)

Pre-existing on main; Layer A tripwires + Layer B `playbook_kind/state` + Layer C autonomous playbook runner. No changes in this batch.

### Reconcilers

Pre-existing two-phase ChangeSet validation + idempotency gate via `lookupVendorInvoices` for ULINE / Axiom / TeraGanix / FedEx / AAA. FedEx Invoice API client replaces CSV scraping. No changes in this batch.

---

## Migrations live on production DB

| Migration | What it adds |
|---|---|
| `20260509_create_agent_issue.sql` | `agent_issue` table + `agent_task.issue_id` FK + `task_history.issue_id` |
| `20260509b_task_history_issue_cascade.sql` | FK cascade so deleting an issue removes its events cleanly |
| `20260510_create_agent_budget.sql` | Per-agent monthly USD/token caps + period rollover + 14 seeded agents |

All three are additive — rollback drops the new artifacts without touching existing data.

---

## Open migration debt (NOT shipped — known + accepted)

These are deliberate scope cuts. Don't treat any of them as broken; they're the natural expansion path.

- **`ap-agent.ts` inline PO resolution (lines ~1100-1190)** still has its own copy of resolver logic. Should call shared `resolveFinalePo` to prevent drift. Low risk because both implementations work; high value to dedupe.
- **LLM call-site `agentId` threading.** `unifiedTextGeneration` + `unifiedObjectGeneration` accept an optional `agentId` for budget gating + cost tracking. As of merge, NO call sites pass it — `agent_budget` shows $0.00 spent for all 14 agents because the gate is opt-in and unmigrated. Migration is per-call-site: add `agentId: HANDLER.X` to each `unifiedTextGeneration({...})` invocation. Smoke ran 2026-04-30 confirms the schema and library work; coverage is the gap.
- **Tool Registry coverage gaps:** every Finale write inside AP path is audited. Reads, gmail label-modify, copilot tool calls, reconciler script calls, dashboard direct API calls — most of these still bypass the registry. Migrate as files are touched.
- **Memory Manager coverage gaps:** AP `recall()` migrated. Other call sites of `remember()` / `recall()` / `getVendorPattern()` / `storeVendorPattern()` / `kaizen-memory` / `dropship-store` still import directly.
- **Step 3 of PO lifecycle (auto-push order to vendor site):** ULINE has PR #14 (`feature/uline-friday-flow`, Stagehand+BrowserManager hybrid) awaiting merge. Axiom is open — would use existing `src/lib/axiom/client.ts` REST infrastructure.
- **Step 5-7 (acknowledged → shipped → received) lifecycle states:** PR #12 (`po-lifecycle-evidence`) makes these first-class on the PO entity.
- **Large-item anomaly check at ordering time:** flag draft POs that order >N× median for SKU/vendor (International Molasses pattern).

---

## 6 PR-ready branches awaiting review

All pushed to origin. None merged yet. Conflict markers measured 2026-04-30 against new main (`b16a60a`).

| PR | Branch | LOC | Conflict markers vs new main | Action |
|---|---|---:|---:|---|
| #14 | `feature/uline-friday-flow` | +2153 | **0** | Clean rebase. After e2e test, merge first. |
| #16 | `feature/build-demand-oracle` | +700 | 4 | Manual rebase; prefer cherry-pick of fixes |
| #15 | `feature/purchasing-data-fixes` | +1104 | 5 | Manual rebase |
| #13 | `feature/bill-selee-email-overwatch` | +1628 | 5 | Manual rebase, mostly net-new files |
| #11 | `feature/slack-request-tracking` | +3129 | 13 | Painful — overlaps reconciler/Finale write paths |
| #12 | `po-lifecycle-evidence` | +1950 | 25 | Hardest — 8/10 files conflict (purchasing + ops-manager) |

Suggested order: `#14 → #16 → #13 → #15 → #11 → #12` (clean → painful).

---

## Operational dos and don'ts

**DO:**
- Use Telegram + APIs as the daily driver.
- Restart `pm2 restart aria-bot --update-env` after any kernel/migration change.
- Watch for "🔍 Fallback Correlation Used" alerts in Telegram — confirm before assuming the auto-applied changes are right.
- Treat the dashboard as a **forensic surface** — open it when you need to drill into a specific issue/PO; don't park on it.

**DON'T:**
- Add new architecture before the open migration debt above is reduced.
- Add new dashboard panels until the Chrome-crash issue is profiled.
- Delete the `aria-review` worktree at `C:/Users/BuildASoil/Documents/Projects/aria-review` — Will uses it.
- Push to `.github/workflows/` from this assistant's token (lacks `workflow` scope) — those changes need Will's hand.

---

## Recommended next sequence (post-stabilization)

Per the 2026-04-30 code review (treat that critique as the active plan):

1. **Triage 6 PR-ready branches** against new main. Each is a real PR review; some may be cherry-picks instead of full merges.
2. **Migrate `ap-agent.ts` inline PO resolver** to shared `resolveFinalePo`. Smallest ROI but closes the drift.
3. **Auto-push order to Axiom** (REST API; `axiom/client.ts` infrastructure already in place). Tests step 3 of the PO lifecycle for one vendor.
4. **PR #14 ULINE e2e test** — confirms Will's "works well, needs e2e".
5. **Large-item anomaly** — flag at draft-PO creation time, Telegram-confirm before commit.
6. **Audit coverage check** — sweep src/ for direct `gmail.users.*` / `client.<finale_method>` calls that aren't `withToolAudit`-wrapped, log as migration backlog.

---

## Decision log

- **2026-04-29:** branch cleanup — 16 origin branches → 9. Deleted 13 (merged or dead).
- **2026-04-29:** dashboard cutover — module-tab full-canvas; right rail killed.
- **2026-04-29:** AIOS Tool Registry / Memory Manager facade / per-agent budgets all landed (commits 702aeb2, 4bc2c5e, 8d1de7a).
- **2026-04-29:** AP-pipeline writes the issue ledger directly (Phase 2 of Plan D).
- **2026-04-29:** paid-invoice pipeline rebuilt with multi-strategy PO correlation; Axiom Job Name → Finale SKU enrichment via static `AXIOM_TO_FINALE` map.
- **2026-04-29:** merge to `main` — `b16a60a`, 27 commits.
- **2026-04-30:** working-tree hygiene + this doc rewrite — `ba4d9a7`+.
- **2026-04-30 smoke:** verified merge reachable in production via direct lib calls (no dashboard). Issue ledger reads return 50 issues (`will`-handler shows 3 blocked). Tool Registry has 28 tools across 6 categories. 14 agent budgets seeded at $0.00 spent. `task_history` has one real `ap-reconciler:finale_get_order_details` audit row — Phase 2 wiring confirmed firing. Smoke script: `node --import tsx src/cli/smoke-merged-state.ts`.

---

**For future-me:** if you're scoping new work, look at the "Open migration debt" + "6 PR-ready branches" sections first. The default answer for "should I add a new abstraction here?" is "no — fold into an existing primitive or migrate something to use what's already there."
