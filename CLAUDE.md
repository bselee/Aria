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

# After any code change to the bot:
npx tsc --noEmit 2>&1 | grep -v "finale/client.ts"   # client.ts has pre-existing errors — ignore them
pm2 restart aria-bot

# Test/probe scripts (run directly with tsx)
node --import tsx src/cli/test-finale.ts
node --import tsx src/cli/test-bom.ts
node --import tsx src/cli/test-calendar-builds.ts
node --import tsx src/cli/test-ap-routing.ts
node --import tsx src/cli/verify-tools.ts
node --import tsx src/cli/run-ap-pipeline.ts       # Manually trigger AP pipeline against real Gmail invoice
node --import tsx src/test/test-ap-agent-live.ts   # Live AP agent test
```

All scripts load `.env.local` via `dotenv.config({ path: '.env.local' })` at startup. PM2 does NOT use env_file — `.env.local` is loaded inside each script.

## Architecture

### Path Alias
`@/*` maps to `src/*` (configured in tsconfig.json).

### LLM Usage — Two Separate Paths

**1. Structured generation (most modules):** `unifiedTextGeneration()` and `unifiedObjectGeneration()` in `src/lib/intelligence/llm.ts`. Primary: **Claude claude-3-5-sonnet-20241022** via Vercel AI SDK. Fallback: **GPT-4o**. Use these for any new structured extraction or classification work.

**2. Bot conversation handler (`start-bot.ts`):** Calls **OpenAI GPT-4o directly** with `tool_calls` for the interactive chat loop. `unifiedTextGeneration` is only used as a fallback there. When adding new bot tools, follow the existing OpenAI tool-call schema in `start-bot.ts`, not the llm.ts wrappers.

Raw SDK access: `src/lib/anthropic.ts` exports a lazy-init `getAnthropicClient()` singleton — use this if you ever need a direct Anthropic client. `src/lib/github/client.ts` and `src/lib/vendors/enricher.ts` currently bypass this and call `new Anthropic()` directly — fix them when touching those files.

**Dashboard exception:** `src/app/api/dashboard/chat/route.ts` uses **Gemini 2.5 Flash** (`@ai-sdk/google`) — completely separate from the Telegram bot stack. Requires `GOOGLE_GENERATIVE_AI_API_KEY`.

### In-Memory State Warning
Both `reconciler.ts` (`pendingApprovals`, 24h TTL) and `dropship-store.ts` (`pendingDropships`, 48h TTL) use in-memory Maps. **`pm2 restart aria-bot` silently drops all pending Telegram approval requests.** There is no persistence layer for these — they are intentionally ephemeral.

### Gmail Multi-Account Tokens
`getAuthenticatedClient(slot)` in `src/lib/gmail/auth.ts` maps token slots to files:
- `"ap"` → `ap-token.json` (ap@buildasoil.com — incoming invoices)
- `"default"` → `token.json` (bill.selee@buildasoil.com — outgoing POs, used by po-correlator)

Run `src/cli/gmail-auth.ts` with the appropriate slot to generate/refresh tokens.

### Key Modules

| Path | Purpose |
|------|---------|
| `src/config/persona.ts` | Central personality/system prompt config — edit here to change Aria's tone everywhere |
| `src/lib/intelligence/ops-manager.ts` | Cron scheduler: 7:30 AM build risk, 8:00 AM daily summary, 8:01 AM Friday weekly, AP invoice polling every 15 min |
| `src/lib/intelligence/ap-agent.ts` | Monitors `ap@buildasoil.com` Gmail inbox, classifies emails (INVOICE/STATEMENT/ADVERTISEMENT/HUMAN_INTERACTION), parses PDFs, matches to POs, forwards invoices to `buildasoilap@bill.com`, and runs the reconciliation pipeline |
| `src/lib/finale/reconciler.ts` | Invoice→PO reconciliation engine. Compares parsed invoice data against Finale PO, applies safety guardrails, and either auto-applies changes or queues them for Telegram approval (in-memory, 24h TTL) |
| `src/lib/intelligence/build-parser.ts` | LLM parses Google Calendar events to extract builds/BOMs |
| `src/lib/builds/build-risk.ts` | Calendar BOM risk engine — queries Finale for component stock/PO status, emits CRITICAL/WARNING/WATCH/OK per component |
| `src/lib/slack/watchdog.ts` | Polls Slack every 60s; monitors DMs + `#purchase`/`#purchase-orders` only; reacts with 👀; never posts in Slack |
| `src/lib/finale/client.ts` | Finale Inventory REST API client. SKU lookups, BOM consumption, stock data. **Has pre-existing TypeScript errors — do not attempt to fix them.** |
| `src/lib/gmail/auth.ts` + `attachment-handler.ts` | OAuth2 Gmail client (multi-account); downloads PDF attachments for processing |
| `src/lib/google/calendar.ts` | Google Calendar API client (separate OAuth token from Gmail) |
| `src/lib/pdf/` | extractor, classifier, invoice-parser, po-parser, bol-parser, statement-parser, editor |
| `src/lib/matching/invoice-po-matcher.ts` | Invoice ↔ PO matching with discrepancy detection |
| `src/lib/supabase.ts` | Singleton Supabase client (lazy init — returns null if env vars missing) |
| `src/lib/anthropic.ts` | Lazy-init Anthropic singleton (`getAnthropicClient()`) — the correct escape hatch for direct SDK access |
| `src/lib/intelligence/pinecone.ts` | Pinecone vector store for operational context + deduplication state (index: `gravity-memory`, 1024d, namespace: `aria-memory`) |
| `src/lib/intelligence/vendor-memory.ts` | Vendor document handling patterns in Pinecone (namespace: `vendor-memory`). Stores how each vendor sends docs. `seedKnownVendorPatterns()` called on boot. |
| `src/lib/intelligence/dropship-store.ts` | In-memory store (48h TTL) for unmatched invoices pending dropship forwarding. Bot's `dropship_fwd_*` callbacks retrieve from here. Lost on restart. |
| `src/lib/intelligence/po-correlator.ts` | Cross-inbox correlation: reads outgoing PO emails from `bill.selee@buildasoil.com` (label:PO), correlates with incoming invoices, builds vendor communication profiles (saved to `vendor_profiles` table) |
| `src/lib/github/client.ts` | GitHub integration via Octokit: creates issues for document discrepancies, syncs issue state to Supabase, processes PR PDF uploads. Env: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` |
| `src/lib/vendors/enricher.ts` | Web-enriches vendor records via Firecrawl (payment portals, AR emails, remit addresses) and computes vendor spend stats. Env: `FIRECRAWL_API_KEY` |
| `src/app/api/webhooks/github/route.ts` | GitHub webhook handler: processes PDFs in new PRs, marks documents ARCHIVED when issues close |
| `src/app/dashboard/` | Next.js command terminal UI for Will. Chat backed by Gemini 2.5 Flash — separate from the Telegram bot stack. |

### AP Invoice Pipeline
When an invoice arrives at `ap@buildasoil.com`, the AP agent does two independent things:
1. **Forwards** the raw email to `buildasoilap@bill.com` immediately (bill.com handles payment)
2. **Reconciles** against Finale: parses the PDF → matches to a Finale PO → runs `reconcileInvoiceToPO()` → auto-applies safe changes or sends a Telegram approval request

If no PO match is found, the invoice is stored in the dropship store (`dropship-store.ts`, 48h TTL) and Will is notified via Telegram to forward it manually via the `dropship_fwd_*` callback.

Reconciliation safety thresholds (defined in `reconciler.ts`, do not change without Will's input):
- **≤3% price change** → auto-approve and apply
- **>3% but <10× magnitude** → flag for Telegram bot approval before applying
- **≥10× magnitude shift** → REJECT outright (OCR/decimal error)
- **Total PO impact >$500** → require manual approval regardless of per-line %

### Finale Write Pattern
All Finale PO mutations use **GET → Modify → POST**. If the PO status is `ORDER_LOCKED`, call `actionUrlEdit` first to unlock it, then re-fetch, modify, and POST. See `FinaleClient.addOrderAdjustment()` and `updateOrderItemPrice()`.

Finale fee types map to `productpromo` IDs: FREIGHT=10007, TAX=10008, TARIFF=10014, LABOR=10016, SHIPPING=10017. These feed into landed cost automatically.

### Database Schema (Supabase)
Key tables: `documents`, `vendors`, `vendor_profiles`, `invoices`, `purchase_orders`, `shipments`, `ap_activity_log`. See `supabase/migrations/` for schema. Recent additions to `invoices`: `tariff NUMERIC(12,2)`, `labor NUMERIC(12,2)`, `tracking_numbers TEXT[]` (GIN-indexed for overlap queries).

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
SLACK_ACCESS_TOKEN            # Will's user token (for 👀 reactions)
SLACK_BOT_TOKEN               # Bot token (for posting to #purchasing)
SLACK_OWNER_USER_ID           # Will's Slack user ID (skip his own messages)
SLACK_MORNING_CHANNEL         # Default: #purchasing
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
FINALE_API_KEY
FINALE_API_SECRET
FINALE_ACCOUNT_PATH
FINALE_BASE_URL
PINECONE_API_KEY
PINECONE_INDEX                # Default: gravity-memory
ELEVENLABS_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_GENERATIVE_AI_API_KEY  # Gemini — used by src/app/api/dashboard/chat/route.ts only
GITHUB_TOKEN                  # GitHub API token (issue creation, PR processing)
GITHUB_OWNER                  # GitHub repo owner
GITHUB_REPO                   # GitHub repo name
FIRECRAWL_API_KEY             # Vendor web enrichment
PERPLEXITY_API_KEY            # Optional
```

Google OAuth tokens are stored in `token.json` (bill.selee — default slot) and `ap-token.json` (ap@buildasoil.com — ap slot) and `calendar-token.json` (Calendar). Run `src/cli/gmail-auth.ts` or `src/cli/calendar-auth.ts` to generate them.
