# Email draft voice hardening — learning from Bill

> **For Hermes:** Delegate one subagent per workstream. Each is self-contained.

**Goal:** Stop embarrassing drafts (Megan false COA, Cari "Hi cs,", "looking into this" on simple confirms) by upgrading the LLM quality, seeding Bill's real voice as few-shot examples, and tracking grade failures visibly.

**Architecture:** Three independent improvements — LLM tier, voice seeds, failure surfacing.

**Tech stack:** TypeScript, existing `unifiedObjectGeneration`, `feedback-loop.ts`, `email-draft-voice.ts`, `vendor-opportunity.ts`.

**Non-goals:** Change draft-only policy (already correct). Add signature blocks (already banned). Rewrite detection (vendor-opportunity detection is fine).

---

## Workstream A — Upgrade opportunity draft to paid LLM tier

**Problem:** `composeOpportunityDraft` calls `unifiedObjectGeneration` with `tier: "free"`. Free tier = DeepSeek V4 Flash ($0.14/M). These cheap models produce cold, wrong drafts because they can't model Bill's voice from rules alone.

**Fix:** Change to `tier: "paid"` in `vendor-opportunity.ts:179`. Paid tier cascade: DeepSeek V4 → Claude Haiku 4.5 → GPT-4o-mini → Claude Sonnet fallback. The cost difference (~5–10¢ per draft vs ~0.5¢) is trivial for brand damage avoided.

**Files:**
- Modify: `src/lib/intelligence/vendor-opportunity.ts` (one line — `tier: "free"` → `tier: "paid"`)
- Test: update `vendor-opportunity.test.ts` if any mock asserts tier

**Acceptance:** LLM call uses paid models; test unaffected (mock).

---

## Workstream B — Seed Bill's voice as few-shot examples

**Problem:** The `BILL_VENDOR_REPLY_VOICE` system prompt is pure rules. No examples. LLMs learn voice from examples far better than from adjectives. Bill's style is: warm, very short, Thanks!/Thank you., never stuffy.

**Fix:** Add a 2–3 example block to `BILL_VENDOR_REPLY_VOICE` in `email-draft-voice.ts`:

```
EXAMPLES (Bill's real style — follow these):

Example 1 — vendor sends traceability info + sample offer:
"Hi Megan,
Thanks for the traceability detail and videos — helpful. Noted on the COA. A sample would be welcome if you can send one.
Thanks!"

Example 2 — vendor confirms they'll invoice when restocked:
"Thanks Cari — appreciated."

Example 3 — vendor sends pricing + tech sheets:
"Hi Jessica,
Thanks — pricing and TDS received. We'll compare with current supply and follow up.
Thanks!"
```

These match real incidents and Bill corrections. Real sent-mail gold samples can replace these later.

**Files:**
- Modify: `src/lib/intelligence/email-draft-voice.ts` (inject examples into `BILL_VENDOR_REPLY_VOICE` constant)
- Test: `email-draft-voice.test.ts` — add test that prompt includes example keywords

**Acceptance:** Prompt includes 3 example blocks; tests pass.

---

## Workstream C — Log grade failures + improve feedback loop

**Problem:** `gradeVendorReplyDraft` catches bad drafts and falls back to the warm template silently. Bill never sees when Aria almost sent something bad. Also, when Bill edits a draft and sends, that is gold training data we never capture.

**Fix — C1 (now):** Call `recordFeedback` when a draft fails grade, with the failure details + the rejected draft text. This lands in `feedback_events` and makes failures queryable.

**Fix — C2 (now):** Add a `recordDraftSentByBill` helper that detects when Bill has sent from a thread Aria drafted into. The Gmail Sent folder query (run once daily or on ACK cycle) can find drafts → sent pairs and log the final language as a gold sample.

**Files:**
- Modify: `src/lib/intelligence/email-feedback.ts` (add `recordDraftGradeFailure`)
- Modify: `src/lib/intelligence/vendor-opportunity.ts` (call it on grade fail)
- Create: `src/lib/intelligence/gmail-sent-reader.ts` (optional C2 — read Sent Mail for threads Aria drafted into, extract gold)
- Test: `email-feedback.test.ts` additions

**Acceptance:** Grade failures logged; sent-reader optional but scaffolded.

---

## Shared conventions

1. **Never commit.**
2. **No new auto-send** of vendor replies.
3. **Tests:** `npx vitest run src/lib/intelligence/email-draft-voice.test.ts src/lib/intelligence/vendor-opportunity.test.ts src/lib/intelligence/email-feedback.test.ts`
4. **Skip typecheck** (OOM on full monorepo).

---

## Delegation order

| Agent | Workstream | Size |
|-------|------------|------|
| A | Upgrade LLM tier to paid | Tiny (1 line) |
| B | Seed few-shot examples in prompt | Small (2 examples + test) |
| C | Log grade failures to feedback | Medium (~40 lines) |

Dispatch A+B+C in parallel. C depends on nothing.
