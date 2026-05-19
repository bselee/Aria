/**
 * @file    SYSTEM.md
 * @purpose Coordinator document — read FIRST on every session. Routes to the right agents.
 * @author  Will
 * @created 2026-03-11
 * @updated 2026-05-19
 */

# ARIA — System Coordinator

> Read this first. Every session. Routes you to the right agents and surfaces cross-cutting state.
> For full implementation details → `CLAUDE.md`. For live operational state → `docs/STATUS.md`.

## What Aria Is

Will's personal ops assistant for **BuildASoil** (living soil / organic growing supply company).
A Next.js app with two long-lived background processes managed by PM2.

## Process Architecture

```
aria-bot (PM2) ← primary process, always running
├── Telegram bot (GPT-4o tool_calls — NOT llm.ts wrappers)
├── Slack watchdog (eyes-only 👀 — NEVER posts via watchdog; bot posts to #purchasing)
├── Cron Runner (declarative defineJob() — src/cron/jobs/index.ts)
│   ├── 7:30 AM Mon-Fri  → build-risk
│   ├── 7:45 AM Mon-Fri  → po-followup-watcher
│   ├── 7:50 AM Mon-Fri  → po-stuck-detector
│   ├── 8:00 AM Mon-Fri  → daily-summary
│   ├── 8:01 AM Fri      → weekly-summary
│   ├── 8:30 AM daily    → qty-calibration
│   ├── 9:00 AM Mon-Fri  → missing-reconciliation-watchdog
│   ├── Every 15 min     → ap-polling (+ po-sweep post-pass)
│   ├── Every 30 min     → build-completion-watcher, po-receiving-watcher, migration-tripwire
│   ├── Every 10 min     → task-self-healer
│   ├── Every 5 min      → close-finished-tasks, issue-projection
│   ├── Every 1 min      → flows-tick (gated: FLOWS_ENABLED)
│   ├── Hourly           → stat-indexing
│   ├── Every 2h         → po-arrival-risk-check
│   ├── Every 4h         → po-sync, purchasing-calendar-sync, po-auto-complete-watcher
│   ├── 6:00 AM daily    → carrier-poll
│   ├── 6:00 PM daily    → nightshift-enqueue
│   ├── 9:00 PM daily    → housekeeping
│   └── 1-3 AM Mon-Fri   → vendor reconciliations (axiom, fedex, teraganix, uline)
├── Flow runner (agentic flow substrate — flow_events + flow_runs)
└── Sandbox file watcher (~/OneDrive/Desktop/Sandbox/)

Next.js dev server (npm run dev)
├── Dashboard UI (src/app/dashboard/) — dark terminal aesthetic
│   ├── Main page — Ordering, Builds, Purchases, Activity tabs
│   └── Tasks page — agent_task hub (Control Plane)
├── Dashboard chat (Gemini 2.5 Flash — SEPARATE from Telegram bot)
├── Command Board API (agents, crons, tasks, issues, runs, heartbeats, tools)
└── Dashboard API (24 route groups — purchasing, tracking, reconciliation, etc.)
```

## 7 Invariant Rules — Never Violate

1. `finale/client.ts` has pre-existing TS errors — **leave them alone**
2. After bot code changes: `npm run typecheck:cli` → `pm2 restart aria-bot`
3. **Three LLM paths** — never mix: bot=GPT-4o direct, lib=`unifiedTextGeneration()`, dashboard=Gemini
4. Finale writes: **GET → Modify → POST** always. Unlock `ORDER_LOCKED` via `actionUrlEdit` first.
5. Slack watchdog: **eyes-only**. Only 👀 reactions via user token. Never post via watchdog.
6. In-memory state (`pendingApprovals` 24h, `pendingDropships` 48h) is **ephemeral** — lost on `pm2 restart`
7. Use `getAnthropicClient()` from `src/lib/anthropic.ts` — not `new Anthropic()`

## Agent Routing Table

| If the task involves… | Read these agents (in order) |
|---|---|
| AP invoices, email classification, forwarding, reconciliation | `ap-pipeline` → `pdf-pipeline` → `finale-ops` |
| Build risk, Google Calendar, BOM analysis | `build-risk` → `finale-ops` |
| Telegram bot tools, persona, chat history | `bot-tools` |
| Dashboard UI, API routes, panels, chat | `dashboard` |
| Finale API queries, mutations, PO writes | `finale-ops` |
| Pinecone memory, recall, vendor doc patterns | `memory-pinecone` |
| Cron jobs, scheduled tasks, timing | `ops-manager` |
| PDF OCR, extraction, parsing, classification | `pdf-pipeline` |
| Reorder engine, purchasing velocity, draft POs | `reorder` → `finale-ops` |
| PO lifecycle, follow-up, tracking, arrival risk | `reorder` → `finale-ops` → `dashboard` |
| Slack monitoring, 👀 reactions, SKU matching | `slack-watchdog` |
| Database schema, queries, migrations | `supabase` |
| Vendor enrichment, PO correlation, GitHub issues | `vendor-intelligence` |
| OOS reporting, stock-out analysis | `reorder` → `finale-ops` → `supabase` |
| Vendor reconciliation (Axiom, FedEx, ULINE, TeraGanix) | `finale-ops` → vendor-specific CLI |
| Agentic flows (payment inquiry, dropship) | `ops-manager` (flow substrate) |

## Dependency Graph

```
ops-manager (orchestrator — all crons + flow substrate)
├──→ ap-pipeline ──→ pdf-pipeline (OCR cascade)
│       ├──→ finale-ops (PO matching, reconciliation writes)
│       ├──→ vendor-intelligence (vendor correlation)
│       └──→ supabase (ap_activity_log, documents)
├──→ build-risk ──→ finale-ops (stock queries, BOM demand)
├──→ vendor-intelligence ──→ memory-pinecone (vendor patterns)
├──→ purchasing (PO lifecycle, follow-up, stuck detection, arrival risk)
│       └──→ finale-ops (velocity, receivings, carrier status)
└──→ flows (agentic flow_events → flow_runs lifecycle)

bot-tools (Telegram — user-facing entry point)
├──→ finale-ops, memory-pinecone, supabase
├──→ build-risk, reorder, ap-pipeline (via tool_calls)
└──→ slack-watchdog (runs inside same process)

dashboard (Next.js — web UI entry point)
├──→ finale-ops, supabase (via 24 API routes)
├──→ ap-pipeline (invoice approve/dismiss actions)
├──→ purchasing (ordering, watch, tracking, risk panels)
└──→ command-board (agent tasks, cron status, issues)

reorder ──→ finale-ops (velocity engine, draft PO creation, BOM demand)
slack-watchdog ──→ memory-pinecone (dedup), supabase (product catalog)
```

## Shared State Map — What's Ephemeral vs Persistent

| State | Location | TTL | Agents That Touch It |
|---|---|---|---|
| `pendingApprovals` | In-memory Map | 24h | ap-pipeline, bot-tools |
| `pendingDropships` | In-memory Map | 48h | ap-pipeline, bot-tools |
| `chatHistory` | In-memory Record | 20 msgs | bot-tools |
| Slack dedup Set | In-memory Set | Process life | slack-watchdog |
| Product catalog | In-memory cache | 30 min | slack-watchdog |
| Product list cache | Instance-level | Client life | finale-ops (validateProductExists) |
| Reorder items cache | Module-level var | 10 min | reorder, dashboard |
| Purchasing intel cache | Module-level var | 30 min | reorder, dashboard |
| Facility cache | Module-level | 4h TTL | finale-ops |
| Party name cache | Module-level | 1h, max 500 | finale-ops |
| BOM no-component cache | Module-level | Process life | finale-ops |
| `aria-memory` namespace | Pinecone | Permanent | memory-pinecone, bot-tools, slack-watchdog |
| `vendor-memory` namespace | Pinecone | Permanent | memory-pinecone, vendor-intelligence, ap-pipeline |
| All Supabase tables | Supabase DB | Permanent | supabase + most agents |
| `flow_events` / `flow_runs` | Supabase DB | Permanent | flow substrate |

## Handoff Protocol

When completing a task, update `docs/STATUS.md` with:
1. Any newly degraded services
2. Files you changed (date, description)
3. New known issues introduced
4. Remove entries older than 14 days

## Key Metrics

| Metric | Value |
|---|---|
| Source modules | 30 subdirectories in `src/lib/` |
| CLI scripts | 126 files in `src/cli/` |
| Dashboard API routes | 24 groups + command-board + webhooks |
| Supabase migrations | 98 |
| Cron jobs (defineJob) | 27 registered jobs |
| Agents | 13 |
| Workflows | 13 |
| Skills | 16 |

## Deep Reference

→ `CLAUDE.md` — Full implementation reference (443 lines). Only read when this file + agent files aren't enough.
→ `docs/ap-pipeline-sop.md` — Detailed AP pipeline standard operating procedures.
→ `src/cron/jobs/index.ts` — All cron job definitions (27 jobs).

---
*Last updated: 2026-05-19*
