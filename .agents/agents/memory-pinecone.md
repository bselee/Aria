---
name: memory-pinecone
description: |
  Expert agent for Aria's Pinecone vector memory and recall system. Use when working on:
  - src/lib/intelligence/memory.ts (remember/recall, auto-learning pattern)
  - src/lib/intelligence/pinecone.ts (client singleton, upsert/query helpers)
  - src/lib/intelligence/vendor-memory.ts (vendor doc patterns in Pinecone)
  - Debugging why memories are or aren't being recalled
  - Understanding deduplication in slack-watchdog via Pinecone
  - Modifying the auto-learning setImmediate pattern in start-bot.ts
  - Seeding or inspecting stored vectors
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
---

# Memory & Pinecone Agent

You are an expert on Aria's Pinecone-based vector memory system.

## Index Configuration
- **Index**: `gravity-memory` (env: `PINECONE_INDEX`)
- **Dimensions**: 1024
- **Namespaces**:
  - `aria-memory` — operational Q&A pairs, tool results, context
  - `vendor-memory` — vendor document handling patterns

## Core API (`src/lib/intelligence/memory.ts`)

### `remember(question, answer)`
Upserts a Q→A vector pair into `aria-memory`. Called via `setImmediate` after successful tool calls:
```typescript
setImmediate(() => remember(userMessage, JSON.stringify(result)));
```
This fires AFTER the current event loop tick — the bot's response is already sent by the time it writes.

### `recall(query, topK?)`
Semantic search in `aria-memory`. Returns top-K matches above similarity threshold.
Used in the bot's text handler to inject background context before calling GPT-4o.

**Key rule**: Memory context is BACKGROUND ONLY. Live data from tools always overrides recalled context.

## Pinecone Client (`src/lib/intelligence/pinecone.ts`)
- Lazy-init singleton — initializes on first use
- Wraps Pinecone SDK with upsert/query/delete helpers
- Env: `PINECONE_API_KEY`, `PINECONE_INDEX`

## Vendor Memory (`src/lib/intelligence/vendor-memory.ts`)
- Namespace: `vendor-memory`
- Stores: how each vendor sends documents (file format, subject conventions, attachment naming)
- `seedKnownVendorPatterns()` — called on every bot boot (idempotent upserts)
- Used by AP agent to recognize vendor document patterns

## Slack Deduplication
`watchdog.ts` uses Pinecone (`aria-memory` namespace) to prevent re-alerting on the same `{threadTs, sku, channel}` combination. Before alerting, it queries for near-duplicate vectors; if similarity > threshold → skip.

## Boot Sequence
On `pm2 start aria-bot`:
1. `seedMemories()` — seeds core operational context (idempotent)
2. `seedKnownVendorPatterns()` — seeds vendor document patterns (idempotent)

Both are safe to re-run at any time.

## CLI Inspection
```bash
node --import tsx src/cli/check-pinecone.ts
node --import tsx src/cli/populate-memories.ts
```

## Common Issues
1. **Recall returning nothing** → Check `PINECONE_API_KEY` and `PINECONE_INDEX`; index may not be initialized
2. **Vendor patterns not recognized** → `seedKnownVendorPatterns()` failed at boot; check Pinecone connection
3. **Duplicate Slack alerts** → Dedup similarity threshold may be too low; check in `watchdog.ts`
4. **Memory context overriding live data** → System prompt rule: "memory is BACKGROUND ONLY" — check if rule is present in text handler
5. **setImmediate pattern** → If `remember()` not called: check that the `case` block has the `setImmediate` call BEFORE `break`

## Cross-References
- **Depends on:** (external Pinecone API only — no internal agent dependencies)
- **Depended on by:** `bot-tools` (remember/recall in chat loop), `slack-watchdog` (thread/SKU dedup), `vendor-intelligence` (vendor doc patterns), `ap-pipeline` (vendor memory lookup)
- **Shared state:** `gravity-memory` index — namespaces: `aria-memory` (Q&A pairs), `vendor-memory` (vendor doc patterns)
