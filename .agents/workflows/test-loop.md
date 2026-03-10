---
description: Self-healing test loop — auto-run, diagnose, fix, and re-test until green or escalate
---
// turbo-all

# /test-loop

Self-healing test → debug → auto-fix → re-test loop for the antigravity/MuRP codebase.

## Usage
```
/test-loop [scope?] [max-iterations?]
```

**Examples:**
- `/test-loop` — runs full suite, up to 3 fix iterations
- `/test-loop src/components/PurchaseOrders` — scoped to a directory
- `/test-loop . 5` — full suite, up to 5 fix iterations

---

## Agent Instructions

You are the **Test Loop Orchestrator**. Your job is to run tests, analyze failures, delegate fixes, and re-run until the suite passes or the iteration cap is hit.

### Phase 1 — SNAPSHOT
Before touching anything:
1. Run `git status` and record any uncommitted changes.
2. Note the current branch: `git branch --show-current`
3. Record starting test state to compare at the end.

### Phase 2 — RUN TESTS
Execute the full test suite (or scoped path if provided):

```bash
# TypeScript type check
npx tsc --noEmit 2>&1

# Unit + integration tests
npx vitest run $SCOPE --reporter=verbose 2>&1

# Lint
npx eslint $SCOPE --max-warnings=0 2>&1
```

Capture ALL output. Do not truncate.

### Phase 3 — TRIAGE FAILURES
For each failure, classify it:

| Category | Description | Auto-fixable? |
|---|---|---|
| `TYPE_ERROR` | TypeScript type mismatch | ✅ Usually |
| `IMPORT_ERROR` | Missing or broken import | ✅ Usually |
| `LOGIC_ERROR` | Test assertion fails due to wrong logic | ⚠️ Sometimes |
| `SCHEMA_ERROR` | Supabase type mismatch / RLS issue | ⚠️ Sometimes |
| `ENV_ERROR` | Missing env var or config | ❌ Escalate |
| `FLAKY` | Timing/async issue | ⚠️ Sometimes |
| `UNKNOWN` | Cannot classify | ❌ Escalate |

### Phase 4 — INVOKE /debug-fix AGENT
For each auto-fixable failure, invoke the `/debug-fix` sub-agent with:

```
/debug-fix
FAILURE_TYPE: <category>
FILE: <filepath>
ERROR: <exact error message>
CONTEXT: <surrounding code snippet>
```

Wait for each fix before proceeding to next failure.

### Phase 5 — RE-RUN & EVALUATE
After all fixes applied, re-run the full test suite.

**If passing:** 
- Output a ✅ PASS summary (files changed, iterations taken)
- Stage changes: `git add -p` (show diff, do not auto-commit)
- Prompt user to review before committing

**If still failing after max iterations:**
- Output ❌ ESCALATE report (see below)
- Do NOT commit anything
- Restore original files if changes made things worse

### Output Format

#### Success
```
✅ TEST LOOP COMPLETE
──────────────────────────────
Iterations:     2 of 3
Tests fixed:    7 failures → 0
Files changed:  3
Time:           ~45s

Changes staged for your review:
  M  src/lib/supabase/types.ts
  M  src/components/POTable.tsx  
  M  src/api/finale/sync.ts

Run `git diff --staged` to review before committing.
```

#### Escalation
```
❌ ESCALATE — Could not auto-fix after 3 iterations
──────────────────────────────
Remaining failures: 2

[1] LOGIC_ERROR in src/lib/mrp/velocity.ts:147
    Reason: Business logic unclear — requires human decision
    Error: Expected reorder qty 48, got 36

[2] ENV_ERROR in src/api/finale/client.ts:12  
    Reason: FINALE_API_KEY missing from .env.local
    Fix: Add key to Vercel env vars and .env.local

No files were committed. Partial fixes saved to branch:
  fix/auto-loop-partial-2025-03-05
```

---

## Rules
- Never commit directly to `main` or `production`
- Never delete tests to make them pass
- If a fix breaks a previously passing test, revert that fix immediately
- Max auto-fix iterations: 3 (override with argument)
- Always preserve original behavior — fix the code to match the test intent, not the other way around
