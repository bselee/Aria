# Purchasing Intelligence Automation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build automated purchasing intelligence: scrape dashboard → assess items against Finale → classify need levels → notify Telegram of new HIGH_NEED items and pending requests

**Architecture:** Centralized Playwright scraper with session management, assessor that cross-references Finale inventory/POs/velocity, OpsManager cron integration, Telegram notifications, and on-demand bot tool

**Tech Stack:** Playwright, Finale API, Supabase (snapshot storage), Telegram bot, fuzzy matching, TypeScript

---

## Task 1: Examine Existing Code Structure

**Files to read:**
- `src/cli/assess-purchases.ts` (if exists)
- `src/lib/finale/client.ts`
- `src/lib/intelligence/ops-manager.ts`
- `src/cli/start-bot.ts`
- `src/lib/slack/watchdog.ts` (for fuzzy matcher)
- `src/cli/test-ap-routing.ts` (for Playwright patterns)
- `src/cli/fetch-fedex-csv.ts` (for persistent Chrome patterns)

**Steps:**
1. Read these files to understand existing implementations
2. Identify what assess-purchases.ts already does
3. Note the fuzzy matching logic in Slack watchdog
4. Understand OpsManager cron pattern
5. Understand how bot tools are defined in start-bot.ts

**Expected:** Clear understanding of existing code patterns and what needs to be built/extended

---

## Task 2: Create Hardened Playwright Scraper Module

**Files:**
- Create: `src/lib/scraping/purchasing-dashboard.ts`
- Create: `src/lib/scraping/session-manager.ts`

**Step 1: Write session manager**

```typescript
// src/lib/scraping/session-manager.ts
import { chromium, Browser, BrowserContext } from 'playwright';

class SessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private sessionPath: string;

  constructor() {
    this.sessionPath = process.env.PLAYWRIGHT_SESSION_PATH || '.basauto-session.json';
  }

  async ensureContext(): Promise<BrowserContext> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: 'new',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox'
        ]
      });
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        userDataDir: process.env.PLAYWRIGHT_USER_DATA_DIR || './chrome-profile',
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
        bypassCSP: true
      });

      // Anti-detection
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
      });
    }

    return this.context;
  }

  async checkSessionValidity(): Promise<boolean> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    
    try {
      const response = await page.goto('https://dashboard.finalewares.com', { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      
      // Check if redirected to sign-in
      if (response?.url().includes('/auth/signin')) {
        return false;
      }
      
      return response?.ok() || false;
    } catch (error) {
      console.error('Session validation failed:', error);
      return false;
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const sessionManager = new SessionManager();
export type { SessionManager };
```

**Step 2: Write purchasing dashboard scraper**

```typescript
// src/lib/scraping/purchasing-dashboard.ts
import { sessionManager } from './session-manager';
import { Page } from 'playwright';

interface PurchaseItem {
  sku: string;
  details: string;
  vendor: string;
  quantity: number;
  unit_price: number;
  total: number;
  status: string;
  requested_date: string;
  last_updated: string;
}

interface ScrapeResult {
  items: PurchaseItem[];
  timestamp: string;
  vendorCount: number;
}

export async function scrapePurchasingDashboard(): Promise<ScrapeResult> {
  const context = await sessionManager.ensureContext();
  const page = await context.newPage();

  try {
    // Navigate to dashboard
    await page.goto('https://dashboard.finalewares.com/purchasing', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    // Wait for data to load
    await page.waitForSelector('[data-testid="purchasing-table"], table', { 
      timeout: 30000 
    });

    // Extract items - adapt selectors to actual dashboard structure
    const items = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('td');
        return {
          sku: cells[0]?.textContent?.trim() || '',
          details: cells[1]?.textContent?.trim() || '',
          vendor: cells[2]?.textContent?.trim() || '',
          quantity: parseFloat(cells[3]?.textContent?.trim() || '0'),
          unit_price: parseFloat(cells[4]?.textContent?.trim() || '0'),
          total: parseFloat(cells[5]?.textContent?.trim() || '0'),
          status: cells[6]?.textContent?.trim() || '',
          requested_date: cells[7]?.textContent?.trim() || '',
          last_updated: cells[8]?.textContent?.trim() || ''
        };
      });
    }) as PurchaseItem[];

    // Extract vendor count
    const vendorCount = await page.evaluate(() => {
      const vendors = new Set<string>();
      document.querySelectorAll('table tbody tr td:nth-child(3)').forEach(cell => {
        vendors.add(cell.textContent?.trim() || '');
      });
      return vendors.size;
    });

    return {
      items,
      timestamp: new Date().toISOString(),
      vendorCount
    };
  } finally {
    await page.close();
  }
}

export async function validateSessionAndScrape(): Promise<ScrapeResult | { error: string }> {
  const isValid = await sessionManager.checkSessionValidity();
  
  if (!isValid) {
    return { 
      error: 'SESSION_EXPIRED', 
      message: 'Dashboard session expired. Refresh .basauto-session.json from DevTools.' 
    };
  }

  return await scrapePurchasingDashboard();
}
```

**Step 3: Update .env.local with PLAYWRIGHT_* variables**

---

## Task 3: Extend assess-purchases.ts

**Files:**
- Modify: `src/cli/assess-purchases.ts` (create if doesn't exist)
- Create: `src/cli/assess-purchases.ts` if missing

**Step 1: Create assess-purchases.ts with existing logic**

```typescript
// src/cli/assess-purchases.ts
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { getPurchasingIntelligence } from '@/lib/finale/client';
import { ScrapeResult, PurchaseItem } from '@/lib/scraping/purchasing-dashboard';

interface AssessedItem extends PurchaseItem {
  finaleSku?: string;
  stock: number;
  velocity: number;
  leadTime: number;
  openPOs: number;
  classification: 'HIGH_NEED' | 'MEDIUM' | 'LOW' | 'NOISE';
  rationale: string;
}

async function assessItems(items: PurchaseItem[]): Promise<AssessedItem[]> {
  const finaleData = await getPurchasingIntelligence(365);
  
  return items.map(item => {
    const matchingSku = finaleData.items.find(i => 
      i.sku.toLowerCase() === item.sku.toLowerCase() ||
      (item.details && item.details.toLowerCase().includes(i.sku.toLowerCase()))
    );

    if (!matchingSku) {
      return {
        ...item,
        stock: 0,
        velocity: 0,
        leadTime: 0,
        openPOs: 0,
        classification: 'NOISE',
        rationale: 'No matching SKU in Finale'
      };
    }

    // Classification logic
    const runwayDays = matchingSku.stock / Math.max(matchingSku.velocity, 0.001);
    let classification: AssessedItem['classification'];
    let rationale = '';

    if (runwayDays < matchingSku.leadTime * 0.5 || matchingSku.urgency === 'CRITICAL') {
      classification = 'HIGH_NEED';
      rationale = `Stock ${matchingSku.stock} units, runway ${runwayDays.toFixed(1)}d < 50% lead time ${matchingSku.leadTime}d`;
    } else if (runwayDays < matchingSku.leadTime || matchingSku.urgency === 'WARNING') {
      classification = 'MEDIUM';
      rationale = `Runway ${runwayDays.toFixed(1)}d near lead time ${matchingSku.leadTime}d`;
    } else if (matchFinalStatus(item.status, 'OVERDUE') && runwayDays < matchingSku.leadTime + 30) {
      classification = 'LOW';
      rationale = 'Status overdue but adequate stock';
    } else {
      classification = 'LOW';
      rationale = 'Adequate stock levels';
    }

    return {
      ...item,
      finaleSku: matchingSku.sku,
      stock: matchingSku.stock,
      velocity: matchingSku.velocity,
      leadTime: matchingSku.leadTime,
      openPOs: matchingSku.committedPOs?.reduce((sum, po) => sum + po.quantity, 0) || 0,
      classification,
      rationale
    };
  });
}

function matchFinalStatus(itemStatus: string, overdueKeyword: string): boolean {
  return itemStatus.toLowerCase().includes(overdueKeyword.toLowerCase());
}

async function main() {
  const dataPath = process.argv[2] || 'purchases-data.json';
  const raw = await readFile(dataPath, 'utf-8');
  const scrapeResult: ScrapeResult = JSON.parse(raw);

  const assessed = await assessItems(scrapeResult.items);

  // Filter to show only truly overdue items
  const overdueItems = assessed.filter(item => 
    matchFinalStatus(item.status, 'OVERDUE') && item.classification !== 'NOISE'
  );

  const stats = {
    total: assessed.length,
    highNeed: assessed.filter(i => i.classification === 'HIGH_NEED').length,
    medium: assessed.filter(i => i.classification === 'MEDIUM').length,
    low: assessed.filter(i => i.classification === 'LOW').length,
    noise: assessed.filter(i => i.classification === 'NOISE').length,
    overdue: overdueItems.length,
    trulyOverdue: overdueItems.filter(i => 
      i.classification === 'HIGH_NEED' || i.classification === 'MEDIUM'
    ).length
  };

  const output = {
    scrapeResult,
    assessed,
    stats,
    recommendations: {
      highNeed: assessed.filter(i => i.classification === 'HIGH_NEED'),
      pendingRequests: [] // populated in Task 4
    }
  };

  await writeFile('assessed-purchases.json', JSON.stringify(output, null, 2));
  console.log('Assessment complete:', stats);
}

main().catch(console.error);
```

**Step 2: Add fuzzy matching for purchase-requests.json**

```typescript
// Add to assess-purchases.ts (extend main function)
import { fuzzyMatchSku } from '@/lib/slack/watchdog'; // reuse this

interface PurchaseRequest {
  id: string;
  details: string;
  status: string;
  requested_by: string;
  requested_date: string;
}

async function assessPurchaseRequests(requests: PurchaseRequest[], finaleData: any): Promise<any[]> {
  return Promise.all(requests.map(async (req) => {
    // Fuzzy match details string to SKU
    const match = await fuzzyMatchSku(req.details, finaleData.items);
    
    if (!match) {
      return {
        ...req,
        finaleMatch: null,
        classification: 'NOISE',
        rationale: 'Could not fuzzy match to Finale SKU'
      };
    }

    // Reuse item assessment logic
    const item: PurchaseItem = {
      sku: match.sku,
      details: req.details,
      vendor: match.vendor || '',
      quantity: 1,
      unit_price: 0,
      total: 0,
      status: req.status,
      requested_date: req.requested_date,
      last_updated: req.requested_date
    };

    const assessed = await assessItems([item]);
    return {
      ...req,
      finaleMatch: match,
      ...assessed[0]
    };
  }));
}
```

**Step 3: Integrate both data sources**

```typescript
async function main() {
  // Load both data files
  const [purchasesRaw, requestsRaw] = await Promise.all([
    readFile('purchases-data.json', 'utf-8'),
    readFile('purchase-requests.json', 'utf-8')
  ]);

  const scrapeResult: ScrapeResult = JSON.parse(purchasesRaw);
  const purchaseRequests: PurchaseRequest[] = JSON.parse(requestsRaw);

  const finaleData = await getPurchasingIntelligence(365);
  
  const assessedItems = await assessItems(scrapeResult.items);
  const assessedRequests = await assessPurchaseRequests(
    purchaseRequests.filter(r => r.status === 'Pending'),
    finaleData
  );

  // Combine stats and output
  const allAssessed = [...assessedItems, ...assessedRequests];
  
  const stats = {
    items: {
      total: assessedItems.length,
      highNeed: assessedItems.filter(i => i.classification === 'HIGH_NEED').length,
      medium: assessedItems.filter(i => i.classification === 'MEDIUM').length,
      low: assessedItems.filter(i => i.classification === 'LOW').length,
      noise: assessedItems.filter(i => i.classification === 'NOISE').length
    },
    requests: {
      total: assessedRequests.length,
      highNeed: assessedRequests.filter(r => r.classification === 'HIGH_NEED').length,
      medium: assessedRequests.filter(r => r.classification === 'MEDIUM').length,
      low: assessedRequests.filter(r => r.classification === 'LOW').length,
      noise: assessedRequests.filter(r => r.classification === 'NOISE').length
    }
  };

  const output = {
    scrapeResult,
    purchaseRequests,
    assessedItems,
    assessedRequests,
    stats,
    timestamp: new Date().toISOString()
  };

  await writeFile('assessed-purchases.json', JSON.stringify(output, null, 2));
  await writeFile(`assessed-snapshots/${new Date().toISOString().split('T')[0]}.json`, JSON.stringify(output, null, 2));
  console.log('Assessment complete:', stats);
}
```

---

## Task 4: Create Supabase Snapshot Storage

**Files:**
- Modify: `src/lib/supabase.ts` (add purchasing snapshots table)
- Create migration: `supabase/migrations/20260407_create_purchasing_snapshots.sql`

**Step 1: Create migration**

```sql
-- supabase/migrations/20260407_create_purchasing_snapshots.sql
CREATE TABLE IF NOT EXISTS purchasing_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot_date DATE NOT NULL,
  items_count INT NOT NULL,
  requests_count INT NOT NULL,
  high_need_count INT NOT NULL,
  medium_need_count INT NOT NULL,
  low_need_count INT NOT NULL,
  noise_count INT NOT NULL,
  snapshot_data JSONB NOT NULL,
  UNIQUE(snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_purchasing_snapshots_date ON purchasing_snapshots(snapshot_date DESC);
```

**Step 2: Apply migration**

```bash
node _run_migration.js supabase/migrations/20260407_create_purchasing_snapshots.sql
```

**Step 3: Add helper function**

```typescript
// src/lib/purchasing/snapshot.ts
import { supabase } from '@/lib/supabase';

export async function saveSnapshot(data: any, stats: any): Promise<void> {
  const { error } = await supabase
    .from('purchasing_snapshots')
    .upsert({
      snapshot_date: new Date().toISOString().split('T')[0],
      items_count: stats.items.total,
      requests_count: stats.requests.total,
      high_need_count: stats.items.highNeed + stats.requests.highNeed,
      medium_need_count: stats.items.medium + stats.requests.medium,
      low_need_count: stats.items.low + stats.requests.low,
      noise_count: stats.items.noise + stats.requests.noise,
      snapshot_data: data
    });

  if (error) throw error;
}

export async function getPreviousSnapshot(date: string): Promise<any> {
  const { data } = await supabase
    .from('purchasing_snapshots')
    .select('*')
    .eq('snapshot_date', date)
    .single();

  return data;
}
```

---

## Task 5: Add Telegram Notification Logic

**Files:**
- Modify: `src/cli/assess-purchases.ts`
- Add: `src/lib/intelligence/purchasing-notifier.ts`

**Step 1: Create notifier**

```typescript
// src/lib/intelligence/purchasing-notifier.ts
import { Telegraf } from 'telegraf';
import { getBot } from '@/lib/intelligence/bot-context'; // adjust based on actual pattern

interface NewHighNeedItem {
  sku: string;
  details: string;
  vendor: string;
  classification: string;
  rationale: string;
  stock: number;
  velocity: number;
  runwayDays: number;
}

export async function sendHighNeedAlert(items: NewHighNeedItem[], requests: any[]): Promise<void> {
  const bot = getBot();
  if (!bot) throw new Error('Bot not initialized');

  let message = '🔴 **HIGH NEED PURCHASING ALERT**\n\n';
  
  if (items.length > 0) {
    message += `**${items.length} NEW HIGH_NEED items:**\n`;
    items.forEach(item => {
      message += `• ${item.sku} (${item.vendor}): ${item.stock} stock, ${item.runwayDays.toFixed(1)}d runway\n`;
      message += `  ${item.rationale}\n\n`;
    });
  }

  if (requests.length > 0) {
    message += `**${requests.length} HIGH_NEED pending requests:**\n`;
    requests.forEach(req => {
      message += `• ${req.sku || req.details.substring(0, 30)}: ${req.rationale}\n\n`;
    });
  }

  await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID!, message, {
    parse_mode: 'Markdown'
  });
}

export async function sendSessionExpiredReminder(): Promise<void> {
  const bot = getBot();
  if (!bot) throw new Error('Bot not initialized');

  const message = `⚠️ **Dashboard Session Expired**\n\n` +
    `The Playwright session has expired (redirected to /auth/signin).\n` +
    `Please refresh your session cookie:\n\n` +
    `1. Open Chrome DevTools on Finale dashboard\n` +
    `2. Copy cookies from Application → Storage → Cookies\n` +
    `3. Update .basauto-session.json in project root\n` +
    `4. Restart aria-bot\n\n` +
    `Cookie expires: 2026-05-07 (30 days from now)`;

  await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID!, message, {
    parse_mode: 'Markdown'
  });
}
```

---

## Task 6: Integrate into OpsManager Cron

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`
- New method in OpsManager: `schedulePurchasingIntelligenceCron()`

**Step 1: Add cron method**

```typescript
// src/lib/intelligence/ops-manager.ts (extend class)
import { schedulePurchasingIntelligenceRun } from './purchasing-cron';

export class OpsManager {
  // ... existing code ...

  schedulePurchasingIntelligenceCron(): void {
    // Run Mon-Fri at 9:00 AM
    this.scheduler.cron('0 9 * * 1-5', async () => {
      this.logger.info('Starting purchasing intelligence assessment');
      
      try {
        await schedulePurchasingIntelligenceRun();
      } catch (error) {
        this.logger.error('Purchasing assessment failed:', error);
        // Optionally send error Telegram notification
      }
    });

    this.logger.info('Scheduled purchasing intelligence cron: Mon-Fri 9:00 AM');
  }

  async initialize(): Promise<void> {
    // ... existing initialization ...
    this.schedulePurchasingIntelligenceCron();
  }
}
```

**Step 2: Create cron runner**

```typescript
// src/lib/intelligence/purchasing-cron.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import { scrapePurchasingDashboard, validateSessionAndScrape } from '@/lib/scraping/purchasing-dashboard';
import { runAssessment } from '@/cli/assess-purchases';
import { saveSnapshot } from '@/lib/purchasing/snapshot';
import { sendHighNeedAlert, sendSessionExpiredReminder } from '@/lib/intelligence/purchasing-notifier';

const execAsync = promisify(exec);

export async function schedulePurchasingIntelligenceRun(): Promise<void> {
  // 1. Scrape dashboard
  const scrapeResult = await validateSessionAndScrape();
  
  if ('error' in scrapeResult) {
    await sendSessionExpiredReminder();
    throw new Error(scrapeResult.message);
  }

  await writeFile('purchases-data.json', JSON.stringify(scrapeResult, null, 2));
  
  // 2. Run assessment
  await runAssessment(); // this should output assessed-purchases.json and create snapshot
  
  // 3. Load assessment output
  const assessment = JSON.parse(await readFile('assessed-purchases.json', 'utf-8'));
  
  // 4. Get previous snapshot (yesterday)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const prevDate = yesterday.toISOString().split('T')[0];
  
  try {
    const previous = await getPreviousSnapshot(prevDate);
    if (previous) {
      const prevData = previous.snapshot_data;
      
      // Diff: find new HIGH_NEED items not in previous
      const prevHighNeedSkus = new Set(
        prevData.assessedItems
          .filter((i: any) => i.classification === 'HIGH_NEED')
          .map((i: any) => i.sku)
      );
      
      const prevHighNeedReqs = new Set(
        prevData.assessedRequests
          .filter((r: any) => r.classification === 'HIGH_NEED')
          .map((r: any) => r.id)
      );

      const newHighNeedItems = assessment.assessedItems.filter((i: any) => 
        i.classification === 'HIGH_NEED' && !prevHighNeedSkus.has(i.sku)
      );

      const newHighNeedRequests = assessment.assessedRequests.filter((r: any) => 
        r.classification === 'HIGH_NEED' && !prevHighNeedReqs.has(r.id)
      );

      if (newHighNeedItems.length > 0 || newHighNeedRequests.length > 0) {
        await sendHighNeedAlert(newHighNeedItems, newHighNeedRequests);
      }
    }
  } catch (error) {
    this.logger.warn('Could not compare with previous snapshot:', error);
    // Still send all HIGH_NEED if no previous data
    const allHighItems = assessment.assessedItems.filter((i: any) => i.classification === 'HIGH_NEED');
    const allHighReqs = assessment.assessedRequests.filter((r: any) => r.classification === 'HIGH_NEED');
    await sendHighNeedAlert(allHighItems, allHighReqs);
  }
}
```

---

## Task 7: Add Bot Tool for On-Demand Scrape

**Files:**
- Modify: `src/cli/start-bot.ts`

**Step 1: Add tool definition**

```typescript
// In start-bot.ts where tools are defined
bot.command('scrape_purchasing_dashboard', async (ctx) => {
  await ctx.reply('🔄 Scraping purchasing dashboard...');
  
  try {
    const result = await validateSessionAndScrape();
    
    if ('error' in result) {
      await ctx.reply(`❌ Session error: ${result.message}`);
      return;
    }

    await writeFile('purchases-data.json', JSON.stringify(result, null, 2));
    
    const msg = `✅ Scrape complete:\n` +
      `• ${result.items.length} items\n` +
      `• ${result.vendorCount} vendors\n` +
      `• ${new Date(result.timestamp).toLocaleTimeString()}`;
    
    await ctx.reply(msg);
    
    // Optionally auto-run assessment
    await ctx.reply('🔍 Running assessment... (separate)');
    // Defer: run assess-purchases.ts in separate process
  } catch (error: any) {
    await ctx.reply(`❌ Scrape failed: ${error.message}`);
  }
});

bot.help('scrape_purchasing_dashboard', 'Force fresh scrape of purchasing dashboard');
```

---

## Task 8: Cookie Expiration Implementation

**Files:**
- Modify: `src/lib/scraping/session-manager.ts` (already includes checkSessionValidity)
- Already integrated in Task 7 and cron

**Implementation:** Already in `validateSessionAndScrape()`: checks for redirect to `/auth/signin` and returns error. This triggers Telegram reminder via `sendSessionExpiredReminder()`.

---

## Task 9: Environment Configuration

**Files:**
- Update: `.env.local` (add variables)
- Create: `.env.example` update

**Add:**
```
PLAYWRIGHT_SESSION_PATH=.basauto-session.json
PLAYWRIGHT_USER_DATA_DIR=./chrome-profile
```

---

## Task 10: Testing and Validation

**Files:**
- Create: `src/cli/test-purchasing-scraper.ts`
- Create: `src/cli/test-purchasing-assessment.ts`

**Test scraper:**
```typescript
// src/cli/test-purchasing-scraper.ts
import { scrapePurchasingDashboard, validateSessionAndScrape } from '@/lib/scraping/purchasing-dashboard';

async function test() {
  console.log('Testing session validation...');
  const validity = await validateSessionAndScrape();
  
  if ('error' in validity) {
    console.log('Session invalid:', validity.message);
  } else {
    console.log(`Session valid. Scraped ${validity.items.length} items from ${validity.vendorCount} vendors`);
  }
}

test().catch(console.error);
```

**Test assessment:**
```typescript
// src/cli/test-purchasing-assessment.ts
import { runAssessment } from '@/cli/assess-purchases';

async function test() {
  await runAssessment();
  const output = JSON.parse(await readFile('assessed-purchases.json', 'utf-8'));
  console.log('Assessment stats:', output.stats);
}

test().catch(console.error);
```

---

## Task 11: Documentation

**Files:**
- Create: `docs/operational-guides/purchasing-intelligence.md`

**Content:**
- Overview of system
- Session cookie refresh procedure (30-day expiry)
- Manual trigger commands
- Cron schedule
- Troubleshooting

---

## Implementation Order

1. Examine existing code (Task 1)
2. Create Playwright scraper with session management (Task 2)
3. Create/verify assess-purchases.ts (Task 3)
4. Add fuzzy matching integration (Task 3)
5. Create Supabase snapshot storage (Task 4)
6. Create Telegram notifier (Task 5)
7. Integrate into OpsManager cron (Task 6)
8. Add bot tool (Task 7)
9. Test all components (Task 10)
10. Document operational guide (Task 11)

---

**Next steps:** Use subagent-driven-development skill to implement tasks sequentially, with verification between each task. Each task should include typechecking and manual testing where appropriate.
