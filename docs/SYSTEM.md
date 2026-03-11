/**
 * @file    SYSTEM.md
 * @purpose Coordinator document — read FIRST on every session. Routes to the right agents.
 * @author  Will
 * @created 2026-03-11
 * @updated 2026-03-11
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
├── Slack watchdog (eyes-only 👀 — NEVER posts)
├── OpsManager cron scheduler (America/Denver)
│   ├── 7:30 AM Mon-Fri → build risk → Telegram + Slack #purchasing
│   ├── 8:00 AM daily → daily summary → Telegram
│   ├── 8:01 AM Fridays → weekly summary → Telegram
│   ├── Every 15 min → AP inbox invoice check
│   ├── Hourly → advertisement cleanup
│   └── Every 30 min → PO conversation sync
└── Sandbox file watcher (~/OneDrive/Desktop/Sandbox/)

Next.js dev server (npm run dev)
├── Dashboard UI (src/app/dashboard/) — dark terminal aesthetic
├── Dashboard chat (Gemini 2.5 Flash — SEPARATE from Telegram bot)
└── API routes (src/app/api/dashboard/*)
```

## 7 Invariant Rules — Never Violate

1. `finale/client.ts` has pre-existing TS errors — **leave them alone**
2. After bot code changes: `npm run typecheck:cli` → `pm2 restart aria-bot`
3. **Three LLM paths** — never mix: bot=GPT-4o direct, lib=`unifiedTextGeneration()`, dashboard=Gemini
4. Finale writes: **GET → Modify → POST** always. Unlock `ORDER_LOCKED` via `actionUrlEdit` first.
5. Slack watchdog: **eyes-only**. Only 👀 reactions via user token. Never post.
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
| Slack monitoring, 👀 reactions, SKU matching | `slack-watchdog` |
| Database schema, queries, migrations | `supabase` |
| Vendor enrichment, PO correlation, GitHub issues | `vendor-intelligence` |
| OOS reporting, stock-out analysis | `reorder` → `finale-ops` → `supabase` |

## Dependency Graph

```
ops-manager (orchestrator — all crons)
├──→ ap-pipeline ──→ pdf-pipeline (OCR cascade)
│       ├──→ finale-ops (PO matching, reconciliation writes)
│       ├──→ vendor-intelligence (vendor correlation)
│       └──→ supabase (ap_activity_log, documents)
├──→ build-risk ──→ finale-ops (stock queries)
└──→ vendor-intelligence ──→ memory-pinecone (vendor patterns)

bot-tools (Telegram — user-facing entry point)
├──→ finale-ops, memory-pinecone, supabase
├──→ build-risk, reorder, ap-pipeline (via tool_calls)
└──→ slack-watchdog (runs inside same process)

dashboard (Next.js — web UI entry point)
├──→ finale-ops, supabase (via API routes)
└──→ ap-pipeline (invoice approve/dismiss actions)

reorder ──→ finale-ops (velocity engine, draft PO creation)
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
| Reorder items cache | Module-level var | 10 min | reorder, dashboard |
| Purchasing intel cache | Module-level var | 30 min | reorder, dashboard |
| `aria-memory` namespace | Pinecone | Permanent | memory-pinecone, bot-tools, slack-watchdog |
| `vendor-memory` namespace | Pinecone | Permanent | memory-pinecone, vendor-intelligence, ap-pipeline |
| All Supabase tables | Supabase DB | Permanent | supabase + most agents |

## Handoff Protocol

When completing a task, update `docs/STATUS.md` with:
1. Any newly degraded services
2. Files you changed (date, description, conversation ID)
3. New known issues introduced
4. Remove entries older than 14 days

## Deep Reference

→ `CLAUDE.md` — Full 314-line implementation reference. Only read when this file + agent files aren't enough.
→ `docs/ap-pipeline-sop.md` — Detailed AP pipeline standard operating procedures.

---
*Last updated: 2026-03-11*
