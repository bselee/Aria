# Aria Project Context — Roo

Will's personal ops assistant for BuildASoil. Full architecture: see `CLAUDE.md`.

## Non-Negotiable Rules

1. **`src/lib/finale/client.ts` — pre-existing TS errors. DO NOT fix.**
   - Typecheck: `npx tsc --noEmit 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator"`

2. **After any bot change**: typecheck → `pm2 restart aria-bot`
   - Restart drops `pendingApprovals` (24h) and `pendingDropships` (48h) — ephemeral by design

3. **Two LLM paths:**
   - `start-bot.ts` → OpenAI GPT-4o with `tool_calls`
   - All lib modules → `unifiedTextGeneration()` in `src/lib/intelligence/llm.ts`
   - Dashboard chat → Gemini 2.5 Flash (`@ai-sdk/google`)

4. **Finale writes: GET → Modify → POST** | Unlock `ORDER_LOCKED` via `actionUrlEdit` first
   Fee IDs: FREIGHT=10007 TAX=10008 TARIFF=10014 LABOR=10016 SHIPPING=10017

5. **Slack = eyes-only.** Only 👀 reactions. Never post.

6. **Anthropic SDK**: `getAnthropicClient()` from `src/lib/anthropic.ts` — not `new Anthropic()`

## AP Reconciliation Thresholds (do NOT change without Will)
≤3% auto | >3%<10× Telegram approval | ≥10× REJECT | >$500 manual

## Key Files
```
src/cli/start-bot.ts                 # Telegram bot entry + all tools
src/lib/intelligence/ap-agent.ts     # AP invoice pipeline
src/lib/intelligence/ops-manager.ts  # Cron (America/Denver)
src/lib/intelligence/llm.ts          # Unified LLM wrapper
src/lib/intelligence/memory.ts       # Pinecone memory
src/lib/finale/client.ts             # Finale REST API
src/lib/finale/reconciler.ts         # Reconciliation engine
src/lib/builds/build-risk.ts         # CRITICAL/WARNING/WATCH/OK
src/lib/pdf/                         # OCR + parsing
src/config/persona.ts                # Aria personality
src/app/api/dashboard/purchasing/route.ts  # Purchasing intelligence (30-min cache)
src/components/dashboard/PurchasingPanel.tsx  # Velocity/runway/urgency/snooze panel
```

## Finale API Efficiency Rules
- **3 concurrent workers max**; **100ms pause** between SKUs
- **Product filter** on all per-SKU `orderViewConnection` queries
- **Combined GraphQL aliases** (receipts + shipments + open POs = 1 request)
- **REST-first exclusion**: `isManufactured`/`isDropship` check before GraphQL
- **429 backoff**: 5s + single retry

## Dropship Exclusions
Autopot, Printful, Grand Master, HLG, Evergreen, AC Infinity — silently skipped in both panels.
`resolveParty()` regex: `/autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i`
