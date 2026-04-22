# Follow-Up Terminology Removal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the `Follow Up` label terminology from active code paths, keep manual-review emails unread in inbox with no added label, and rename visible AP status text away from follow-up wording.

**Architecture:** Keep the behavioral rule unchanged in the policy layer: human-review and missing-PDF cases stay visible and unread. Rename the remaining manual-review helper/event names and visible strings to `human review`, `manual review`, or `vendor outreach` depending on context, without refactoring unrelated purchasing logic that uses follow-up as a distinct business concept.

**Tech Stack:** TypeScript, Vitest, Next.js/React

---

### Task 1: Lock Manual-Review Terminology Regressions

**Files:**
- Modify: `src/lib/intelligence/workers/ap-identifier-policy.test.ts`
- Modify: `src/lib/intelligence/workers/ap-identifier.test.ts`
- Modify: `src/lib/intelligence/acknowledgement-agent.test.ts`
- Modify: `src/lib/intelligence/email-feedback.test.ts`

**Step 1: Write the failing tests**

- Rename assertions and test descriptions so they expect `manual review` / `human review`, not `Follow Up`.
- Keep AP policy mocks asserting `addLabels: []` and `removeLabels: []`.
- Update feedback helper expectations to the renamed helper and event type.

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run src/lib/intelligence/workers/ap-identifier-policy.test.ts src/lib/intelligence/workers/ap-identifier.test.ts src/lib/intelligence/acknowledgement-agent.test.ts src/lib/intelligence/email-feedback.test.ts
```

Expected: failures where old helper names or old event names are still referenced.

### Task 2: Rename Manual-Review Code Paths

**Files:**
- Modify: `src/lib/intelligence/email-feedback.ts`
- Modify: `src/lib/intelligence/acknowledgement-agent.ts`
- Modify: `src/lib/intelligence/workers/ap-identifier-policy.ts`

**Step 1: Write minimal implementation**

- Rename the feedback event interface/helper away from `FollowUp`.
- Rename the analytics event type from `email_follow_up_required` to a manual-review equivalent.
- Update acknowledgement agent imports/log wording to match the renamed helper.
- Keep AP policy behavior as no-label, unread-visible review handling.

**Step 2: Run the focused tests**

Run:

```bash
npx vitest run src/lib/intelligence/workers/ap-identifier-policy.test.ts src/lib/intelligence/workers/ap-identifier.test.ts src/lib/intelligence/acknowledgement-agent.test.ts src/lib/intelligence/email-feedback.test.ts
```

Expected: PASS

### Task 3: Remove Visible AP “Follow-up” Strings

**Files:**
- Modify: `src/components/dashboard/ActivePurchasesPanel.tsx`
- Modify: `src/components/dashboard/PurchasingCalendarPanel.tsx`
- Modify: `src/lib/purchasing/lifecycle-types.ts`
- Modify: `src/lib/purchasing/calendar-lifecycle.ts`
- Modify: `src/lib/reports/oos-email-trigger.ts`

**Step 1: Write the failing tests or string assertions**

- Update existing tests where present.
- If no direct tests exist for a string, use targeted grep verification after implementation.

**Step 2: Write minimal implementation**

- Rename AP-facing status labels to `AP Review`, `Past Due - Needs Review`, or `Vendor Outreach` as appropriate.
- Rename the aging section title away from `Follow Up with Vendor`.

**Step 3: Verify strings**

Run:

```bash
rg -n "Follow Up|AP Follow-up|Needs Follow-up" src
```

Expected: no matches.

### Task 4: Final Verification

**Files:**
- No new files

**Step 1: Run targeted verification**

```bash
npx vitest run src/lib/intelligence/workers/ap-identifier-policy.test.ts src/lib/intelligence/workers/ap-identifier.test.ts src/lib/intelligence/acknowledgement-agent.test.ts src/lib/intelligence/email-feedback.test.ts
npx vitest run src/lib/intelligence/workers/ap-forwarder.test.ts
rg -n "Follow Up|AP Follow-up|Needs Follow-up" src
```

Expected: tests pass and the removed label phrases are absent from `src`.
