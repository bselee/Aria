/**
 * @file    STATUS.md
 * @purpose Living operational state — updated at end of each agent session
 * @author  Will
 * @created 2026-03-11
 * @updated 2026-03-16
 */

# ARIA — Operational Status

> Living document. Updated at end of each agent session.
> Keep under 60 lines. Remove entries older than 14 days.

## Service Health

| Service | Status | Detail |
|---|---|---|
| Gemini API | ⚠️ Quota exhausted | Free tier quota=0; paid tier needed. Fallback chain active. |
| OpenAI Embeddings | ❌ Replaced | Migrated to Pinecone llama-text-embed-v2 (conv f4dc6ecc) |
| OpenRouter | ✅ Working | Fallback OCR (Strategy 4) functioning |
| Anthropic | ✅ Working | Primary OCR Strategy 2 (`claude-haiku-4-5`) |
| Finale API | ✅ Working | Receivings + Committed PO queries verified 2026-03-13 |
| Supabase | ✅ Working | — |
| Gmail (default) | ✅ Working | bill.selee@ — token refresh verified 2026-03-13 |
| Gmail (ap) | ❌ Not configured | Suppress startup error, don't fix |
| Gmail MCP | ❌ Connection errors | EOF/timeout on every call — use project's @googleapis/gmail instead |
| Slack | ✅ Working | Bot reacts-only (eyes emoji) |
| Pinecone | ✅ Working | gravity-memory index, llama-text-embed-v2 integrated inference |

## Known Issues

- **OOM on typecheck**: Use `typecheck:cli` for bot work. Heap bumped to 24GB.
- **Gmail MCP broken**: External MCP server crashes with EOF. Not blocking — project uses its own Gmail OAuth.

## Recent Changes (last 7 days)

| Date | What Changed | Key Files | Conv ID |
|---|---|---|---|
| 2026-03-16 | **ULINE Reconciliation CLI** — single-command pipeline: scrape + map SKUs + update prices + freight | `src/cli/reconcile-uline.ts` | `7101fa3b` |
| 2026-03-16 | **UOM Conversion Fix** — Finale tracks smallest unit; vendors sell by case/box. Must divide price by factor. | reconcile-uline.ts, workflows | `7101fa3b` |
| 2026-03-16 | **Ad Sweep investigation** — diagnosed why sweep didn't run | ops-manager.ts | `5ecf18a7` |
| 2026-03-13 | **Pinecone embedding migration** — replaced OpenAI with llama-text-embed-v2 integrated inference | embedding.ts, memory.ts | `f4dc6ecc` |
| 2026-03-13 | **Receivings API verified** — 4 POs today, 10 in 7d. No fetch errors. | finale/client.ts | |
| 2026-03-13 | **Prepayment workflow tested** — LLM classification + URL extract on real emails | ap-agent.ts | |
| 2026-03-12 | **Inline Invoice Workflow Complete** — detect → parse → PDF → Bill.com → reply | inline-invoice-handler.ts | |
| 2026-03-12 | **OOS Report PO Links** — Direct Finale PO links in blocking components | oos-email-trigger.ts | `0e310435` |
| 2026-03-11 | **Build Risk cron added** — was missing from `start()` | ops-manager.ts | `7e529f0d` |

## Active Priorities

1. Gemini API paid tier — upgrade to resolve quota-0 blocking
2. Gmail MCP investigation — determine why external MCP server fails (EOF)
3. Pinecone MCP connectivity — intermittent EOF errors on upsert calls

## Updating This File

At task completion, add/update entries following the formats above.
Remove entries older than 14 days. Keep file under 60 lines total.
