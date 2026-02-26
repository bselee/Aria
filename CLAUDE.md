# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Aria** — Will's personal operations assistant for BuildASoil (living soil / organic growing supply company). It's a Next.js app that runs two long-lived background processes:

1. **Telegram Bot** (`aria-bot`) — Command handler with an LLM brain (Claude → OpenAI fallback). Handles document uploads, inventory lookups, purchasing commands, and daily/weekly ops summaries.
2. **Slack Watchdog** (`aria-slack`) — Silent monitor that polls specific Slack channels for product/purchasing requests, fuzzy-matches against known SKUs, and reports to Will via Telegram.

The Next.js app layer is largely scaffolding; the real logic lives in `src/cli/` and `src/lib/`.

## Commands

```bash
# Development
npm run dev           # Next.js dev server
npm run build         # Next.js build
npm run lint          # ESLint

# Run individual CLI scripts (TypeScript via tsx)
node --import tsx src/cli/start-bot.ts        # Start Telegram bot
node --import tsx src/cli/start-slack.ts      # Start Slack watchdog

# PM2 process management (production)
pm2 start ecosystem.config.cjs                # Start both services
pm2 start ecosystem.config.cjs --only aria-bot
pm2 start ecosystem.config.cjs --only aria-slack
pm2 logs              # Tail all logs
pm2 monit             # Real-time dashboard
pm2 save              # Persist process list
pm2 startup           # Generate OS startup script

# Test/probe scripts (run directly with tsx)
node --import tsx src/cli/test-finale.ts
node --import tsx src/cli/test-bom.ts
node --import tsx src/cli/test-calendar-builds.ts
node --import tsx src/cli/test-ap-routing.ts
node --import tsx src/cli/verify-tools.ts
```

All scripts load `.env.local` via `dotenv.config({ path: '.env.local' })` at startup. PM2 does NOT use env_file — `.env.local` is loaded inside each script.

## Architecture

### Path Alias
`@/*` maps to `src/*` (configured in tsconfig.json).

### Core LLM Layer (`src/lib/intelligence/llm.ts`)
All LLM calls go through `unifiedTextGeneration()` and `unifiedObjectGeneration()`. Primary: **Claude claude-3-5-sonnet-20241022** via Vercel AI SDK. Fallback: **GPT-4o**. Always use these wrappers — never call Anthropic/OpenAI SDKs directly.

### Key Modules

| Path | Purpose |
|------|---------|
| `src/config/persona.ts` | Central personality/system prompt config — edit here to change Aria's tone everywhere |
| `src/lib/intelligence/ops-manager.ts` | Cron scheduler: 7:30 AM build risk, 8:00 AM daily summary, 8:01 AM Friday weekly, AP invoice polling every 15 min |
| `src/lib/intelligence/ap-agent.ts` | Monitors `ap@buildasoil.com` Gmail inbox, classifies emails (INVOICE/STATEMENT/ADVERTISEMENT/HUMAN_INTERACTION), parses PDFs, matches to POs |
| `src/lib/intelligence/build-parser.ts` | LLM parses Google Calendar events to extract builds/BOMs |
| `src/lib/builds/build-risk.ts` | Calendar BOM risk engine — queries Finale for component stock/PO status, emits CRITICAL/WARNING/WATCH/OK per component |
| `src/lib/slack/watchdog.ts` | Polls Slack every 60s; monitors DMs + `#purchase`/`#purchase-orders` only; reacts with 👀; never posts in Slack |
| `src/lib/finale/client.ts` | Finale Inventory REST API client. SKU lookups, BOM consumption, stock data. Env: `FINALE_API_KEY`, `FINALE_API_SECRET`, `FINALE_ACCOUNT_PATH` |
| `src/lib/gmail/auth.ts` + `attachment-handler.ts` | OAuth2 Gmail client; downloads PDF attachments for processing |
| `src/lib/google/calendar.ts` | Google Calendar API client (separate OAuth token from Gmail) |
| `src/lib/pdf/` | extractor, classifier, invoice-parser, po-parser, bol-parser, statement-parser, editor |
| `src/lib/matching/invoice-po-matcher.ts` | Invoice ↔ PO matching with discrepancy detection |
| `src/lib/supabase.ts` | Singleton Supabase client (lazy init — returns null if env vars missing) |
| `src/lib/intelligence/pinecone.ts` | Pinecone vector store for operational context + deduplication state (index: `gravity-memory`, 1024d) |

### Database Schema (Supabase)
Key tables: `documents`, `vendors`, `invoices`, `purchase_orders`, `shipments`. See `migrations/001_documents.sql` for full schema.

### Slack Watchdog Behavior
- **Eyes-only mode** — Aria NEVER posts in Slack. The only Slack action is adding a 👀 reaction using Will's user token (`SLACK_ACCESS_TOKEN`).
- Skip owner messages: `SLACK_OWNER_USER_ID` filters out Will's own messages.
- Pinecone deduplication prevents re-alerting on the same thread/SKU combination.
- Product catalog built from last 100 POs in Supabase, refreshed every 30 min.

### Cron Schedule (OpsManager, America/Denver timezone)
- `7:30 AM Mon-Fri` — Build risk analysis (Telegram + Slack #purchasing)
- `8:00 AM daily` — Daily PO/invoice/email summary
- `8:01 AM Fridays` — Weekly summary
- `Every 15 min` — AP inbox invoice check
- `Hourly` — Advertisement cleanup
- `Every 30 min` — PO conversation sync

## Required Environment Variables (`.env.local`)

```
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
ANTHROPIC_API_KEY
OPENAI_API_KEY
SLACK_ACCESS_TOKEN       # Will's user token (for 👀 reactions)
SLACK_BOT_TOKEN          # Bot token (for posting to #purchasing)
SLACK_OWNER_USER_ID      # Will's Slack user ID (skip his own messages)
SLACK_MORNING_CHANNEL    # Default: #purchasing
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
FINALE_API_KEY
FINALE_API_SECRET
FINALE_ACCOUNT_PATH
FINALE_BASE_URL
PINECONE_API_KEY
PINECONE_INDEX           # Default: gravity-memory
ELEVENLABS_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
PERPLEXITY_API_KEY       # Optional
```

Google OAuth tokens are stored in `token.json` (Gmail) and `calendar-token.json` (Calendar). Run `src/cli/gmail-auth.ts` or `src/cli/calendar-auth.ts` to generate them.
