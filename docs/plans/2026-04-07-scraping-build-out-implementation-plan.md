# Scraping Build Out Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden Playwright browser access for scraping, execute immediate assessment of purchasing data, and wire full automation pipeline for purchasing intelligence.

**Architecture:** Incremental single-responsibility tasks: first create shared browser utilities, then validate with live assessment execution, then integrate cron automation and bot tools. Uses TypeScript singleton patterns for reusability and comprehensive testing with TypeScript errors resolved.

**Tech Stack:** Playwright (browser automation), TypeScript (node.js), Supabase (snapshots), Finale API (data comparisons), Telegram bot (notifications), fuzzy matching (sklearn-style for SKUs).

---

### Task 1: Create Browser Manager Singleton

**Files:**
- Create: `src/lib/scraping/browser-manager.ts`
- Test: `src/lib/scraping/browser-manager.test.ts`

**Step 1: Write failing integration test**

```typescript
// src/lib/scraping/browser-manager.test.ts
import { BrowserManager } from './browser-manager';
import { expect } from '@jest/globals'; // assuming jest setup

test('can launch browser and load page', async () => {
  const manager = BrowserManager.getInstance();
  const page = await manager.launchBrowser({ headless: true });
  await page.goto('https://example.com');
  expect(await page.title()).toBe('Example Domain');
  await manager.close();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run typecheck:cli; if ($?) { cd src/lib/scraping; npx jest browser-manager.test.ts }`
Expected: FAIL with "BrowserManager.getInstance is not a function"

**Step 3: Write minimal singleton class**

```typescript
// src/lib/scraping/browser-manager.ts
import { chromium, BrowserContext, Page } from 'playwright';

export interface BrowserOptions {
  headless?: boolean;
  cookiesPath?: string;
  userAgent?: string;
}

export class BrowserManager {
  private static instance: BrowserManager;
  private browser: any;
  private context: BrowserContext | null = null;

  private constructor() {}

  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  async launchBrowser(options: BrowserOptions = {}): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: options.headless ?? true,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
      });
    }
    this.context = await this.browser.newContext();
    const page = await this.context.newPage();
    return page;
  }

  async close(): Promise<void> {
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    this.context = null;
    this.browser = null;
  }

  async checkSession(testUrl: string): Promise<boolean> {
    try {
      const page = await this.launchBrowser({ headless: true });
      await page.goto(testUrl);
      const url = page.url();
      await this.close();
      return !url.includes('/auth/signin');
    } catch {
      return false;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd src/lib/scraping; npx jest browser-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/scraping/browser-manager.ts src/lib/scraping/browser-manager.test.ts
git commit -m "feat: add browser manager singleton for scraping"
```

### Task 2: Harden ULINE Scraper with Browser Manager

**Files:**
- Modify: `src/cli/reconcile-uline.ts:50-100` (inject browser manager)
- Test: Run existing script without changes

**Step 1: Write integration test for hardening**

Run manual test: `node --import tsx src/cli/reconcile-uline.ts --dry-run`
Expected: Works as before (switches without breaking)

**Step 2: Integrate browser manager**

Replace `launchPersistentContext` with `BrowserManager.getInstance().launchBrowser()`, add cookie loading from `.uline-session.json`.

```typescript
// In reconcile-uline.ts
import { BrowserManager } from '@/lib/scraping/browser-manager';

// During login setup
const manager = BrowserManager.getInstance();
const page = await manager.launchBrowser({ headless: false }); // visible for cookie persistence
await page.context().addCookies(cookiesFromFile('.uline-session.json'));
```

**Step 3: Run test to verify it works**

Run: `node --import tsx src/cli/reconcile-uline.ts --dry-run`
Expected: Same output, no errors

**Step 4: Commit**

```bash
git add src/cli/reconcile-uline.ts
git commit -m "refactor: harden uline scraper with browser manager"
```

### Task 3: Harden Purchasing Dashboard Scraper

**Files:**
- Modify: `src/cli/scrape-purchases.ts:100-200` (integrate browser manager)
- Test: Run against test data

**Step 1: Mock test data**

Create minimal `purchases-data-test.json` with 1 vendor/1 item.

**Step 2: Integrate browser manager**

Replace headless browser launch with `BrowserManager.getInstance().launchBrowser()`, add session check.

```typescript
// In scrape-purchases.ts
const manager = BrowserManager.getInstance();
const sessionValid = await manager.checkSession(dashboardUrl);
if (!sessionValid) throw new Error('Session expired');
const page = await manager.launchBrowser();
await page.context().addCookies(cookiesFromFile('.basauto-session.json'));
```

**Step 3: Run test**

Run: `node --import tsx src/cli/scrape-purchases.ts --data purchases-data-test.json`
Expected: Scrapes test data successfully

**Step 4: Commit**

```bash
git add src/cli/scrape-purchases.ts
git commit -m "refactor: harden purchasing scraper with session checks"
```

### Task 4: Run Immediate Assess-Purchases Assessment

**Files:**
- Run: `src/cli/assess-purchases.ts`

**Step 1: Run assessment**

Run: `node --import tsx src/cli/assess-purchases.ts`

**Step 2: Verify output**

Expected: Console summary classifying 38 items (e.g., X HIGH_NEED, Y NOISE)

**Step 3: Document findings**

Note which "overdue" items are actually critical vs noise.

**Step 4: Commit**

```bash
git add -p debug/assessment-output.json  # if added
git commit -m "feat: initial assess-purchases run against live data"
```

### Task 5: Extend Assess-Purchases with Fuzzy SKU Matching

**Files:**
- Modify: `src/cli/assess-purchases.ts:200-300` (add fuzzy match)
- Create: `src/lib/scraping/fuzzy-matcher.ts` (reuse from watchdog)

**Step 1: Add failing test**

```typescript
test('matches fuzzy item to SKU', () => {
  const matcher = new FuzzyMatcher(skus);
  expect(matcher.match('H-255BL Sharpies')).toBe('H-255BL');
});
```

**Step 2: Implement matcher**

Import from `@/lib/slack/watchdog` utility.

**Step 3: Add to assess**

After loading `purchases-data.json`, map each item.details to SKU using matcher, filter `status === 'Pending'`.

**Step 4: Run test**

Expected: Classifications update with matched SKUs

**Step 5: Commit**

```bash
git add src/cli/assess-purchases.ts src/lib/scraping/fuzzy-matcher.ts
git commit -m "feat: add fuzzy SKU matching to assess-purchases"
```

### Task 6: Wire OpsManager Cron Job

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts:800-1000` (add cron)
- Test: Simulate cron run

**Step 1: Add cron definition**

```typescript
// Mon-Fri 9AM
cron.schedule('0 9 * * 1-5', async () => {
  const result = await runPurchasingPipeline();
  const diffs = await diffAgainstSupabase(result);
  await telegramNotify(diffs.newHighNeeds);
});
```

**Step 2: Implement pipeline function**

Extract scrape/assess/diff logic into `src/lib/scraping/purchasing-pipeline.ts`

**Step 3: Test simulation**

Run: `node --import tsx src/lib/scraping/purchasing-pipeline.ts`
Expected: Runs without errors

**Step 4: Commit**

```bash
git add src/lib/intelligence/ops-manager.ts src/lib/scraping/purchasing-pipeline.ts
git commit -m "feat: wire purchasing assessment into ops-manager cron"
```

### Task 7: Add Bot Tool for On-Demand Scraping

**Files:**
- Modify: `src/cli/start-bot.ts:500-600` (add tool)
- Test: Chat test

**Step 1: Add tool definition**

```typescript
{
  type: 'function',
  function: {
    name: 'scrape_purchasing_dashboard',
    description: 'Scrape latest purchasing data and assess',
    parameters: { type: 'object', properties: {} }
  }
}
```

**Step 2: Implement handler**

Call `runPurchasingPipeline()`, format results as chat response.

**Step 3: Restart bot and test**

Run bot, call tool: "/scrape_purchasing_dashboard"
Expected: Returns assessment summary

**Step 4: Commit**

```bash
git add src/cli/start-bot.ts
git commit -m "feat: add on-demand scrape tool to telegram bot"
```

### Task 8: Add Cookie Expiry Reminder

**Files:**
- Modify: `src/lib/scraping/purchasing-pipeline.ts:50-100` (check expiry)

**Step 1: Check for expiry**

After scrape, if URL includes '/auth/signin', await telegramReminder('Session expired 2026-05-07. Refresh .basauto-session.json').

**Step 2: Test reminder**

Simulate expired cookies, run pipeline.
Expected: Telegram message sent

**Step 3: Commit**

```bash
git add src/lib/scraping/purchasing-pipeline.ts
git commit -m "feat: add cookie expiry auto-reminder to telegram"
```

### Task 9: Create Supabase Snapshot Table

**Files:**
- Modify: `supabase/migrations/<new>.sql` (add table)
- Run migration

**Step 1: Write migration**

```sql
CREATE TABLE purchasing_dash_snapshots (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  data JSONB,
  checksum TEXT
);
```

**Step 2: Apply migration**

Run: `node _run_migration.js supabase/migrations/20260407_create_snapshots.sql`

**Step 3: Verify table**

Query Supabase: SELECT * FROM purchasing_dash_snapshots;

**Step 4: Commit**

```bash
git add supabase/migrations/
git commit -m "feat: add purchasing snapshots table"
```