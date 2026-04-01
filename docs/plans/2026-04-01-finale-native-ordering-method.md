# Finale-Native Ordering Method Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Ordering respect Finale-native per-SKU reorder methods, reduce noise from non-moving items, and keep dashboard actions aligned with real purchasing intent.

**Architecture:** Extend the Finale client and purchasing assessment pipeline so each SKU carries a parsed reorder method from Finale. Use that method as a weighted hint, not an absolute rule: `do not reorder` remains hard, while `manual/default` fall back to computed movement logic. Add movement-based filtering to suppress dead/noise SKUs before they reach the Ordering dashboard.

**Tech Stack:** TypeScript, Vitest, Next.js App Router, Finale API client, React

---

### Task 1: Define Finale-native reorder method parsing

**Files:**
- Modify: `src/lib/finale/client.ts`
- Create: `src/lib/finale/finale-reorder-method.test.ts`

**Step 1: Write the failing test**

Create tests that prove raw Finale product payloads can be normalized into:
- `do_not_reorder`
- `manual`
- `default`
- `sales_velocity`
- `demand_velocity`
- `on_site_order`

Include cases for values coming from:
- reorder guideline structures
- reorder policy fields
- user-defined fields when applicable

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/lib/finale/finale-reorder-method.test.ts
```

Expected: FAIL because explicit reorder-method parsing does not exist yet.

**Step 3: Write minimal implementation**

Add a normalized reorder-method parser in `src/lib/finale/client.ts` that:
- reads Finale-native SKU method fields
- returns one canonical enum/string value
- preserves existing `doNotReorder` support

**Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/lib/finale/finale-reorder-method.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/finale/client.ts src/lib/finale/finale-reorder-method.test.ts
git commit -m "feat(purchasing): parse finale-native reorder methods"
```

### Task 2: Carry reorder method through purchasing candidate shaping

**Files:**
- Modify: `src/lib/purchasing/policy-candidates.ts`
- Modify: `src/lib/purchasing/policy-candidates.test.ts`
- Modify: `src/lib/finale/client.ts`

**Step 1: Write the failing test**

Add tests proving a purchasing candidate preserves the Finale-native method for each SKU.

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/lib/purchasing/policy-candidates.test.ts
```

Expected: FAIL because reorder method is not yet carried through candidate shaping.

**Step 3: Write minimal implementation**

Update purchasing item/candidate types so each candidate includes:
- normalized reorder method
- any method hint needed for action routing

**Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/lib/purchasing/policy-candidates.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/policy-candidates.ts src/lib/purchasing/policy-candidates.test.ts src/lib/finale/client.ts
git commit -m "feat(purchasing): carry finale reorder method into candidates"
```

### Task 3: Respect Finale method when choosing velocity basis

**Files:**
- Modify: `src/lib/finale/client.ts`
- Modify: `src/lib/purchasing/policy-engine.ts`
- Modify: `src/lib/purchasing/policy-engine.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- `sales_velocity` SKUs use sales as primary
- `demand_velocity` SKUs use demand as primary
- `manual` SKUs fall back to computed movement instead of being blindly suppressed
- `default` SKUs fall back to computed movement instead of being blindly suppressed
- `do_not_reorder` SKUs are excluded

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/lib/purchasing/policy-engine.test.ts
```

Expected: FAIL because Finale-native reorder method is not yet part of assessment.

**Step 3: Write minimal implementation**

Update daily-rate selection and candidate interpretation so Finale's chosen method drives the primary signal where meaningful without breaking existing runway/on-order logic. Treat `manual/default` as weak hints and let computed activity decide whether the SKU stays visible.

**Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/lib/purchasing/policy-engine.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/finale/client.ts src/lib/purchasing/policy-engine.ts src/lib/purchasing/policy-engine.test.ts
git commit -m "fix(purchasing): honor finale velocity method in assessments"
```

### Task 4: Add movement-based filtering for dead/noise SKUs

**Files:**
- Modify: `src/lib/finale/client.ts`
- Modify: `src/lib/purchasing/assessment-service.ts`
- Modify: `src/lib/purchasing/assessment-service.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- SKUs with no meaningful recent movement are excluded
- `manual/default` SKUs with real movement can still stay visible
- explicit Finale reorder signals can still keep a SKU visible when appropriate
- active on-order/open-PO context still matters

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/lib/purchasing/assessment-service.test.ts
```

Expected: FAIL because non-moving SKU suppression is not implemented.

**Step 3: Write minimal implementation**

Add movement/noise filtering using existing base data:
- purchase receipts
- shipments/sales
- demand/consumption
- open POs

Keep the first rule set explicit and conservative. This filter becomes the primary cleanup layer for SKUs whose Finale method is `manual` or `default`.

**Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/lib/purchasing/assessment-service.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/finale/client.ts src/lib/purchasing/assessment-service.ts src/lib/purchasing/assessment-service.test.ts
git commit -m "feat(purchasing): suppress non-moving sku noise"
```

### Task 5: Surface Finale-native method in Ordering UI

**Files:**
- Modify: `src/components/dashboard/PurchasingPanel.tsx`
- Modify: `src/app/api/dashboard/purchasing/route.ts`
- Modify: `src/app/api/dashboard/purchasing/route.test.ts`
- Modify: `src/lib/purchasing/dashboard-focus.ts`
- Modify: `src/lib/purchasing/dashboard-focus.test.ts`

**Step 1: Write the failing test**

Add tests proving the Ordering payload and focus helpers:
- expose Finale-native reorder method labels
- block auto-select for `manual`
- suppress `do_not_reorder`
- allow `sales_velocity` and `demand_velocity` to stay actionable
- treat `default` like computed-intelligence fallback, not a hard mode
- surface `on_site_order` as a method hint rather than suppression

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/app/api/dashboard/purchasing/route.test.ts src/lib/purchasing/dashboard-focus.test.ts
```

Expected: FAIL because the route/UI do not yet expose Finale-native methods.

**Step 3: Write minimal implementation**

Update dashboard payload and panel rendering so operators see Finale-native method badges and action affordances without relying on dashboard-local business rules.

**Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/app/api/dashboard/purchasing/route.test.ts src/lib/purchasing/dashboard-focus.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/dashboard/PurchasingPanel.tsx src/app/api/dashboard/purchasing/route.ts src/app/api/dashboard/purchasing/route.test.ts src/lib/purchasing/dashboard-focus.ts src/lib/purchasing/dashboard-focus.test.ts
git commit -m "feat(ordering): surface finale-native sku methods"
```

### Task 6: Final verification

**Files:**
- No new files required

**Step 1: Run targeted verification**

Run:
```bash
npx vitest run src/lib/finale/finale-reorder-method.test.ts src/lib/purchasing/policy-candidates.test.ts src/lib/purchasing/policy-engine.test.ts src/lib/purchasing/assessment-service.test.ts src/app/api/dashboard/purchasing/route.test.ts src/lib/purchasing/dashboard-focus.test.ts
```

Expected:
- All targeted tests pass.

**Step 2: Run smoke verification**

Run:
```bash
npx tsx -e "import './src/lib/finale/client.ts'; import './src/lib/purchasing/assessment-service.ts'; import './src/components/dashboard/PurchasingPanel.tsx'; console.log('finale-ordering-smoke-ok')"
```

Expected:
- `finale-ordering-smoke-ok`

**Step 3: Commit**

```bash
git add -A
git commit -m "test(ordering): verify finale-native sku method handling"
```
