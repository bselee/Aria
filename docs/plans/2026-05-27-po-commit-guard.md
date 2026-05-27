# PO Commit Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a shared purchasing guard that only allows autonomous PO action when the recommended quantity covers vendor lead time plus 30 days, with clear manual-review reasons.

**Architecture:** Keep the guard pure and reusable. It evaluates already-assessed purchasing lines, then dashboard, Telegram, and draft planning can all consume the same decision instead of duplicating threshold logic.

**Tech Stack:** TypeScript, Vitest, existing Finale purchasing intelligence and dashboard API.

---

### Task 1: Guard Behavior

**Files:**
- Create: `src/lib/purchasing/po-commit-guard.ts`
- Test: `src/lib/purchasing/po-commit-guard.test.ts`

Write failing tests for lead-time-plus-30 coverage, undercovered recommendations, low confidence, and overbuy/manual-review flags. Implement a pure evaluator that returns `commit`, `draft_only`, or `block`.

### Task 2: Draft Planning Integration

**Files:**
- Modify: `src/lib/purchasing/vendor-draft-plans.ts`
- Test: `src/lib/purchasing/vendor-draft-plans.test.ts`

Attach guard results to each vendor plan and expose `commitReadyItems` separately from manually reviewable draft items.

### Task 3: API Enforcement

**Files:**
- Modify: `src/app/api/dashboard/purchasing/route.ts`

Surface guard decisions in the dashboard GET payload and enforce the same guard before dashboard-created draft POs.

### Task 4: Verification

Run focused Vitest suites and `npm run build`. Commit and push when verification passes.
