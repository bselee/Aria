# Merge Summary — `feature/agentic-issue-lifecycle-phase1` → `main`

> **Reference doc** for the 26-commit merge landing on 2026-04-29. Use this when revisiting what changed today, or when triaging issues that may stem from this batch.

**Branch:** `feature/agentic-issue-lifecycle-phase1`
**Commits:** 26 (a40c10f → e7d1268)
**LOC:** roughly +9,000 / −500 across ~60 files
**Migrations applied to live DB:** `20260509_create_agent_issue.sql`, `20260509b_task_history_issue_cascade.sql`, `20260510_create_agent_budget.sql`
**Tests:** all focused suites green; full project typecheck (CLI + Next.js) 0 errors

---

## What this batch changes (in plain English)

Aria gains an **issue ledger** (cases that span multiple tasks), a **load-bearing kernel** (Tool Registry / Memory Manager / per-agent budgets that audit + enforce), a **rebuilt dashboard** (module-tab full-canvas layout), a **rich Telegram surface** (`/issues`, `/blockers`, `/issue <id>` with action buttons), and a **robust paid-invoice pipeline** (multi-strategy PO correlation that handles Axiom + similar vendors).

If you're trying to remember what's new after this merge, every section below is one of those areas.

---

## 1. Issue Ledger (Plan D Phase 1 + Phase 2)

**Migrations:** `agent_issue` table + `agent_task.issue_id` FK + `task_history.issue_id` (Phase 1). FK cascade fix (Phase 1.1).

**Why:** the command board was a *task viewer* — every row was one decision point, blocked-failed implied stopped, recently-closed was a graveyard. We needed a *case ledger* — each row is one operational issue that spans multiple tasks/handoffs.

**Lifecycle:** `detected | triaging | working | waiting_external | blocked | complete`
**Autonomy:** `working | waiting | retrying | resolved | needs_policy`
**Blocker enum (13):** `missing_receipt · po_not_found · vendor_mismatch · extraction_failed · policy_required · external_pending · duplicate_or_conflict · source_unavailable · auth_required · data_integrity_error · retry_exhausted · human_approval_required · unknown`

**Phase 1 (commits a40c10f → 9ad8b38):** schema + `agent-issue.ts` core (`createOrAdvance`, `recordHandoff`, `setBlocker`, `clearBlocker`, `complete`, `linkTask`, `listIssues`, `getById`, `getBySource`) + `IssueProjection` cron + command-board service + API routes + Telegram `/issues` command + 4 review fixes from Will + completed_at insert/advance fix.

**Phase 2 (commits 0401c33 → 8db1e43):** AP pipeline writes the issue ledger directly. `reconcileAndUpdate` ensures issue at top, advances per verdict (auto_approve→complete, needs_approval→block, rejected→block(data_integrity_error), duplicate/no_change→complete, error→block(source_unavailable)). `storePendingApproval` ensures + linkTask + handoff + block(human_approval_required). Approve/reject paths unblock+complete. Dropship FAILED creates issue+linkTask+block(source_unavailable). Dashboard approve/dismiss/rematch routes wired to ledger too.

**Day 1.6 (in 7772c66):** cross-cutting `resolveLinkedIssueFromTaskAction` in task-actions.ts so that closing a task via /tasks Telegram OR dashboard also closes the linked issue.

**Day 2 (in 7772c66):** dashboard `currentlyHandling` overlay — agent tree shows live ▶ in-flight + ⏸ blocked counts per agent, fed by `agent-issue.getCurrentlyHandlingCounts()`.

**Behavioral guardrails locked by tests:**
- `blocked` is reserved for explicit `setBlocker` calls — projection NEVER sets blocked from FAILED status alone.
- Issue events go to `task_history.issue_id` via `appendIssueEvent` — never via the FK-broken `task_id` path.
- All hub writes are best-effort — a ledger failure can't block AP polling, Bill.com forwarding, or Telegram approvals.

---

## 2. Telegram surface (rich `/issues`)

**Commit a75daa9 + 033695f.**

- `/issues` — blocking-first list: 👀 (need-you) → 🚫 blocked → ⏳ waiting → ▶ in-flight. Summary line + per-row action buttons (✅ Approve / ❌ Reject for human-approval rows; ✓ Resolve / 🔍 Detail for everything else).
- `/blockers` — just the blocked subset.
- `/issue <id>` — detail view: state, handler, blocker, next action, timeline, linked tasks.
- Inline-button handlers: `issue_approve_*` (routes through `findLinkedOpenTask` → `approveTask`), `issue_reject_*`, `issue_resolve_*` (clearBlocker + complete), `issue_detail_*`.
- BotFather `setMyCommands` published at boot — autocomplete dropdown shows all 13 commands.
- `/issues` no longer needs the dashboard server — calls `getCommandBoardIssues` directly in-process.

---

## 3. Dashboard cutover

**Commits eb8a99a + 31de1c5.**

The 12 operational panels (AP / Receivings / Ordering / Tracking / Builds / Build Schedule / Statement Recon / Active POs / Activity / Oversight) had been crammed into a 320px bottom dock while WorkQueueBoard took prime real estate. New layout:

- Top header: counts + refresh
- Module tabs: **Blocking Me** (default) · AP · Receivings · Ordering · Tracking · Build Risk · Build Schedule · Statement Recon · Active POs · Tasks · Oversight · Activity
- Center: full-canvas selected panel
- "Blocking Me" tab is the new IssuesPanel (issue ledger surface with inline approve/reject/resolve buttons + count summary)
- Tabs **stay mounted** after first visit — switching is pure CSS visibility (instant after JIT compile)
- Right rail killed — agent-tree-display-only didn't earn its space
- Per-tab localStorage persistence

**API additions:**
- `POST /api/command-board/issues/[id]/actions` — issue-level actions route through linked tasks when present.

---

## 4. AIOS-borrowed kernel (Tool Registry / Memory / Scheduler / Budgets)

**Commits bb8cca6 (Day 3 scaffold) + 702aeb2 + b50f228 (Phase 2) + 4bc2c5e (Phase 3) + 8d1de7a (Phase 4).**

The Tool Registry that landed on Day 3 was metadata-only — nothing routed through it. Phases 2-4 made it load-bearing for the AP pipeline.

**Tool Registry:** `src/lib/agents/tool-registry.ts` with typed `RegisteredTool { name, description, category, scope, agentScope, tool? }` + `withToolAudit(name, ctx, args, fn)` audit wrapper. Catalog visible at `/api/command-board/tools`.

**Registered tools (24 across 6 categories):**
- `build` (1): build_risk_analysis
- `finale` (9): lookup_product, get_consumption, get_order_summary, get_order_details, add_items_to_po, update_order_item_price, update_product_supplier_price, add_order_adjustment, update_order_adjustment_amount, update_shipment_tracking
- `gmail` (7): list_messages, get_message, get_attachment, list_labels, modify_labels, create_label, send_message
- `memory` (4): put_aria, query_aria, put_vendor, get_vendor
- `scraping` (1): scrape_purchasing_dashboard
- `supabase` (4): query_vendors, query_invoices, query_purchase_orders, inspect_artifact

**Permission gates:** Finale writes scoped to `ap-reconciler`; Gmail send scoped to `ap-agent`; reads unrestricted.

**Memory Manager facade:** `src/lib/memory/index.ts` with `memory.{put, get, query}(namespace, ...)` collapsing 4 fragmented patterns (Pinecone, vendor-memory, kaizen, dropship-store) into one API. AP path `recall()` migrated. Existing call sites still work.

**Per-agent budgets:** new `agent_budget` table with `monthly_usd_cap` + `current_period_usd_spent` + `paused_until`. 14 agents seeded (ap-agent: $50, ap-identifier: $10, watchdog: $5, will: $100, …). `unifiedTextGeneration` + `unifiedObjectGeneration` accept optional `agentId`; before-call `assertBudget` throws `BudgetExceededError` when over cap; after-call `chargeBudget(agent, model, inputTokens, outputTokens)` records spend with calendar-month rollover. `/api/command-board/agents` returns per-agent budget data.

**Audit:** every wrapped call writes a `task_history` row with `event_type='tool_call'`, `agent`, `args_summary`, `duration_ms`, `success/failure` — visible in the issue timeline.

---

## 5. Paid-invoice pipeline (default-inbox-invoice.ts)

**Commits ae68cfd + a7c7ddf + e7d1268.**

The paid-invoice worker (processes `bill.selee@buildasoil.com` invoices) had three problems that made vendors like Axiom Print fail to correlate:

1. **Single exact PO# lookup.** Used only `getOrderSummary(printedPo)` — no parens / digits / OCR-transposition recovery.
2. **Early `no_po_number` gate.** Subject/body had no `PO #N` → bail before Haiku ran. But Axiom doesn't print PO# in subject; it's in the per-line Job Name field.
3. **No vendor-name-aware fallback.** When PO# truly missing, no way to correlate via SKU overlap or amount proximity to a recent vendor PO.

**Fix:**

- **Shared `resolveFinalePo`** (`src/lib/finale/po-resolver.ts`) — extracted from ap-agent's inline logic. Tries: raw token → parens variant (`B(NNN)`) → digits-only → adjacent-digit swap variants → vendor-name disambiguation when multiple resolve. Same surgery the AP pipeline uses.
- **Multi-strategy `correlatePo`** — when exact resolution misses, falls through:
  1. **exact** — printed PO# resolves directly
  2. **sku-overlap** — invoice line SKUs ∩ recent vendor PO SKUs (60-day window)
  3. **amount-proximity** — invoice subtotal ≈ PO total within 5% / $50
  4. **vendor-recent** — most recent OPEN PO for the vendor (Will's primary heuristic)
  5. **create-draft** — vendor has no recent POs at all → Telegram alert
- **`FinaleClient.listRecentPosByVendor`** — new GraphQL query filtered server-side by date + status, post-filtered by fuzzy supplier-name overlap.
- **No more early gate.** Worker always runs Haiku (cost is paid; classification already done upstream). Job Name field added to extraction schema + prompt.
- **Axiom-aware enrichment** — when fromEmail/vendorName matches Axiom, post-Haiku enrichment runs each line's `jobName` through the static `AXIOM_TO_FINALE` map (now exported from `axiom/client.ts`) to fill `finaleSku`. The SKU-overlap correlation strategy then does the rest.
- **Telegram on fallback** — non-exact correlations send a "🔍 Fallback Correlation Used" alert with the chosen PO + strategy + confidence + diagnostic note before changes apply.

---

## 6. Branch + repo hygiene

**Commits 1dbbb80 + 23f28fb.**

- `.gitignore` covers SQLite WAL/SHM + `tmp-next-dev-*.log`.
- `aria-local.db-shm`/`.db-wal` untracked from git.
- 13 stale branches deleted (7 already-merged + 4 superseded duplicates + 2 prototypes).
- 6 PR-ready branches still on origin awaiting review (#11 slack-request-tracking, #12 po-lifecycle-evidence, #13 bill-selee-email-overwatch, #14 uline-friday-flow, #15 purchasing-data-fixes, #16 build-demand-oracle).

---

## 7. Reference plan landed

**Commit 10f3706:** `docs/plans/2026-04-29-aria-state-and-path-forward.md` — full state inventory + 4-phase roadmap. Refer back to it when scoping new work.

---

## What's still pending (NOT in this merge)

1. **The 6 PR-ready branches (#11-#16)** — need conflict resolution against post-merge main. Hardest is #11 (slack-request-tracking) and #12 (po-lifecycle-evidence) due to file overlap.
2. **Step-3 automation** — auto-push order to vendor sites. ULINE = PR #14. Axiom = TBD (would use existing `src/lib/axiom/client.ts` REST infrastructure).
3. **Large-item anomaly check** at ordering time (International Molasses pattern) — Telegram-confirm when ordering >N× median for SKU/vendor.
4. **AP-agent.ts inline PO resolution** still has its own copy of the resolver (lines ~1100-1190). Migrate to the shared `resolveFinalePo` helper to prevent drift.

---

## Operational notes

- **`pm2 restart aria-bot --update-env`** required on the production machine to pick up Phase 2-4 kernel migrations + paid-invoice pipeline changes. Already done at `e7d1268`.
- **Watch the next overnight default-inbox cycle** — should see fewer `po_not_found` and clearer "🔍 Fallback Correlation Used" alerts when Axiom-style invoices land.
- **Issue ledger fills out organically** — the Phase 2 direct-write paths only fire on new AP polling cycles, dashboard approvals, and `/tasks` actions. Pre-existing complete issues stay complete.
- **Tool Registry catalog** at `GET /api/command-board/tools` — useful for verifying what's registered.
- **Per-agent budget data** at `GET /api/command-board/agents` (each agent now has a `budget` field). Watch for any agent hitting cap and pausing — it's intentional.

---

**For future-me reading this after a regression:** start by checking which commit introduced the file, then re-read the relevant section above. The architecture changes in §4 are the most likely source of subtle drift if they don't fully take.
