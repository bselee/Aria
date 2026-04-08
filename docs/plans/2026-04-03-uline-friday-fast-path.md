# Uline Friday Fast Path Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Friday Uline ordering build a Finale-authoritative PO and verified cart without scanning unrelated vendors or letting Slack/BASAuto noise break the run.

**Architecture:** Keep Finale as the only required source for the Friday manifest. Add a vendor-scoped purchasing-intelligence path for `ULINE`, use it from the Friday CLI gather step, and leave Slack/BASAuto as optional future enrichments that never block the core flow.

**Tech Stack:** TypeScript, Vitest, Finale GraphQL/REST client, Playwright Uline automation

---

### Task 1: Pin The Uline Gather Behavior

**Files:**
- Create: `src/cli/order-uline.test.ts`
- Modify: `src/cli/order-uline.ts`

**Step 1: Write the failing test**

Add a test that imports the Uline gather helper, stubs a Finale client, and expects the helper to request vendor-scoped intelligence for `ULINE` instead of a full uncached catalog pass.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/order-uline.test.ts`
Expected: FAIL because the helper is not exported yet and/or does not call the vendor-scoped path.

**Step 3: Write minimal implementation**

Export the gather helper from `src/cli/order-uline.ts` and update it to call a vendor-scoped Finale intelligence method for `ULINE`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/order-uline.test.ts`
Expected: PASS

### Task 2: Add Vendor-Scoped Finale Purchasing Intelligence

**Files:**
- Modify: `src/lib/finale/client.ts`
- Test: `src/cli/order-uline.test.ts`

**Step 1: Write the failing test**

Extend the Uline gather test to prove only the Uline vendor path is requested and non-Uline vendor groups are ignored.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/order-uline.test.ts`
Expected: FAIL because the Finale client does not yet support vendor-scoped intelligence.

**Step 3: Write minimal implementation**

Add an optional `vendorFilter` parameter to `getPurchasingIntelligence()`. In vendor-filtered mode, seed candidates from Finale’s external reorder groups for that vendor, then run the detailed intelligence pass only for those SKUs.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/order-uline.test.ts`
Expected: PASS

### Task 3: Re-Verify The Friday Order Path

**Files:**
- Modify: `src/cli/order-uline.ts`
- Review: `src/app/api/dashboard/purchasing/uline-order/route.ts`

**Step 1: Run focused regression**

Run: `npx vitest run src/cli/order-uline.test.ts src/app/api/dashboard/purchasing/uline-order/route.test.ts`
Expected: PASS

**Step 2: Run the live Friday command**

Run: `node --import tsx src/cli/order-uline.ts --auto-reorder --create-po`
Expected: Creates a Finale PO, fills the Uline cart, and reports a verified cart state without checking out.

**Step 3: If the live run still fails, capture exact boundary evidence**

Collect the CLI logs, Uline page state, and PO/cart mismatch details before changing any more code.

**Step 4: Re-run after fix**

Run the same live command until the cart verifies against the PO exactly.

