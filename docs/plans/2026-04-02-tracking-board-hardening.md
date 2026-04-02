# Tracking Board Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make shipment tracking dependable for teammates by improving multi-source shipment resolution, live refresh behavior, and teammate query precision.

**Architecture:** Keep `src/lib/tracking/shipment-intelligence.ts` as the canonical shipment resolution layer. Email extraction remains the discovery authority, carrier APIs remain the status authority, and dashboard/API consumers read refreshed, ranked shipment rollups from that ledger.

**Tech Stack:** Next.js, TypeScript, Supabase, Vitest

---

### Task 1: Harden shipment query ranking

**Files:**
- Modify: `src/lib/tracking/shipment-intelligence.ts`
- Test: `src/lib/tracking/shipment-intelligence.test.ts`

**Step 1: Write the failing test**

Add a test proving an exact PO match beats incidental substring hits from noisy query tokens.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/tracking/shipment-intelligence.test.ts`
Expected: FAIL showing the wrong shipment is chosen for a teammate query.

**Step 3: Write minimal implementation**

Add query stop-word filtering and field-aware shipment scoring that prioritizes PO and tracking matches over weak vendor/carrier substring matches.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/tracking/shipment-intelligence.test.ts`
Expected: PASS

### Task 2: Refresh stale active shipments before board reads

**Files:**
- Modify: `src/lib/tracking/shipment-intelligence.ts`
- Test: `src/lib/tracking/shipment-intelligence.test.ts`

**Step 1: Write the failing test**

Add a test proving unchecked or stale active shipments are selected for live refresh while fresh delivered shipments are skipped.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/tracking/shipment-intelligence.test.ts`
Expected: FAIL because there is no refresh selection logic yet.

**Step 3: Write minimal implementation**

Add refresh-due selection helpers and refresh due shipments inside active shipment loading before building dashboard rollups.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/tracking/shipment-intelligence.test.ts`
Expected: PASS

### Task 3: Verify teammate-facing tracking behavior

**Files:**
- Test: `src/components/dashboard/TrackingBoardPanel.test.tsx`
- Verify: `src/lib/tracking/shipment-intelligence.test.ts`

**Step 1: Run focused tracking tests**

Run: `npm test -- src/components/dashboard/TrackingBoardPanel.test.tsx src/lib/tracking/shipment-intelligence.test.ts`
Expected: PASS

**Step 2: Run type verification**

Run: `npm run typecheck`
Expected: exit 0 with no TypeScript errors.
