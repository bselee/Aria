/**
 * @file    STATUS.md
 * @purpose Living operational state — updated at end of each agent session
 * @author  Will
 * @created 2026-03-11
 * @updated 2026-03-11
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

- **OOM on typecheck**: Combined 112-file compile exceeds 8GB heap. Use `typecheck:cli` for bot work. `next build` skips type-checking (`ignoreBuildErrors: true`).
- **Dropship logic removal in progress**: Started in conversation `064e1963`. Verify cleanup completion before adding new invoice routing.
- **Slack bot replies suppressed**: Fixed in conversation `6ea68fcd`. Bot must react-only, never reply in channels.
- **Gmail AP token not set up**: Will chose not to configure `ap-token.json` — suppress the startup error, don't attempt to fix.

## Recent Changes (last 7 days)

| Date | What Changed | Key Files | Conv ID |
|---|---|---|---|
| 2026-03-12 | **Inline Invoice Workflow** — Generates PDF from email bodies | inline-invoice-handler.ts | (this session) |
| 2026-03-11 | **Build Risk cron added** — was missing from `start()` | ops-manager.ts L552-557 | (this session) |
| 2026-03-11 | safeRun() added to StaleDraftPOAlert + APDailyRecap | ops-manager.ts | (this session) |
| 2026-03-11 | Agent coordination system created | docs/SYSTEM.md, docs/STATUS.md, all agent files | (this session) |
| 2026-03-11 | OOS report generator working | tmp/test-oos-report.ts | (manual) |
| 2026-03-11 | Tracking data debugging (MTD101/PO 124354) | ap-agent, OOS pipeline | `9d19ae26` |
| 2026-03-11 | Slack bot reply suppression | watchdog.ts | `6ea68fcd` |
| 2026-03-11 | Dropship logic removal (in progress) | ap-agent.ts, reconciler.ts | `064e1963` |
| 2026-03-11 | API health check — Gemini/OpenAI quotas dead | verified via script | `a04213bc` |
| 2026-03-11 | Sandbox folder watcher planned | sandbox-watcher.ts | `7faf181d` |
| 2026-03-11 | PO Gmail labels → hidden visibility | Gmail API | `d28b7190` |
| 2026-03-10 | Auth module consolidated → google-oauth.ts | gmail/auth.ts | `2ec5322f` |
| 2026-03-10 | Dashboard approve/dismiss buttons fixed | InvoiceQueuePanel.tsx | `54aaba36` |
| 2026-03-10 | Activity feed filtered (hide ads/junk) | ActivityFeed.tsx | `33bc85d3` |
| 2026-03-10 | TypeScript config split (tsconfig.cli.json) | tsconfig.json, tsconfig.cli.json | `69c87087` |
| 2026-03-10 | LLM provider chain: Gemini → OpenRouter fallback | llm.ts | `cb3694df` |

## Active Priorities

1. Complete dropship logic removal
2. Sandbox folder watcher implementation
3. Receivings fetch error investigation (Finale API)

## Updating This File

At task completion, add/update entries following the formats above.
Remove entries older than 14 days. Keep file under 60 lines total.
