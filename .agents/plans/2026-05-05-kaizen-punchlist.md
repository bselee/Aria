# Aria Kaizen Punchlist — 2026-05-05

> Synthesized from four parallel audits (LLM token usage, scheduled work, agent/skill catalog, Finale+DB call patterns). De-duplicated; ranked by ROI; cross-cutting patterns surfaced first because that's where the real kaizen lives.

---

## Cross-cutting patterns (the meta-findings)

The same 4 patterns drove most of the waste across all four audits. Fix the **pattern** once and ~half the punchlist disappears.

### P1 — Static system prompts re-sent every call, no `cache_control`
Anthropic supports prompt caching with a single `cache_control: { type: "ephemeral" }` header on the system block. ~90% input-cost reduction on cache hits. Aria has at least 5 hot paths re-sending the same multi-hundred-token system prompt every call:

- `INVOICE_SYSTEM_PROMPT` (~835 tokens) in [src/lib/pdf/invoice-parser.ts](src/lib/pdf/invoice-parser.ts#L57-L90)
- `SCANNED_PDF_SYSTEM` + `SCANNED_PDF_PROMPT` (~240 tokens) in [src/lib/pdf/extractor.ts](src/lib/pdf/extractor.ts#L116-L117)
- File-upload analyzer system (~800 tokens) in [src/cli/start-bot.ts](src/cli/start-bot.ts#L442-L464)
- Nightshift classification prompt (~200 tokens) in [src/lib/intelligence/nightshift-agent.ts](src/lib/intelligence/nightshift-agent.ts#L105-L123)
- Dashboard chat (~120 tokens) in [src/app/api/dashboard/chat/route.ts](src/app/api/dashboard/chat/route.ts#L10-L20)

**One fix:** add a `cacheControl: "ephemeral"` flag to `unifiedTextGeneration` / `unifiedObjectGeneration` in [llm.ts](src/lib/intelligence/llm.ts), default-on for system blocks > 200 tokens. Then every caller benefits without each callsite remembering. Matches Will's "centralize cross-cutting concerns" rule.

### P2 — Loop-then-fetch instead of pre-warm-then-loop
We repeatedly do `for (item of N) { await lookup(item.vendor) }` when the same vendor appears across many items. The cache prevents re-fetch but doesn't prevent the await chain. Three live offenders:

- Per-PO lead-time in [active-purchases.ts:135](src/lib/purchasing/active-purchases.ts#L135) — 100 POs × 5 vendors = 95 redundant awaits
- Per-SKU `getDistribution(vendor)` inside [getPurchasingIntelligence](src/lib/finale/client.ts#L4933) worker loop — up to 580 redundant awaits
- Per-SKU `resolveParty(supplierUrl)` in [client.ts:4803-4827](src/lib/finale/client.ts#L4803-L4827) — 50–120 cache misses per run

**One fix:** in each, do `const vendors = new Set(items.map(...)); await Promise.all([...vendors].map(warm))` *before* the item loop. Then the item loop is pure cache hits.

### P3 — Polling crons where on-demand or event-driven would do
Will's already-flagged preference: on-demand commands beat date-pinned crons. Audit found six:

- POSync every 30 min (re-walks 45d Gmail) → drop to 4h or trigger from APPolling
- POSweep every 4h (triple-fetches Gmail threads) → fold into APPolling post-processing
- CloseFinishedTasks every 5 min, mostly closes 0 rows → 30 min, or close-on-write
- StatIndexing hourly Pinecone re-index → trigger on data change
- BuildCompletionWatcher + POReceivingWatcher overlap → merge into one PollFinaleCompletions
- DailySummary is a stub that emits AP-only → either implement fully or replace with `/summary` command

### P4 — Redundant LLM passes (Haiku pre-class → Sonnet re-class)
Nightshift Haiku pre-classifies emails overnight at ~$0 cost. Morning APIdentifier still calls Sonnet for many of them — the pre-classification is checked but only a narrow path uses it.

**Concrete:** [ap-agent.ts:228-274](src/lib/intelligence/ap-agent.ts#L228-L274) and [ap-identifier.ts:140-178](src/lib/intelligence/workers/ap-identifier.ts#L140-L178). When `getPreClassification()` returns ≥0.7 confidence, take it. Only fall back to Sonnet on low-confidence or missing rows. Eliminates ~50% of daytime Sonnet calls (~$0.24/day).

---

## Top 12 concrete actions, ranked

| # | Action | Pattern | Files | Effort | ROI |
|---|---|---|---|---|---|
| **1** | **Add `cacheControl` to `unifiedTextGeneration`/`unifiedObjectGeneration` and enable on the 5 hot paths above** | P1 | `llm.ts` + 5 callsites | Small | **Highest** — ~90% input-cost reduction on every recurring LLM call. Touches every other audit finding. |
| **2** | **Pre-warm vendor caches once, then iterate SKUs** in `active-purchases.ts` (lead-time), `getPurchasingIntelligence` (distribution + party) | P2 | 2 files | Small | -50–80 sequential awaits per run · -29-58s dashboard latency |
| **3** | **Honor nightshift pre-classification** in APIdentifier — skip Sonnet when conf ≥ 0.7 | P4 | `ap-identifier.ts` + `ap-agent.ts` | Small | -50% Sonnet calls/day (~$0.24/day) |
| **4** | **Reduce POSync from 30min → 4h** (vendor PO emails rarely change in <6h) | P3 | `ops-manager.ts:474` | Trivial | -96 Gmail polls/day |
| **5** | **Fold POSweep into APPolling post-pass**; delete the 4h cron | P3 | `ops-manager.ts:487` | Small | Eliminates triple-fetch of Gmail threads |
| **6** | **Make MissingReconciliationWatchdog Mon–Fri-aware** (false-positives every weekend currently) | silent fail | `ops-manager.ts:524` | Trivial | Stops the false-alarm Telegrams Will already learned to ignore |
| **7** | **Batch Supabase fetches in `active-purchases.ts:49-77`** with `Promise.all` (purchase_orders + po_sends + shipments) | P2 (DB variant) | 1 file | Small | -100-200ms latency/refresh |
| **8** | **PDF base64 cache in extractor cascade** (extract once, pass through 4 strategies; don't re-encode) | P1 (input bloat) | `extractor.ts:131-156` | Small | -400-600 tokens per failed retry; -300ms latency |
| **9** | **Batch-update `backfillPOSentVerificationFromGmail`** (currently 100 SELECT + 100 UPSERT for 50 records) | P2 (DB variant) | `po-correlator.ts:310-396` | Medium | -98% Supabase calls on backfills |
| **10** | **Dedupe agent scope: merge `pdf-pipeline` into `ap-pipeline`** as an "Extraction Layer" subsection | catalog | `.claude/agents/`, `.agents/agents/` | Small | One agent to reach for instead of two with overlap |
| **11** | **Delete `.agent/skills/firecrawl/` (orphaned duplicate of `.agents/skills/firecrawl/`)** | catalog | filesystem | Trivial | Cuts ambiguity about which file is canonical |
| **12** | **DailySummary: implement or delete.** Currently emits only AP-block stub. Replace with `/summary` command. | P3 | `ops-manager.ts:449` | Medium | Closes a feedback channel that's been silently broken |

---

## Deferred bucket (track but don't burn time on)

These are real but each saves <$0.10/day or <100ms/run. Worth doing during incidental edits in those files but not worth a dedicated PR.

- StatIndexing hourly Pinecone re-index → trigger on write (medium effort, low cost)
- IssueOrchestrator gated `ISSUE_ORCHESTRATOR_ENABLED=true` and disabled — decide enable vs delete
- VendorEnricher (`enricher.ts`) bypasses lazy `getAnthropicClient()` singleton — clean up next time you touch
- Github client (`github/client.ts`) bypasses lazy singleton — same treatment
- Reconciliation jobs swallow stderr (no supervisor escalation) — wire into supervisor when next a vendor reconciler breaks
- BotTools agent description bloated with cross-domain content already covered by finale-ops/build-risk/reorder agents → trim 30%
- 5 vendor reconciliation workflows (~250 lines each) duplicate `reconcile-vendor-po.md` template — flatten on next reconciler edit
- `getProductActivity` GraphQL fetches `stockAvailable` no caller reads — drop next time you touch the query
- Per-PDF Supabase `.eq("gmail_message_id", id).single()` runs once per PDF; same email gets N queries — fetch once, reuse (most emails have 1 PDF, low impact)
- `agent_task` table indexes — verify in next migration that `po_number_idx` exists on `purchase_orders` (assumed but not verified)

---

## What this is NOT addressing

- **`finale/client.ts` pre-existing TypeScript errors** — CLAUDE.md explicitly rules these out of scope. Audit confirmed the rule is still load-bearing.
- **`getPurchasingIntelligence` core efficiency rules** (3 workers, 100ms throttle, 429 backoff, product filter, combined GraphQL aliases) — verified intact, no regression.
- **Calibration loop precision** — already fixed today.
- **Recommender formula version + bumping** — kaizen lever exists in `qty-recommender.ts:formulaVersion`, just hasn't fired since v2.0-calibrated.

---

## Suggested order of operations

1. **Ship #1 (cacheControl) first.** It's the single highest-leverage change and unblocks measurement of every other LLM-related fix.
2. **Then #3 (honor nightshift pre-class)** — independent, cheapest, biggest visible cost drop.
3. **Then #2 + #7 (batch-then-loop)** — both small, both visible in dashboard latency.
4. **Then #4, #5, #6** — three trivial cron edits in one PR.
5. **Then #8 (PDF cascade)** — touches a delicate path; verify on a sample invoice.
6. **#9 + #10 + #11 + #12** as one "hygiene PR" when energy is right.

Total target effort: ~1.5 dev-days for items 1–8, half a day for 9–12. Saves an estimated **$8–12/month in API costs**, **~30s/dashboard refresh**, and removes 4 false-alarm Telegram channels. More importantly: surfaces the **cross-cutting patterns** so future similar mistakes get caught structurally rather than in another audit.

---

## Kaizen meta-rule (for next time)

When the same waste pattern appears in 3+ files, fix the **shared abstraction**, not each callsite. Aria has `unifiedTextGeneration` and `leadTimeService.warmCache` already — both were *meant* to be the central concern but callsites bypass or under-use them. The pattern: a centralization that exists is necessary but not sufficient — also need it to be the *easy default*, not a thing each callsite must remember.
