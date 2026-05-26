# Tracking Trust Gates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Purchases tracking and ETA claims evidence-first so weak email or LLM guesses do not drive confirmed tracking, lifecycle, or target receive dates.

**Architecture:** Add conservative confidence rules at extraction/storage boundaries, preserve candidate evidence, and only promote high-confidence evidence into dashboard facts. The Purchases panel should display provenance clearly and avoid treating inferred tracking as carrier-confirmed.

**Tech Stack:** TypeScript, Vitest, Next.js dashboard, Supabase-backed `purchase_orders` and `shipments`.

---

### Task 1: Tracking Agent Confidence

**Files:**
- Modify: `src/lib/intelligence/tracking-agent.ts`
- Test: `src/lib/intelligence/tracking-agent.test.ts`

**Steps:**
1. Add tests proving explicit PO numbers save high confidence and inferred vendor-only PO matches save lower confidence.
2. Run the test and verify the new inferred-confidence test fails.
3. Pass correlation confidence into `upsertShipmentEvidence`.
4. Run the test and verify it passes.

### Task 2: Shipment Promotion Rules

**Files:**
- Modify: `src/lib/tracking/shipment-intelligence.ts`
- Test: `src/lib/tracking/shipment-intelligence.test.ts`

**Steps:**
1. Add a pure helper that classifies shipment evidence as `confirmed` or `candidate`.
2. Require carrier/status evidence, strong source confidence, or multiple evidence refs before dashboard promotion.
3. Test that weak vendor-inferred email evidence stays candidate.
4. Use the helper in high-confidence reads.

### Task 3: Active Purchases Provenance

**Files:**
- Modify: `src/lib/purchasing/active-purchases.ts`
- Modify: `src/components/dashboard/ActivePurchasesPanel.tsx`

**Steps:**
1. Return shipment confidence/provenance fields already present on shipment rows.
2. Only show weak shipment rows as candidate tracking, not as factual shipping status.
3. Keep confirmed tracking prominent and label candidate tracking with source details.

### Task 4: Verification

**Commands:**
- `npm test -- --run src/lib/intelligence/tracking-agent.test.ts src/lib/tracking/shipment-intelligence.test.ts`
- `npm test -- --run src/components/dashboard/PurchasingPanel.test.tsx`
- `npm run build`

Reload `aria-dashboard` only after a successful build.
