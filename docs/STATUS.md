/**
 * @file    STATUS.md
 * @purpose Living operational state — updated at end of each agent session
 * @author  Will
 * @created 2026-03-11
 * @updated 2026-05-19
 */

# ARIA — Operational Status

> Living document. Updated at end of each agent session.
> Keep under 80 lines. Remove entries older than 14 days.

## Service Health

| Service | Status | Detail |
|---|---|---|
| Anthropic | ✅ Working | Primary LLM (Claude Haiku for OCR, Sonnet for complex tasks) |
| OpenRouter | ✅ Working | Fallback OCR (Strategy 4) + free-tier agentic coding |
| Finale API | ✅ Working | REST + GraphQL. Product list-cache fallback active for 404-quirk SKUs |
| Supabase | ✅ Working | 98 migrations applied. Flow events/runs tables added 2026-05-20 |
| Gmail (default) | ✅ Working | bill.selee@ — OAuth token auto-refresh |
| Gmail (ap) | ✅ Working | ap@buildasoil.com — AP inbox polling every 15 min |
| Slack | ✅ Working | Bot posts to #purchasing, user-token 👀 reactions |
| Pinecone | ✅ Working | gravity-memory index, llama-text-embed-v2 integrated inference |
| Telegram | ✅ Working | GPT-4o tool_calls + aria-tools |
| Google Calendar | ✅ Working | PO lifecycle sync every 4h |

## Known Issues

- **OOM on typecheck (Token Burner)**: The full typecheck is a massive token burner. Running `typecheck:all` or standard typescript compile checking is highly discouraged for agents. Always bypass typecheck or use `typecheck:cli` if specifically testing. Heap bumped to 24GB via `--max-old-space-size`.
- **finale/client.ts = 6,317 lines**: God Object — needs decomposition into products, orders, purchasing-intel, receivings modules.
- **start-bot.ts = 131KB**: Needs tool handler extraction.
- **Finale REST 404 quirk**: `GET /api/product/<sku>` returns 404 for ~50 valid products. Mitigated by `validateProductExists()` with product-list fallback (added 2026-03-23, expanded 2026-05-17).

## Recent Changes (last 7 days)

| Date | What Changed | Key Files |
|---|---|---|
| 2026-05-26 | **Dashboard Schema Fixes** — Corrected statusId GraphQL queries and agent-task unique constraint conflicts | finale/client, intelligence/agent-task |
| 2026-05-21 | **Tracking Precision Hardening** — Hardened Oak Harbor regex prefix, centralized all tracking extraction to eliminate duplicate regexes, verified all unit + integration tests green | carriers/tracking-service, intelligence/tracking-agent |
| 2026-05-19 | **PO Send revert** — fail-closed; dropped Gmail fallback + homemade PDF | purchasing/po-send |
| 2026-05-19 | **Ordering UI** — drop bulk Create All; subtler snoozed rows + 1-click unsnooze | dashboard/page.tsx |
| 2026-05-19 | **Sent POs exit Ordering** → move to Purchasing Watch | purchasing/po-lifecycle |
| 2026-05-18 | **ULINE verify-only** — diff existing cart vs PO without re-pasting | cli/order-uline.ts |
| 2026-05-18 | **PO auto-complete watcher** — vendor-pattern aware, default OFF | purchasing/po-auto-complete |
| 2026-05-18 | **Reconciler hardening** — disproportion guard (fee ≤ 2× subtotal), brand-word confidence, 9 new tests | finale/reconciler.ts |
| 2026-05-17 | **Finale 404 recovery** — recovered ~50 components via list-cache fallback | finale/client.ts |
| 2026-05-17 | **PO Arrival Risk** — two-tier severity, action buttons, compose ETA draft, snooze 48h | purchasing/po-arrival-risk |
| 2026-05-17 | **Flow Substrate** — backend agentic flow system + dropship canary | flows/runner, flows/registry |
| 2026-05-16 | **Activity Feed** — terminal-style, attention ranking, notes, teachable corrections | dashboard, ap_activity_log |

## Active Priorities

1. Decompose `finale/client.ts` (6,317 lines) into focused modules
2. Decompose `start-bot.ts` (131KB) into tool handlers + conversation management
3. Expand test coverage — 17 test files for 30+ modules
4. Clean root directory scratch files + stale worktrees

## Updating This File

At task completion, add/update entries following the formats above.
Remove entries older than 14 days. Keep file under 80 lines total.
