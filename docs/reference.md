/**
 * @file    reference.md
 * @purpose Consolidated canonical reference for Hermia (Aria master developer)
 * @author  Hermia
 * @created 2026-05-29
 * @deps    CLAUDE.md, SYSTEM.md, STATUS.md, make-it-sing plan, orchestration-overhaul plan
 */

# Aria — Master Reference

> Single source of truth. Read at session start. Everything else derives from here.
> For live operational state → `docs/STATUS.md`. For deep implementation → `CLAUDE.md`.

---

## 1. Quick Start

```bash
# Ship bot changes
npm run ship:bot         # typecheck:cli + pm2 restart aria-bot
npm run smoke:bot        # verify clean logs

# Ship dashboard changes
npm run ship:dashboard   # typecheck + next build + pm2 reload
npm run smoke:dashboard  # verify clean logs

# Manual CLI scripts
node --import tsx src/cli/start-bot.ts        # Telegram bot
node --import tsx src/cli/start-slack.ts      # Slack watchdog
node --import tsx src/cli/run-ap-pipeline.ts  # Manual AP pipeline

# Database migrations (non-destructive → auto-apply)
node _run_migration.js supabase/migrations/<file>.sql
```

**IMPORTANT:** Skip typecheck unless explicitly asked — massive token burner, OOM risk.
Use `--dns-result-order=ipv4first` for Node 18+ IPv4 DNS on Windows.
All scripts load `.env.local` via dotenv at startup.

---

## 2. Process Architecture

```
PM2 Process: aria-bot (single process)
├── Telegram bot (GPT-4o tool_calls — NOT llm.ts wrappers)
├── Slack watchdog (eyes-only 👀 — NEVER posts; only reacts)
├── Cron Runner (declarative defineJob() — src/cron/jobs/index.ts)
├── Flow runner (agentic flow_events → flow_runs)
└── Sandbox file watcher (~/OneDrive/Desktop/Sandbox/)

PM2 Process: aria-dashboard (port 3001)
├── Next.js 14 dashboard UI (dark terminal aesthetic)
├── Dashboard chat (Gemini 2.5 Flash — SEPARATE from Telegram bot)
└── Dashboard API (24 route groups)
```

**Node version:** 20+ required. TypeScript 5+, tsx 4+.
**ecosystem.config.cjs:** `--dns-result-order=ipv4first` critical flag. Log rotation: 10MB max, 5 retain. Max restarts: 20, exponential backoff 10s.

---

## 3. Seven Invariant Rules — NEVER Violate

1. `finale/client.ts` has pre-existing TS errors — **leave them alone**
2. After bot code changes: `npm run ship:bot` (typecheck:cli → pm2 restart)
3. **Three LLM paths** — never mix: bot=GPT-4o direct, lib=`unifiedTextGeneration()`, dashboard=Gemini
4. Finale writes: **GET → Modify → POST** always. Unlock `ORDER_LOCKED` via `actionUrlEdit` first
5. Slack watchdog: **eyes-only**. Only 👀 reactions via user token. Never post via watchdog
6. In-memory state (`pendingApprovals` 24h, `pendingDropships` 48h) is **ephemeral** — lost on pm2 restart. Dropships now persisted to agent_task (dropship-store-v2)
7. Use `getAnthropicSDK()` from `src/lib/anthropic.ts` — not `new Anthropic()`

---

## 4. Agent Routing Table

| If the task involves… | Read these agents/files |
|---|---|
| AP invoices, email classification, reconciliation | `ap-agent.ts` → `ap/vendor-router.ts` → `reconciler.ts` |
| Build risk, Calendar, BOM | `build-risk.ts` → `build-parser.ts` → `calendar.ts` |
| Telegram bot tools, persona, chat | `start-bot.ts` → `commands/hermia.ts` |
| Dashboard UI, API routes, panels | `src/app/dashboard/` → `src/components/dashboard/` |
| Finale API queries, mutations | `finale/client.ts` → `finale/purchasing.ts` |
| Memory (SQLite local-first) | `memory-store.ts` → `memory.ts` → `vendor-memory.ts` |
| Cron jobs, scheduled tasks | `ops-manager.ts` → `cron/jobs/index.ts` |
| PDF OCR, extraction | `pdf/extractor.ts` → `pdf/invoice-parser.ts` |
| Reorder engine, purchasing velocity | `finale/client.ts` → `getPurchasingIntelligence()` |
| PO lifecycle, follow-up, tracking | `po-followup-watcher.ts` → `tracking-agent.ts` |
| Slack monitoring | `slack/watchdog.ts` |
| Vendor reconciliation | `reconcile-*.ts` CLI scripts |
| Orchestrator hierarchy | `hermes-orchestrator.ts` → `cognitive-round.ts` |

---

## 5. AP Invoice Pipeline

### Flow
1. **Email arrives** at `ap@buildasoil.com`
2. **Forward raw** to `buildasoilap@bill.com` (Bill.com handles payment)
3. **Reconcile** against Finale: parse PDF → match PO → `reconcileInvoiceToPO()`
4. **Auto-apply** safe changes or Telegram approval for significant mismatches

### Classification
Emails classified as: INVOICE / STATEMENT / ADVERTISEMENT / HUMAN_INTERACTION
- Nightshift pre-classification (Haiku) for overnight emails → free ADVERTISEMENT skip
- Promotional regex fast-path catches newsletters before LLM call

### Idempotency
Before processing ANY PDF: check `documents.gmail_message_id` in Supabase.
If exists → skip entirely. Prevents double-forwarding on crash + re-poll.

### Reconciliation Safety Thresholds
| Condition | Action |
|---|---|
| ≤3% price change | Auto-approve |
| >3% but <10× magnitude | Telegram approval |
| ≥10× magnitude | REJECT (OCR error) |
| Total impact >$500 | Manual approval |

### Multi-Account Tokens
- `"ap"` → `ap-token.json` (ap@buildasoil.com)
- `"default"` → `token.json` (bill.selee@buildasoil.com)
- Calendar → `calendar-token.json` (separate OAuth flow)

---

## 6. Purchasing Intelligence

### Velocity Pipeline (`getPurchasingIntelligence()`)
1. GraphQL page `productViewConnection` (500/page) for Active SKUs
2. REST `lookupProduct(sku)` → stock, supplier, `resolveParty()`
3. Combined GraphQL: `purchasedIn` + `soldIn` + `committedPOs`
4. Compute: `dailyRate = max(purchaseVel, salesVel)`, `runwayDays = stock/dailyRate`
5. Urgency: CRITICAL < leadTime, WARNING < leadTime+30, WATCH < leadTime+60

### Dropship Exclusions
Regex in `resolveParty()`: `/autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i`

### API Efficiency
- 3 concurrent workers (not 5)
- 100ms pause between SKU dispatches
- 429 backoff: 5s wait + single retry
- Default window: 365 days; deep-dive: 730 days via `?daysBack=730`

### Snooze System (PurchasingPanel)
- localStorage: `aria-dash-purchasing-snooze`
- Vendor key: `v:${vendorPartyId}` | Item key: `productId`
- Durations: 30d, 90d, "forever"

---

## 7. Finale Write Pattern

**GET → Modify → POST always.** If PO status is `ORDER_LOCKED`:
1. Call `actionUrlEdit` to unlock
2. Re-fetch
3. Modify
4. POST

### Fee Types → productpromo IDs
| Fee | ID |
|---|---|
| FREIGHT | 10007 |
| TAX | 10008 |
| TARIFF | 10014 |
| LABOR | 10016 |
| SHIPPING | 10017 |

---

## 8. Cron Framework

### Declaration Pattern
```typescript
// src/cron/jobs/index.ts
defineJob({
  name: "job-name",
  schedule: "*/15 * * * *",  // or "0 7 * * 1-5"
  handler: async () => { /* work */ },
  budget: "low" | "medium",
  onFail: "log" | "escalate-to-supervisor" | "telegram-will" | "silent",
  enabled: true
})
```

### Schedule (America/Denver)
| Time | Job | Notes |
|---|---|---|
| 7:30 AM M-F | build-risk | Telegram + Slack #purchasing |
| 8:00 AM M-F | daily-summary | AP, POs, builds, tasks |
| 8:01 AM Fri | weekly-summary | |
| 8:30 AM daily | qty-calibration | |
| 9:00 AM M-F | missing-reconciliation | |
| Every 15 min | ap-polling | + PO sweep post-pass |
| Every 15 min | cognition-round | Cognitive decision engine |
| Every 4h | po-sync, calendar-sync | |
| Every 6h | memory-sync | SQLite → Supabase backup |
| Every 6h | stat-indexing | |
| 6:00 PM M-F | nightshift-enqueue | |
| 9:00 PM daily | housekeeping | |
| Every 30 min | build-completion, po-receiving, migration-tripwire | |
| Every 15 min | close-finished-tasks, issue-projection, issue-orchestrator | |
| 1-3 AM M-F | vendor reconciliations (disabled — CLI manual) | |

### Observability
- `recordCronRun()` in-memory map (command-board dashboard)
- `memoryLayerManager.archiveSession()`
- `OpsManager.cronHookSuccess/Failure()` (heartbeat + supervisor)

---

## 9. Memory Architecture

### Local-First (Post-Pinecone)
- **Hot tier:** SQLite via `memory-store.ts` (recent 30 days, <1ms queries)
- **Cold tier:** Supabase pgvector (all-time backup, synced every 6h)
- **Embeddings:** OpenAI `text-embedding-3-small` (1024d)
- **Namespaces:** `aria-memory`, `vendor-memory`
- Pinecone dependency REMOVED (commit 8b52c1b)

### Cognitive Round System
- Runs every 15 min via `cognitive-round.ts`
- Deterministic rules engine (no LLM needed)
- Decisions: suppress low-priority crons, boost critical ones
- Logged to `cognitive_round_decisions` table

---

## 10. Telegram Commands (Existing)

| Command | Purpose |
|---|---|
| `/hermia` | Full agent hierarchy + health status |
| `/cognition` | Last cognitive round decision |
| `/priority` | Priority queue / urgent items |
| `/budget` | Per-agent spend vs caps |
| `/memories` | Search local memory store |
| `/agents` | Agent status overview |
| `/aphealth` | AP health — stuck emails, daily stats |
| `/cost` | Cost tracking summary |
| `/ship` | Trigger ship:bot from Telegram |
| `/order <PO>` | Browser-based vendor cart filling |
| `/tasks` | Paginated agent_task list with inline buttons |
| `/jobs` | List cron jobs with status |
| `/run <job>` | Manually trigger a cron job |

---

## 11. Dashboard Panels

### Existing
- PurchasingPanel (vendor tabs, urgency, snooze)
- ActivePurchasesPanel (POs in flight)
- ReorderPanel (draft POs)
- BuildsPanel / BuildRiskPanel
- POStepper (PO lifecycle steps)
- ActivityFeed (AP events)
- InvoiceQueuePanel
- TrackingPanel
- CommandBoard (agents, crons, tasks)
- CognitiveRoundPanel (decision log)

### Planned (from Make It Sing)
- PipelinePanel (email→invoice→PO→receive→reconcile swimlanes)
- VendorScorecardPanel (response time, on-time %, accuracy)
- DailyOpsSummaryPanel (today's volume, processed, created, sent)
- PO Aging color-code extension on ActivePurchasesPanel

---

## 12. Key Files Quick Reference

| File | Purpose |
|---|---|
| `src/lib/intelligence/ops-manager.ts` | Cron orchestrator singleton |
| `src/lib/intelligence/ap-agent.ts` | AP email processing |
| `src/lib/intelligence/cognitive-round.ts` | Decision engine |
| `src/lib/intelligence/hermes-orchestrator.ts` | Agent hierarchy (5 domains) |
| `src/lib/intelligence/memory-store.ts` | SQLite vector store |
| `src/lib/intelligence/ordering-urgency.ts` | "Order right now" intelligence |
| `src/lib/intelligence/ap-health.ts` | Stuck email detection |
| `src/lib/purchasing/vendor-order-cycle.ts` | Vendor cycle guard |
| `src/lib/finale/client.ts` | Finale API client (pre-existing TS errors) |
| `src/lib/finale/purchasing.ts` | Purchasing intelligence |
| `src/lib/finale/reconciler.ts` | Invoice reconciliation engine |
| `src/cli/commands/hermia.ts` | Telegram command registry |
| `src/cli/start-bot.ts` | Bot entry point (GPT-4o tool_calls) |
| `src/cron/jobs/index.ts` | All cron job definitions |
| `ecosystem.config.cjs` | PM2 config |

---

## 13. Remaining Gaps (Make It Sing Plan)

### P1 — High Impact, Execute First

| Gap | Description | Effort |
|---|---|---|
| 1.2 | `/emailsearch <query>` — search email queues from Telegram | Low |
| 2.2 | Vendor Scorecard panel (response time, delivery %, accuracy) | Medium |
| 3.1 | Invoice Auto-Approval (exact match → auto-approve to Bill.com) | Medium |

### P2 — Important, Execute Second

| Gap | Description | Effort |
|---|---|---|
| 1.3 | Promotional regex expansion (skip LLM for newsletters) | Low |
| 1.4 | Email→task conversion from chat | Medium |
| 2.3 | PO Aging color-code on ActivePurchasesPanel | Low |
| 2.4 | Daily Ops Summary dashboard panel | Medium |
| 3.2 | Vendor Dispute Auto-Draft | Medium |
| 3.3 | Duplicate Invoice Detection | Low |
| 4.2 | Receiving Dock Calendar | Medium |

### P3 — Nice to Have

| Gap | Description | Effort |
|---|---|---|
| 1.5 | Thread context in ack agent | Medium |
| 2.1 | Unified Pipeline View (big overhaul) | High |
| 3.4 | Payment Terms Awareness | Low |
| 4.4 | Multi-Shipment PO Consolidation | Low |

### ✅ Already Completed (This Session)
- Gap 1.1: REQUIRES_HUMAN surfacing → Telegram digest
- Gap 4.1: Delivery Exception Auto-Escalation (commit 77739af)
- Gap 4.3: Auto-Receiving Prompt (commit 612617a)
- Gap 4.5: L2/L3 Vendor Escalation (commit 612617a)
- Phase 1 orchestration: Pinecone→SQLite, cron optimization, supervisor deterministic
- Phase 3: Cognitive Round system
- Phase 4: Crash loop protection, dropship persistence, AP idempotency

---

## 14. Environment Variables

```
# Core
TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
ANTHROPIC_API_KEY, OPENAI_API_KEY
NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

# Finale
FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL

# Slack
SLACK_ACCESS_TOKEN (user, 👀), SLACK_BOT_TOKEN (bot, #purchasing)
SLACK_OWNER_USER_ID, SLACK_MORNING_CHANNEL

# Google OAuth
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
GOOGLE_GENERATIVE_AI_API_KEY (Gemini — dashboard chat only)

# GitHub
GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO

# Optional
FIRECRAWL_API_KEY (vendor enrichment)
ELEVENLABS_API_KEY (TTS)
PERPLEXITY_API_KEY
HUB_TASKS_ENABLED (default: true)
```

---

## 15. Code Standards

1. **File Headers:** Every new file: `@file`, `@purpose`, `@author`, `@created`, `@deps`
2. **JSDoc:** Every exported function gets typed parameters + return
3. **No `any`:** Use TypeScript schemas or Zod validation
4. **Path Alias:** `@/*` maps to `src/*`
5. **Commit:** After every logical unit with descriptive message
6. **Ship:** `npm run ship:bot` or `npm run ship:dashboard` after changes
7. **Git:** Commit message format: `feat|fix|perf|refactor|chore(scope): description`

---

*Last updated: 2026-05-29*
