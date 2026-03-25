# Shared Copilot Unification Design

**Goal:** Make Telegram and the dashboard behave like one cohesive copilot for normal Q&A, artifact interpretation, and shared operational context, while preserving channel-specific transactional UX such as Telegram approval buttons and PO review/send callbacks.

**Status:** Approved design as of 2026-03-25.

---

## Problem

Aria currently behaves like multiple assistants sharing a name:

- Telegram chat uses its own reasoning path, prompt assembly, tool registry, and artifact handling in [src/cli/start-bot.ts](/C:/Users/BuildASoil/Documents/Projects/aria/src/cli/start-bot.ts) and [src/cli/aria-tools.ts](/C:/Users/BuildASoil/Documents/Projects/aria/src/cli/aria-tools.ts).
- Dashboard chat uses a separate reasoning path and separate tool definitions in [src/app/api/dashboard/send/route.ts](/C:/Users/BuildASoil/Documents/Projects/aria/src/app/api/dashboard/send/route.ts).
- Telegram document uploads are handled, but Telegram photos are not first-class inputs in the shared chat path, which causes screenshot follow-up questions to lose context.
- PO review/send reliability is weakened by in-memory pending session state in [src/lib/purchasing/po-sender.ts](/C:/Users/BuildASoil/Documents/Projects/aria/src/lib/purchasing/po-sender.ts).

The result is inconsistent answers, lost conversational context, and operational workflows that feel disconnected instead of collaborative.

## Goals

- One shared copilot brain for normal Q&A from Telegram and dashboard.
- One shared context retrieval strategy.
- One shared tool registry for read behavior.
- One shared action service layer for writes.
- First-class support for artifacts across channels: text, photos, documents, uploads.
- Preserve Telegram-specific UI affordances like inline approval and PO send callbacks.
- Improve button workflow reliability across restart and stale-state scenarios.

## Non-Goals

- Rewriting the AP pipeline, OpsManager, or Slack watchdog in Phase 1.
- Fully unifying Slack behavior with Telegram/dashboard chat behavior.
- Replacing every channel-specific UX pattern with a generic abstraction.

---

## Architecture

Create a shared `copilot` layer under `src/lib/copilot/` that owns normal Q&A end to end:

- input normalization
- context retrieval
- prompt assembly
- provider chain invocation
- tool routing
- action gating
- final reply assembly

Telegram and dashboard become thin adapters:

- Telegram adapter: text messages, photo/document ingestion, callback/button rendering.
- Dashboard adapter: send endpoint, upload endpoint integration, chat mirror rendering.

Writes are explicitly separated from reasoning:

- Read path: direct tool calls for consumption, stock, purchase history, vendor lookup, PO status, build risk, screenshot interpretation, and similar questions.
- Write path: explicit action services for draft PO creation, review/send, approvals, dismissals, and future transactional workflows.

The copilot may reason about actions, but writes only occur through action services with explicit preconditions and structured results.

---

## Proposed Module Layout

### Create

- `src/lib/copilot/core.ts`
- `src/lib/copilot/context.ts`
- `src/lib/copilot/tools.ts`
- `src/lib/copilot/actions.ts`
- `src/lib/copilot/artifacts.ts`
- `src/lib/copilot/types.ts`
- `src/lib/copilot/channels/telegram.ts`
- `src/lib/copilot/channels/dashboard.ts`

### Modify

- `src/cli/start-bot.ts`
- `src/cli/aria-tools.ts`
- `src/app/api/dashboard/send/route.ts`
- `src/app/api/dashboard/upload/route.ts`
- `src/lib/purchasing/po-sender.ts`
- `src/lib/intelligence/chat-logger.ts`

### Persistence

- Extend current Supabase usage centered on `sys_chat_logs`.
- Add tables for shared artifact summaries and pending action sessions.
- Reuse existing recovery patterns from `pending_reconciliations` where appropriate.

---

## Context Retrieval Spec

`context.ts` is the core of “does Aria remember what I just sent.”

### Prompt Budget

- Target `8k-10k` input tokens for pre-tool context.
- Keep additional headroom for tool results and model response.
- The context assembler owns truncation, never the channel adapters.

### Always Include

- current user turn
- channel metadata
- bound artifact reference, if present
- bound action reference, if present

### Conversation Window

- Include the last `8` conversational turns from the same thread.
- Only include user/assistant messages, not raw system noise.
- Prefer newest turns verbatim.

### Artifact Window

- Include at most `3` artifact summaries.
- Always include the most recent artifact if the current turn is referential, such as “this,” “that screenshot,” “those items,” or “add these.”
- Include raw OCR text only for the current artifact or when the user explicitly asks for details from a prior artifact.

### Operational Reference Window

- Include at most `2` recent operational objects:
  - latest draft PO or PO review object
  - latest invoice/reconciliation object

### Oversize Handling

- If the assembled context exceeds the budget:
  - collapse older conversation into a rolling thread summary
  - keep recent turns verbatim
  - keep structured artifact summaries, not raw payloads

### Large PO History Rule

- Never inject raw large PO histories by default.
- Store compact PO reference summaries containing:
  - `orderId`
  - vendor
  - date
  - total
  - top line items
  - status
  - destination
- Only fetch raw line detail when the active question directly targets that PO.

---

## Artifact Model

All artifact inputs should normalize to the same structure regardless of channel:

- `artifactId`
- `threadId`
- `channel`
- `sourceType` (`telegram_photo`, `telegram_document`, `dashboard_upload`, etc.)
- `filename`
- `mimeType`
- `rawText`
- `summary`
- `structuredData`
- `tags`
- `createdAt`

### Summary Shape

Each artifact summary should contain:

- short human-readable description
- extracted entities
- action candidates
- object bindings, if any

Example:

- screenshot of ULINE cart
- vendor = `ULINE`
- candidate items = `[sku, qty, unit price]`
- candidate action = `add_to_existing_draft_po`

This lets the next turn bind to “these items” without relying on the model to remember a raw image transcript.

---

## Read And Write Rules

### Read Behavior

The default copilot mode is read-only.

Read tools are used for:

- consumption
- purchase history
- stock
- PO status
- invoice status
- vendor info
- build risk
- screenshot interpretation
- artifact inspection

### Write Preconditions

A write may execute only if both are true:

1. The user uses an explicit action verb.
2. The request is bound to a single concrete target.

Allowed explicit verbs include:

- create
- approve
- commit
- send
- dismiss
- add to PO
- update

Valid bindings include:

- direct IDs: `orderId`, `poNumber`, `approvalId`, `sendId`, `artifactId`
- exactly one resolved object from active context:
  - one draft PO
  - one recent artifact
  - one vendor/order candidate after lookup

If binding is missing or ambiguous:

- do not execute
- return `needs_confirmation`
- tell the user exactly what is missing

This replaces vague “intent confidence” language with testable execution rules.

---

## Action Service Contract

`actions.ts` should return structured results, not freeform prose.

### Read Tool Result Statuses

- `success`
- `no_result`
- `failed`
- `retryable`

### Action Result Statuses

- `success`
- `needs_confirmation`
- `failed`
- `partial_success`

### Required Fields

- `status`
- `userMessage`
- `logMessage`
- `retryAllowed`
- `safeToRetry`
- `actionRef`
- `details`

### Failure Rules

- Wrong read tool choice: the core may retry once with a better tool.
- Wrong write intent: do not execute if binding is ambiguous.
- No silent retries for writes unless the action is provably idempotent.
- Partial failures must be surfaced explicitly.

Example partial failure:

- draft PO committed in Finale
- vendor email failed
- return `partial_success`
- log the exact action boundary
- tell the user the PO commit succeeded and email failed

---

## Channel Adapter Responsibilities

### Telegram Adapter

- convert text messages to shared copilot requests
- ingest photos and documents as artifacts
- attach most recent relevant artifact to follow-up turns
- render callback buttons for approval and PO send flows
- translate stale callback states into clean user-visible recovery messages

### Dashboard Adapter

- convert `/api/dashboard/send` requests to shared copilot requests
- route uploads through shared artifact ingestion
- keep the existing UI and chat mirror semantics
- call the same action services for writes

Adapters should not own business reasoning or prompt logic.

---

## Reliability Improvements

### Screenshot Handling

Telegram photos must become first-class artifact inputs. This directly addresses the current screenshot loop failure.

### Pending Session Persistence

Pending PO send state should move from in-memory only storage in [src/lib/purchasing/po-sender.ts](/C:/Users/BuildASoil/Documents/Projects/aria/src/lib/purchasing/po-sender.ts) to durable storage with TTL and recovery metadata.

### Restart Recovery

Recovery must distinguish:

- warm in-process callback
- cold restart before callback
- stale original callback after restart
- expired pending session

Each case needs deterministic user-visible behavior.

---

## Slack Guardrail

Slack remains outside the shared copilot migration in Phase 1, but the refactor must not break existing behavior.

Rules:

- Do not route Slack watchdog logic through the shared copilot initially.
- Only extract read-only utilities that do not change Slack execution semantics.
- After each phase deploy, run a smoke assertion that Slack watchdog startup reaches one of:
  - `running/connected`
  - `disabled by config`
- Silent startup failure is unacceptable.

This prevents a refactor of Telegram/dashboard from quietly breaking Slack alerting.

---

## Testing Strategy

### Unit

- context assembly budget enforcement
- artifact selection rules
- write precondition gating
- action result status handling

### Integration

- same normal Q&A input yields the same answer path from Telegram and dashboard
- screenshot follow-up questions bind to the correct artifact
- draft PO creation flows through shared action services

### Recovery

- pending PO send survives restart via durable session state
- stale Telegram callback fails cleanly
- restored recovery path produces actionable follow-up guidance

### Smoke

- Telegram bot boot path still starts
- dashboard send route still responds
- Slack watchdog still starts or reports explicit disabled state

---

## Phase Plan

### Phase 1

- create shared core, tools, context, and types
- route Telegram text and dashboard send through the shared read path
- keep transactional UX wrappers in place
- begin deleting duplicated prompt/tool logic as parity is reached

### Phase 2

- unify artifact ingestion for Telegram photos, Telegram documents, and dashboard uploads
- store artifact summaries and bind follow-up turns to artifacts
- delete split artifact reasoning paths once shared flow is stable

### Phase 3

- unify transactional action services
- persist pending PO send/review state
- migrate Telegram callback handling and dashboard action endpoints to shared action services
- delete duplicate transactional glue after parity

There is no separate cleanup graveyard phase. Cleanup is part of each implementation phase.

---

## Success Criteria

- “consumption for SKU X” works the same from Telegram and dashboard
- screenshot follow-ups use the screenshot context instead of drifting
- draft PO creation works from both Telegram and dashboard through one backend path
- PO review/send flows fail cleanly or recover after restart
- Slack watchdog still starts successfully after each phase deploy

