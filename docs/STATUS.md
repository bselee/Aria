/**
 * @file    STATUS.md
 * @purpose Living operational state - updated at end of each agent session
 * @author  Will
 * @created 2026-03-11
 * @updated 2026-03-27
 */

# ARIA - Operational Status

> Living document. Updated at end of each agent session.
> Keep under 60 lines. Remove entries older than 14 days.

## Service Health

| Service | Status | Detail |
|---|---|---|
| Gemini API | Warning | Free tier quota=0; paid tier needed. Fallback chain active. |
| OpenRouter | OK | Fallback OCR/chat chain functioning. |
| Anthropic | OK | Primary OCR strategy (`claude-haiku-4-5`) working. |
| Finale API | OK | Receivings + committed PO queries verified 2026-03-13. |
| Supabase | OK | Shared copilot artifacts and action sessions live. |
| Gmail (default) | OK | bill.selee@ token refresh verified 2026-03-13. |
| Gmail MCP | Error | External MCP server hits EOF/timeout; use project Gmail OAuth instead. |
| Slack | OK | Watchdog startup smoke-check wired into bot boot; bot remains reacts-only. |
| Pinecone | OK | gravity-memory index active with llama-text-embed-v2 inference. |

## Known Issues

- Worktree `npm run typecheck` script still assumes local `node_modules`; run `node ..\\..\\node_modules\\typescript\\bin\\tsc --noEmit` from the worktree until installs are mirrored.
- Repo-wide TypeScript debt remains outside this rollout, especially `finale/*`, `feedback-loop.ts`, `rate-limiter.test.ts`, Gmail auth typing, and `slack/watchdog.ts`.

## Recent Changes (last 7 days)

| Date | What Changed | Key Files | Conv ID |
|---|---|---|---|
| 2026-03-27 | ULINE Friday order now verifies cart contents before claiming success, syncs verified cart prices back to the draft PO, and the daily summary now uses explicit yesterday-only Finale slices instead of inferring from week-to-date data | `src/cli/order-uline.ts`, `src/cli/order-uline-cart.ts`, `src/lib/intelligence/ops-manager.ts` | |
| 2026-03-27 | Email policy tightened for `bill.selee@buildasoil.com`: simple replies stay visible with `Replied`, human threads get `Follow Up`, default-inbox invoice reconciliation now closes Gmail only after safe outcomes, and non-AP invoices stay visible instead of being archived under forward labels | `src/lib/intelligence/acknowledgement-agent.ts`, `src/lib/intelligence/workers/default-inbox-invoice.ts`, `src/lib/intelligence/workers/ap-identifier.ts` | |
| 2026-03-26 | Shared copilot cutover - Telegram and dashboard normal Q&A now share one core; shared artifact ingestion, PO send recovery, and startup smoke are wired live | `src/lib/copilot/*`, `src/cli/start-bot.ts`, `src/app/api/dashboard/send/route.ts` | |
| 2026-03-16 | ULINE reconciliation CLI - scrape + map SKUs + update prices + freight | `src/cli/reconcile-uline.ts` | `7101fa3b` |
| 2026-03-16 | Ad sweep investigation - diagnosed why sweep did not run | `ops-manager.ts` | `5ecf18a7` |
| 2026-03-13 | Pinecone embedding migration - replaced OpenAI with llama-text-embed-v2 integrated inference | `embedding.ts`, `memory.ts` | `f4dc6ecc` |

## Active Priorities

1. ULINE production monitoring - verify cart extraction across live ULINE cart layouts and confirm draft-PO price syncs stay accurate.
2. Email policy rollout monitoring - verify `Replied` / `Follow Up` label behavior, default-inbox invoice closeout, and overnight reconciliation outcomes in production.
3. Shared copilot rollout monitoring - verify Telegram/dashboard shared Q&A, screenshot follow-ups, and PO send callbacks in production.
4. Gemini API paid tier and repo TypeScript debt cleanup.

## Updating This File

At task completion, add/update entries following the formats above.
Remove entries older than 14 days. Keep file under 60 lines total.
