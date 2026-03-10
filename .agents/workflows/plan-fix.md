---
description: Pre-flight fix planner — analyzes failures and produces a prioritized fix plan (read-only)
---
// turbo-all

# /plan-fix

Pre-flight agent — analyzes a failing area and produces a fix plan before `/test-loop` runs.
Use this when you want to understand the blast radius before letting the loop auto-fix.

## Usage
```
/plan-fix [file-or-directory]
```

**Examples:**
- `/plan-fix src/lib/mrp/` — plan fixes for MRP module
- `/plan-fix src/api/finale/sync.ts` — plan fixes for a specific file

---

## Agent Instructions

You are the **Fix Planner**. You analyze code and tests to produce a prioritized fix plan — but you do NOT make any changes.

### Step 1 — MAP THE FAILURE SURFACE

Run tests in dry-report mode:
```bash
npx tsc --noEmit 2>&1 | head -100
npx vitest run $SCOPE --reporter=verbose --run 2>&1 | tail -200
npx eslint $SCOPE --format=compact 2>&1
```

### Step 2 — BUILD DEPENDENCY GRAPH

For each failing file, identify:
- What it imports (upstream dependencies)
- What imports it (downstream consumers)
- Which Supabase tables/views it touches
- Which Finale API endpoints it calls

### Step 3 — RANK BY FIX ORDER

Some fixes must happen before others. Produce an ordered list:

```
FIX PLAN — src/lib/mrp/
Generated: 2025-03-05
──────────────────────────────────────────

Total failures: 8 (5 type errors, 2 logic errors, 1 import error)
Estimated auto-fixable: 6/8

ORDERED FIX SEQUENCE:

[1] FIRST — src/lib/supabase/types.ts (IMPORT_ERROR)
    Unblocks: 3 other files that import from here
    Fix: Export missing `PurchaseOrderRow` type
    Risk: LOW

[2] src/lib/mrp/velocity.ts (TYPE_ERROR ×2)
    Depends on: Fix [1]
    Fix: Update param type from `number` to `number | null`
    Risk: LOW

[3] src/components/POTable.tsx (TYPE_ERROR)
    Depends on: Fix [1], [2]
    Fix: Handle nullable vendorId in render
    Risk: LOW

[4] src/lib/mrp/reorder.ts (LOGIC_ERROR) ⚠️ HUMAN REVIEW
    Fix: Unknown — velocity window config ambiguous
    Risk: HIGH — do not auto-fix

[5] src/api/finale/sync.ts (LOGIC_ERROR) ⚠️ HUMAN REVIEW
    Fix: Test expects 200 response but handler returns 201
    Risk: MEDIUM — could be intentional, verify with API docs

RECOMMENDATION:
Auto-fix [1][2][3] via /test-loop
Review [4][5] manually before proceeding
```

### Step 4 — ESTIMATE LOOP ITERATIONS NEEDED

```
Predicted /test-loop behavior:
  Iteration 1: Fixes [1] → unblocks [2][3], re-run reveals [4][5] clearer
  Iteration 2: Fixes [2][3] → 5 tests pass
  Iteration 3: Hits [4][5] → escalates correctly

Recommended: /test-loop src/lib/mrp/ 3
```

---

## Output only — no file changes
This command is read-only. Use it to make an informed decision before running `/test-loop`.
