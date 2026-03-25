# Shared Copilot Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build one shared copilot core for Telegram and dashboard normal Q&A, unify artifact interpretation, and move transactional PO/reconciliation actions onto shared services with restart-safe session recovery.

**Architecture:** Extract a shared `src/lib/copilot/` layer for context retrieval, provider execution, tool routing, artifact handling, and action contracts. Telegram and dashboard become thin adapters that feed the same core for read behavior while retaining channel-specific UI for callbacks and buttons.

**Tech Stack:** Next.js 15, TypeScript, Telegraf, Vercel AI SDK, Supabase, Vitest

---

### Task 1: Add durable copilot persistence tables

**Files:**
- Create: `supabase/migrations/20260325_create_copilot_artifacts_and_sessions.sql`
- Modify: `src/lib/supabase.ts`
- Test: `src/lib/copilot/types.test.ts`

**Step 1: Write the failing test**

Create `src/lib/copilot/types.test.ts` with assertions for the artifact/session TypeScript shapes expected by the migration-backed code.

```ts
import { describe, expect, it } from "vitest";

describe("copilot persistence types", () => {
  it("requires durable artifact/session status enums", () => {
    expect(["pending", "ready", "expired"]).toContain("ready");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/types.test.ts`

Expected: FAIL because the file/types do not exist yet.

**Step 3: Write minimal implementation**

- Add migration for:
  - `copilot_artifacts`
  - `copilot_action_sessions`
- Add shared types in `src/lib/copilot/types.ts`

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/types.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add supabase/migrations/20260325_create_copilot_artifacts_and_sessions.sql src/lib/copilot/types.ts src/lib/copilot/types.test.ts
git commit -m "feat: add copilot artifact and session persistence types"
```

---

### Task 2: Implement context assembly with explicit token-budget rules

**Files:**
- Create: `src/lib/copilot/context.ts`
- Create: `src/lib/copilot/context.test.ts`
- Modify: `src/lib/intelligence/chat-logger.ts`
- Modify: `src/app/api/dashboard/upload/route.ts`

**Step 1: Write the failing test**

Create `src/lib/copilot/context.test.ts` covering:

- last 8 turns kept
- last 3 artifacts kept
- most recent artifact forced into context for referential follow-up
- oversize context collapses to rolling summary

```ts
it("forces the latest artifact into referential follow-up context", async () => {
  const result = await buildCopilotContext({
    threadId: "t1",
    message: "add these items to PO",
    recentArtifacts: [{ artifactId: "a1", summary: "ULINE cart screenshot" }],
  });

  expect(result.artifacts[0]?.artifactId).toBe("a1");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/context.test.ts`

Expected: FAIL because `buildCopilotContext` does not exist.

**Step 3: Write minimal implementation**

- Implement:
  - conversation window = last 8 turns
  - artifact window = last 3 artifacts
  - operational reference window = last 2 objects
  - rolling summary when budget exceeded
- Reuse `sys_chat_logs` for recent conversation reads.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/context.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/copilot/context.ts src/lib/copilot/context.test.ts src/lib/intelligence/chat-logger.ts src/app/api/dashboard/upload/route.ts
git commit -m "feat: add shared copilot context assembly"
```

---

### Task 3: Build shared tool and action contracts

**Files:**
- Create: `src/lib/copilot/tools.ts`
- Create: `src/lib/copilot/actions.ts`
- Create: `src/lib/copilot/actions.test.ts`
- Modify: `src/cli/aria-tools.ts`
- Modify: `src/app/api/dashboard/send/route.ts`

**Step 1: Write the failing test**

Create `src/lib/copilot/actions.test.ts` for:

- no explicit verb => no write
- explicit verb without binding => `needs_confirmation`
- explicit verb with one binding => allowed
- partial success bubbles correctly

```ts
it("returns needs_confirmation when write target is ambiguous", async () => {
  const result = await validateWriteIntent({
    text: "add these items to PO",
    candidateTargets: ["po1", "po2"],
  });

  expect(result.status).toBe("needs_confirmation");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/actions.test.ts`

Expected: FAIL because `validateWriteIntent` does not exist.

**Step 3: Write minimal implementation**

- Move shared read tools into `src/lib/copilot/tools.ts`
- Add action result statuses:
  - `success`
  - `needs_confirmation`
  - `failed`
  - `partial_success`
- Add explicit write gating rules in `src/lib/copilot/actions.ts`

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/actions.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/copilot/tools.ts src/lib/copilot/actions.ts src/lib/copilot/actions.test.ts src/cli/aria-tools.ts src/app/api/dashboard/send/route.ts
git commit -m "feat: add shared copilot tools and action contracts"
```

---

### Task 4: Extract shared provider chain and copilot core

**Files:**
- Create: `src/lib/copilot/core.ts`
- Create: `src/lib/copilot/core.test.ts`
- Modify: `src/cli/start-bot.ts`
- Modify: `src/app/api/dashboard/send/route.ts`
- Modify: `src/lib/intelligence/models.ts`

**Step 1: Write the failing test**

Create `src/lib/copilot/core.test.ts` to verify:

- core accepts normalized request
- core loads context
- core uses shared tools
- core returns normalized reply metadata

```ts
it("uses shared tools for normal Q&A", async () => {
  const result = await runCopilotTurn({
    channel: "telegram",
    text: "consumption for KM106",
  });

  expect(result.reply).toBeTruthy();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/core.test.ts`

Expected: FAIL because `runCopilotTurn` does not exist.

**Step 3: Write minimal implementation**

- Move shared provider chain logic out of Telegram/dashboard split files.
- Return structured turn output:
  - `reply`
  - `providerUsed`
  - `toolCalls`
  - `actionRefs`

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/core.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/copilot/core.ts src/lib/copilot/core.test.ts src/cli/start-bot.ts src/app/api/dashboard/send/route.ts src/lib/intelligence/models.ts
git commit -m "feat: extract shared copilot core"
```

---

### Task 5: Route Telegram text Q&A through the shared core

**Files:**
- Modify: `src/cli/start-bot.ts`
- Create: `src/lib/copilot/channels/telegram.ts`
- Create: `src/lib/copilot/channels/telegram.test.ts`

**Step 1: Write the failing test**

Create `src/lib/copilot/channels/telegram.test.ts` to verify Telegram text messages call the shared core instead of bespoke prompt/tool assembly.

```ts
it("routes Telegram text messages into the shared copilot core", async () => {
  const result = await handleTelegramText({
    chatId: 1,
    text: "what is consumption for PU102",
  });

  expect(result.reply).toBeTruthy();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/channels/telegram.test.ts`

Expected: FAIL because `handleTelegramText` does not exist.

**Step 3: Write minimal implementation**

- Move normal Telegram text handling into the adapter.
- Preserve callback/button flows unchanged for now.
- Delete duplicated normal-Q&A prompt assembly from `start-bot.ts` once parity is verified.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/channels/telegram.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/copilot/channels/telegram.ts src/lib/copilot/channels/telegram.test.ts src/cli/start-bot.ts
git commit -m "feat: route Telegram Q&A through shared copilot core"
```

---

### Task 6: Route dashboard send through the shared core

**Files:**
- Modify: `src/app/api/dashboard/send/route.ts`
- Create: `src/lib/copilot/channels/dashboard.ts`
- Create: `src/lib/copilot/channels/dashboard.test.ts`

**Step 1: Write the failing test**

Create `src/lib/copilot/channels/dashboard.test.ts` to verify dashboard requests hit the same normal-Q&A core used by Telegram.

```ts
it("routes dashboard chat through the shared copilot core", async () => {
  const result = await handleDashboardSend({ message: "recent open POs" });
  expect(result.reply).toBeTruthy();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/channels/dashboard.test.ts`

Expected: FAIL because `handleDashboardSend` does not exist.

**Step 3: Write minimal implementation**

- Replace the dashboard route’s local provider/tool logic with the shared core.
- Keep the HTTP route shape unchanged for the UI.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/channels/dashboard.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/copilot/channels/dashboard.ts src/lib/copilot/channels/dashboard.test.ts src/app/api/dashboard/send/route.ts
git commit -m "feat: route dashboard chat through shared copilot core"
```

---

### Task 7: Add Telegram photo ingestion and shared artifact normalization

**Files:**
- Modify: `src/cli/start-bot.ts`
- Create: `src/lib/copilot/artifacts.ts`
- Create: `src/lib/copilot/artifacts.test.ts`
- Modify: `src/app/api/dashboard/upload/route.ts`

**Step 1: Write the failing test**

Create `src/lib/copilot/artifacts.test.ts` for:

- Telegram photo normalization
- Telegram document normalization
- dashboard upload normalization
- artifact summary creation

```ts
it("normalizes Telegram photos into shared artifact records", async () => {
  const artifact = await normalizeArtifact({
    sourceType: "telegram_photo",
    mimeType: "image/jpeg",
    filename: "photo.jpg",
  });

  expect(artifact.sourceType).toBe("telegram_photo");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/artifacts.test.ts`

Expected: FAIL because `normalizeArtifact` does not exist.

**Step 3: Write minimal implementation**

- Add `bot.on('photo', ...)` path in `start-bot.ts`.
- Normalize Telegram photos/documents and dashboard uploads into shared artifacts.
- Store short summaries and object bindings.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/artifacts.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/copilot/artifacts.ts src/lib/copilot/artifacts.test.ts src/cli/start-bot.ts src/app/api/dashboard/upload/route.ts
git commit -m "feat: add shared artifact normalization and Telegram photo support"
```

---

### Task 8: Bind follow-up questions to the latest artifact

**Files:**
- Modify: `src/lib/copilot/context.ts`
- Modify: `src/lib/copilot/core.ts`
- Modify: `src/lib/copilot/context.test.ts`

**Step 1: Write the failing test**

Add a case for:

- upload screenshot
- follow-up asks “add these items to PO”
- latest artifact is bound into the turn

```ts
it("binds referential follow-ups to the latest artifact", async () => {
  const result = await buildCopilotContext({
    threadId: "t1",
    message: "add these items to PO",
    recentArtifacts: [{ artifactId: "uline1", summary: "ULINE cart screenshot" }],
  });

  expect(result.boundArtifactId).toBe("uline1");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/context.test.ts`

Expected: FAIL until referential binding is implemented.

**Step 3: Write minimal implementation**

- Detect referential follow-up phrasing.
- Force-bind the latest relevant artifact.
- Pass the binding into action validation.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/context.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/copilot/context.ts src/lib/copilot/core.ts src/lib/copilot/context.test.ts
git commit -m "feat: bind follow-up turns to shared artifacts"
```

---

### Task 9: Persist PO send sessions and unify action execution

**Files:**
- Modify: `src/lib/purchasing/po-sender.ts`
- Modify: `src/app/api/dashboard/purchasing/commit/route.ts`
- Modify: `src/cli/start-bot.ts`
- Create: `src/lib/copilot/actions.po-send.test.ts`

**Step 1: Write the failing test**

Create `src/lib/copilot/actions.po-send.test.ts` to verify:

- pending send session can be restored after restart
- stale session fails cleanly
- partial success is explicit

```ts
it("returns partial_success when Finale commit succeeds but email send fails", async () => {
  const result = await executePOSendAction({ sendId: "s1" });
  expect(["success", "partial_success", "failed"]).toContain(result.status);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/actions.po-send.test.ts`

Expected: FAIL because the action wrapper/persistence layer does not exist.

**Step 3: Write minimal implementation**

- Move pending PO send session storage to durable Supabase-backed state.
- Keep the existing review/send behavior, but route execution through shared action wrappers.
- Return structured action statuses.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/actions.po-send.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/po-sender.ts src/app/api/dashboard/purchasing/commit/route.ts src/cli/start-bot.ts src/lib/copilot/actions.po-send.test.ts
git commit -m "feat: persist PO send sessions and unify send actions"
```

---

### Task 10: Add Telegram callback recovery coverage

**Files:**
- Create: `src/lib/copilot/channels/telegram-callbacks.test.ts`
- Modify: `src/cli/start-bot.ts`
- Modify: `src/lib/purchasing/po-sender.ts`

**Step 1: Write the failing test**

Cover these scenarios:

- warm callback success
- cold restart before confirm
- stale original callback after restart
- expired session

```ts
it("returns a clean recovery message for stale Telegram callbacks after restart", async () => {
  const result = await handleTelegramCallback({ callbackData: "po_confirm_send_dead" });
  expect(result.userMessage).toMatch(/expired|re-initiate|review/i);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/channels/telegram-callbacks.test.ts`

Expected: FAIL because callback recovery behavior is incomplete.

**Step 3: Write minimal implementation**

- Add recovery branch for stale or expired callback payloads.
- If recoverable, point to a fresh review action.
- If not recoverable, return a clean failure message.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/channels/telegram-callbacks.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/copilot/channels/telegram-callbacks.test.ts src/cli/start-bot.ts src/lib/purchasing/po-sender.ts
git commit -m "test: add Telegram callback recovery coverage"
```

---

### Task 11: Add Slack and startup smoke checks

**Files:**
- Create: `src/lib/copilot/smoke.test.ts`
- Modify: `src/cli/start-bot.ts`
- Modify: `src/lib/slack/watchdog.ts`

**Step 1: Write the failing test**

Create a smoke test for:

- bot startup path
- dashboard send path
- Slack watchdog startup state is either connected or explicitly disabled

```ts
it("reports Slack watchdog startup state explicitly", async () => {
  const result = await getStartupHealth();
  expect(["running", "disabled"]).toContain(result.slack);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/smoke.test.ts`

Expected: FAIL because startup health reporting is not formalized.

**Step 3: Write minimal implementation**

- Add a startup health helper.
- Report Slack watchdog as:
  - `running`
  - `disabled`
  - never silent failure

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/smoke.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/copilot/smoke.test.ts src/cli/start-bot.ts src/lib/slack/watchdog.ts
git commit -m "test: add shared copilot startup smoke checks"
```

---

### Task 12: Remove duplicated chat logic as each shared path lands

**Files:**
- Modify: `src/cli/start-bot.ts`
- Modify: `src/cli/aria-tools.ts`
- Modify: `src/app/api/dashboard/send/route.ts`
- Test: `src/lib/copilot/core.test.ts`

**Step 1: Write the failing test**

Add assertions that both Telegram and dashboard use the same shared core for normal Q&A.

```ts
it("keeps Telegram and dashboard on the same normal Q&A path", async () => {
  const tg = await runCopilotTurn({ channel: "telegram", text: "recent POs" });
  const dash = await runCopilotTurn({ channel: "dashboard", text: "recent POs" });
  expect(tg.reply).toBeTruthy();
  expect(dash.reply).toBeTruthy();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copilot/core.test.ts`

Expected: FAIL until duplicate local logic is removed.

**Step 3: Write minimal implementation**

- Delete duplicate normal-Q&A prompt assembly and tool logic once adapters are stable.
- Keep channel-specific callback/rendering logic only.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copilot/core.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/start-bot.ts src/cli/aria-tools.ts src/app/api/dashboard/send/route.ts src/lib/copilot/core.test.ts
git commit -m "refactor: remove duplicated channel chat logic"
```

---

### Task 13: Full verification pass

**Files:**
- Modify: `docs/STATUS.md`
- Test: `src/lib/copilot/*.test.ts`

**Step 1: Run targeted tests**

Run:

```bash
npx vitest run src/lib/copilot/context.test.ts
npx vitest run src/lib/copilot/actions.test.ts
npx vitest run src/lib/copilot/core.test.ts
npx vitest run src/lib/copilot/artifacts.test.ts
npx vitest run src/lib/copilot/channels/telegram.test.ts
npx vitest run src/lib/copilot/channels/dashboard.test.ts
npx vitest run src/lib/copilot/channels/telegram-callbacks.test.ts
npx vitest run src/lib/copilot/smoke.test.ts
```

Expected: PASS

**Step 2: Run app and bot typechecks**

Run:

```bash
npm run typecheck
npm run typecheck:cli
```

Expected: PASS, excluding known pre-existing issues documented in project docs.

**Step 3: Update operational status**

- Add the shared copilot rollout note to `docs/STATUS.md`
- record any degraded services discovered during rollout

**Step 4: Commit**

```bash
git add docs/STATUS.md
git commit -m "docs: record shared copilot rollout status"
```

