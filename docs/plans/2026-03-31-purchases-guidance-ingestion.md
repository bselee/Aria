# Purchases Guidance Ingestion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Recover the internal purchases-guidance scraper work, harden it into a reliable advisory ingestion flow, and connect its results to the shared purchasing intelligence engine through a validation and classification layer.

**Architecture:** Keep the internal site as a guidance source only. Build a more reliable scraper, normalize the extracted vendor/SKU metrics, compare those signals against Finale and the shared purchasing policy, then classify each item by agreement or disagreement. Preserve only the valuable artifacts and retire duplicate scoring logic over time.

**Tech Stack:** Playwright, TSX CLI scripts, Finale client, shared purchasing policy engine, JSON sample fixtures, Vitest

---

### Task 1: Clean up and preserve the current prototype artifacts

**Files:**
- Modify: `src/cli/scrape-purchases.ts`
- Modify: `src/cli/assess-purchases.ts`
- Move/Create: `debug/purchases/` or another agreed archive path for representative screenshots
- Keep sample: `purchases-data.json`

**Step 1: Write the failing inventory test or checklist**

Create a small test or scripted assertion that verifies:
- a sample artifact file exists for scraper output
- only representative screenshots are kept in the tracked/debug set
- the scraper and assessor remain readable entrypoints

If a formal test is too heavy for this slice, write a repo checklist in the implementation PR and keep the cleanup isolated.

**Step 2: Run the validation step to show the current clutter**

Run:

```bash
Get-ChildItem purchases-* , src/cli/assess-purchases.ts , src/cli/scrape-purchases.ts
```

Expected: many screenshots and two prototype CLIs are present.

**Step 3: Perform minimal cleanup**

- keep `scrape-purchases.ts`
- keep `assess-purchases.ts`
- keep `purchases-data.json`
- move representative screenshots into a debug/archive folder
- discard duplicate/low-signal screenshots

**Step 4: Verify the cleanup**

Run:

```bash
Get-ChildItem debug/purchases -File
Get-ChildItem src/cli/assess-purchases.ts , src/cli/scrape-purchases.ts , purchases-data.json
```

Expected: only the valuable artifacts remain.

**Step 5: Commit**

```bash
git add debug/purchases src/cli/scrape-purchases.ts src/cli/assess-purchases.ts purchases-data.json
git commit -m "chore(purchasing): clean up purchases guidance prototype artifacts"
```

### Task 2: Harden the purchases scraper navigation

**Files:**
- Modify: `src/cli/scrape-purchases.ts`
- Test/Create: `src/cli/scrape-purchases.test.ts` or a parser-focused helper test

**Step 1: Write the failing test**

Extract the navigation and vendor discovery logic into helper functions where possible, then add tests for:
- vendor chip label normalization
- vendor chip count stripping
- stable iteration over vendor names instead of stale handles

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/cli/scrape-purchases.test.ts
```

Expected: FAIL because the helpers do not exist yet or current logic is too loose.

**Step 3: Write minimal implementation**

Update `scrape-purchases.ts` to:
- avoid fixed long sleeps where possible
- wait for stable page markers
- re-query chip elements by vendor name on each iteration
- normalize vendor names cleanly
- separate page navigation from data extraction

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/cli/scrape-purchases.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/cli/scrape-purchases.ts src/cli/scrape-purchases.test.ts
git commit -m "feat(purchasing): harden purchases scraper navigation"
```

### Task 3: Replace loose metric scraping with structured extraction

**Files:**
- Modify: `src/cli/scrape-purchases.ts`
- Create: `src/lib/purchasing/purchases-guidance-parser.ts`
- Test: `src/lib/purchasing/purchases-guidance-parser.test.ts`

**Step 1: Write the failing test**

Use captured HTML or reduced sample structures from the page to test extraction of:
- `purchaseAgainBy`
- `recommendedReorderQty`
- `supplierLeadTime`
- `remaining`
- `dailyVelocity`
- `daysBuildsLeft`
- selected financial metrics

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/purchases-guidance-parser.test.ts
```

Expected: FAIL because the parser helper does not exist or does not extract populated values.

**Step 3: Write minimal implementation**

Create a parser helper that:
- reads the visible card structure
- extracts label/value pairs structurally
- returns a normalized typed object

Then use that helper from `scrape-purchases.ts`.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/purchases-guidance-parser.test.ts
```

Expected: PASS with real populated metrics.

**Step 5: Commit**

```bash
git add src/lib/purchasing/purchases-guidance-parser.ts src/lib/purchasing/purchases-guidance-parser.test.ts src/cli/scrape-purchases.ts
git commit -m "feat(purchasing): parse purchases guidance metrics structurally"
```

### Task 4: Build the guidance-vs-policy comparison layer

**Files:**
- Create: `src/lib/purchasing/purchases-guidance-comparison.ts`
- Test: `src/lib/purchasing/purchases-guidance-comparison.test.ts`
- Modify: `src/cli/assess-purchases.ts`

**Step 1: Write the failing test**

Add tests that classify items into:
- `agrees_with_policy`
- `guidance_overstates_need`
- `guidance_understates_need`
- `already_on_order`
- `missing_in_finale`
- `needs_manual_review`

Use mocked shared policy results and Finale coverage inputs.

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/purchases-guidance-comparison.test.ts
```

Expected: FAIL because the comparison layer does not exist yet.

**Step 3: Write minimal implementation**

Implement a comparison helper that combines:
- scraped guidance urgency
- Finale stock/on-order data
- shared purchasing assessment decision and explanation

Refactor `assess-purchases.ts` to use this helper instead of acting as a separate scoring engine.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/purchases-guidance-comparison.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/purchasing/purchases-guidance-comparison.ts src/lib/purchasing/purchases-guidance-comparison.test.ts src/cli/assess-purchases.ts
git commit -m "feat(purchasing): classify purchases guidance against policy"
```

### Task 5: Decide the fate of `assess-purchases.ts`

**Files:**
- Modify: `src/cli/assess-purchases.ts`
- Possibly create: `src/cli/compare-purchases-guidance.ts`
- Test: associated CLI/helper tests

**Step 1: Write the failing test or command expectation**

Define the intended role clearly:
- either `assess-purchases.ts` becomes a thin comparison CLI
- or it is retired and replaced with a better-named comparison command

Add a focused test for the final CLI behavior if practical.

**Step 2: Run test or command to verify the current mismatch**

Run:

```bash
node --import tsx src/cli/assess-purchases.ts --json
```

Expected: current output behaves like a separate scoring engine rather than a comparison tool.

**Step 3: Write minimal implementation**

Choose one:
- keep the file but convert it into a comparison/reporting CLI
- or replace it with a clearly named guidance-comparison CLI and leave a small shim if needed

The long-term rule: do not maintain duplicate purchasing scoring logic outside the shared engine.

**Step 4: Verify the final CLI behavior**

Run:

```bash
node --import tsx src/cli/assess-purchases.ts --json
```

Expected: output is clearly comparison-oriented and classification-based.

**Step 5: Commit**

```bash
git add src/cli/assess-purchases.ts src/cli/compare-purchases-guidance.ts
git commit -m "refactor(purchasing): align purchases guidance CLI with shared policy"
```

### Task 6: Verify end-to-end advisory output

**Files:**
- Verify:
  - `src/cli/scrape-purchases.ts`
  - `src/lib/purchasing/purchases-guidance-parser.ts`
  - `src/lib/purchasing/purchases-guidance-comparison.ts`
  - `src/cli/assess-purchases.ts`

**Step 1: Run focused tests**

Run:

```bash
npx vitest run src/cli/scrape-purchases.test.ts src/lib/purchasing/purchases-guidance-parser.test.ts src/lib/purchasing/purchases-guidance-comparison.test.ts
```

Expected: PASS.

**Step 2: Run the CLI comparison path**

Run:

```bash
node --import tsx src/cli/assess-purchases.ts --json
```

Expected: JSON output with classifications and Finale/shared-policy context.

**Step 3: Optional live scrape verification**

Run only with valid session/auth:

```bash
node --import tsx src/cli/scrape-purchases.ts
```

Expected: stable scrape with populated metrics written to `purchases-data.json`.

**Step 4: Commit**

```bash
git add src/cli/scrape-purchases.ts src/cli/assess-purchases.ts src/lib/purchasing/purchases-guidance-parser.ts src/lib/purchasing/purchases-guidance-comparison.ts purchases-data.json
git commit -m "feat(purchasing): add validated purchases guidance ingestion"
```
