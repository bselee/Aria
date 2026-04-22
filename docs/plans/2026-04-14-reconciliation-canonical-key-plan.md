# Reconciliation Canonical Key Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make duplicate reconciliation detection and reconciliation logging use one canonical identity key so invoices are deduped correctly per PO across all AP paths.

**Architecture:** Add a shared reconciler helper that builds canonical reconciliation metadata from vendor, invoice number, and PO order id. Use that helper inside duplicate detection and every reconciliation log writer so APAgent, approval flow, and PO sweep all speak the same identity format.

**Tech Stack:** TypeScript, Vitest, Supabase JSON metadata, Finale reconciler

---

### Task 1: Red Test For PO-Scoped Duplicate Detection

**Files:**
- Modify: `src/lib/finale/reconciler.test.ts`
- Modify: `src/lib/finale/reconciler.ts`

**Step 1: Write the failing test**

Add a test proving that:
- invoice `INV-1001` reconciled to `PO-1` is a duplicate for `PO-1`
- the same invoice `INV-1001` is not treated as a duplicate for `PO-2`

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/reconciler.test.ts`
Expected: FAIL because duplicate detection ignores `orderId`

**Step 3: Write minimal implementation**

Add a shared helper that returns canonical reconciliation metadata including:
- `reconciliationKey`
- `invoiceNumber`
- `vendorName`
- `orderId`

Use it in duplicate detection so the query filters on canonical order-aware identity.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/reconciler.test.ts`
Expected: PASS

### Task 2: Normalize Reconciliation Logging

**Files:**
- Modify: `src/lib/finale/reconciler.ts`
- Modify: `src/lib/matching/po-sweep.ts`
- Modify: `src/lib/intelligence/ap-agent.ts`

**Step 1: Write the failing test**

Add a test proving the shared metadata helper is used for audit logging, not ad hoc metadata objects.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/reconciler.test.ts`
Expected: FAIL because the writers do not yet share one metadata builder

**Step 3: Write minimal implementation**

Route reconciliation log writers through one shared metadata builder and update PO sweep to log the same canonical fields.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/reconciler.test.ts src/lib/intelligence/ap-agent.test.ts`
Expected: PASS

### Task 3: Verify Regressions

**Files:**
- Test: `src/lib/finale/reconciler.test.ts`
- Test: `src/lib/intelligence/ap-agent.test.ts`
- Test: `src/lib/intelligence/workers/ap-forwarder.test.ts`

**Step 1: Run focused verification**

Run:

```bash
npx vitest run src/lib/finale/reconciler.test.ts src/lib/intelligence/ap-agent.test.ts src/lib/intelligence/workers/ap-forwarder.test.ts src/lib/intelligence/workers/ap-identifier.test.ts
```

Expected: PASS

**Step 2: Import smoke test**

Run:

```bash
node --import tsx -e "await import('./src/lib/finale/reconciler.ts'); console.log('reconciler-import-ok')"
```

Expected: `reconciler-import-ok`
