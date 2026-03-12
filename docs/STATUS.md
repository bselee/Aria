/**
 * @file    STATUS.md
 * @purpose Living operational state — updated at end of each agent session
 * @author  Will
 * @created 2026-03-11
 * @updated 2026-03-12
 */

# ARIA — Operational Status

> Living document. Updated at end of each agent session.
> Keep under 60 lines. Remove entries older than 14 days.

## Service Health

| Service | Status | Detail |
|---|---|---|
| Gemini API | ⚠️ Quota exhausted | Free tier quota=0 for OCR; paid tier needed. Dashboard chat may also fail. |
| OpenAI Embeddings | ⚠️ Quota exhausted | Pinecone upserts for memory/recall affected |
| OpenRouter | ✅ Working | Fallback OCR (Strategy 4) functioning |
| Anthropic | ✅ Working | Primary OCR Strategy 2 (`claude-haiku-4-5`) |
| Finale API | ✅ Working | Rate limits enforced: 3 workers, 100ms pause |
| Supabase | ✅ Working | — |
| Gmail (default) | ✅ Working | bill.selee@ — token.json valid |
| Gmail (ap) | ❌ Not configured | ap-token.json not generated; suppress error, don't fix |
| Slack | ✅ Working | Bot reacts-only (eyes emoji) |
| Pinecone | ✅ Working | gravity-memory index, 1024d |

## Known Issues

- **OOM on typecheck**: Combined 112-file compile exceeds 8GB heap. Use `typecheck:cli` for bot work. `next build` skips type-checking (`ignoreBuildErrors: true`). Heap bumped to 24GB.
- **Gmail AP token not set up**: Will chose not to configure `ap-token.json` — suppress the startup error, don't attempt to fix.

## Recent Changes (last 7 days)

| Date | What Changed | Key Files | Conv ID |
|---|---|---|---|
| 2026-03-12 | **Inline Invoice Workflow Complete** — Full pipeline: detect → parse → PDF → Bill.com → reply | inline-invoice-handler.ts, acknowledgement-agent.ts | (this session) |
| 2026-03-12 | **Ack Agent INLINE_INVOICE intent** — Routes inline invoices to handler | acknowledgement-agent.ts | (this session) |
| 2026-03-12 | **Daily Recap Emoji Map** — Added INLINE_INVOICE + 4 other intent emojis | ap-agent.ts L1333 | (this session) |
| 2026-03-12 | **OOS Report PO Links** — Direct Finale PO links in blocking components | oos-email-trigger.ts | `0e310435` |
| 2026-03-11 | **Build Risk cron added** — was missing from `start()` | ops-manager.ts L552-557 | `7e529f0d` |
| 2026-03-11 | safeRun() added to StaleDraftPOAlert + APDailyRecap | ops-manager.ts | `7e529f0d` |
| 2026-03-11 | OOS report generator working | tmp/test-oos-report.ts | (manual) |
| 2026-03-10 | Auth module consolidated → google-oauth.ts | gmail/auth.ts | `2ec5322f` |
| 2026-03-10 | Dashboard approve/dismiss buttons fixed | InvoiceQueuePanel.tsx | `54aaba36` |
| 2026-03-10 | LLM provider chain: Gemini → OpenRouter fallback | llm.ts | `cb3694df` |

## Active Priorities

1. Sandbox folder watcher implementation
2. Receivings fetch error investigation (Finale API)
3. Prepayment invoice workflow testing (real emails)

## Updating This File

At task completion, add/update entries following the formats above.
Remove entries older than 14 days. Keep file under 60 lines total.
