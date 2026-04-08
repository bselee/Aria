# Purchasing Intelligence Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a fully automated purchasing assessment system that scrapes the basauto dashboard, assesses items against Finale inventory, detects new critical needs, and surfaces actionable insights via Telegram and bot commands.

**Architecture:**
1. Scraper (Playwright) → purchases-data.json + purchase-requests.json
2. Assessor (assess-purchases.ts) → cross-references with Finale → HIGH_NEED/MEDIUM/LOW/NOISE
3. Snapshot storage in Supabase for diffing
4. OpsManager cron (9 AM Mon-Fri) orchestrates: scrape → assess → diff → notify
5. Telegram bot tool for on-demand execution
6. Cookie expiry detection in scraper with proactive reminders

**Tech Stack:** Playwright, Finale GraphQL/REST, Supabase, Telegram Bot (telegraf), node-cron, Fuse.js (fuzzy matching), TypeScript/tsx

---

## Task 1: Refactor assess-purchases.ts to be modular and importable

**Files:**
- Modify: `src/cli/assess-purchases.ts`
- Create: `src/lib/purchasing/assessor.ts` (core logic)
- Create: `src/lib/purchasing/types.ts` (shared interfaces)

**Step 1:** Extract core assessment logic into pure functions

Create `src/lib/purchasing/types.ts` with:
```typescript
export interface AssessedItem {
  sku: string;
  description: string;
  scrapedUrgency: string;
  necessity: 'HIGH_NEED' | 'MEDIUM' | 'LOW' | 'NOISE';
  stockOnHand: number;
  stockOnOrder: number;
  salesVelocity: number;
  purchaseVelocity: number;
  dailyRate: number;
  runwayDays: number;
  adjustedRunwayDays: number;
  leadTimeDays: number;
  openPOs: Array<{ orderId: string; quantity: number; orderDate: string }>;
  explanation: string;
  finaleFound: boolean;
  doNotReorder: boolean;
}

export interface VendorAssessment {
  vendor: string;
  items: AssessedItem[];
  highNeedCount: number;
  mediumCount: number;
  noiseCount: number;
}

export interface ScrapedItem {
  sku: string;
  description: string;
  urgency: string;
  [key: string]: string;
}

export type ScrapedData = Record<string, ScrapedItem[]>;
```

**Step 2:** Move assessment engine to `src/lib/purchasing/assessor.ts`

Extract these functions:
- `getSkuActivity()` (unchanged from current assess-purchases.ts:61-201)
- `computeNecessity()` (unchanged:212-266)
- `assessScrapedItems(scrapedData: ScrapedData, finaleClient: FinaleClient, daysBack?: number): Promise<VendorAssessment[]>` — the main processing loop (from line 270-443)
- `formatAssessmentReport(vendorAssessments: VendorAssessment[], jsonOutput?: boolean): string` — output formatting (lines 445-499)

Keep the GraphQL query and parseNum helper intact.

**Step 3:** Simplify CLI entry point

Modify `src/cli/assess-purchases.ts` to:
- Import from `../lib/purchasing/assessor`
- Just handle CLI args (--json, --vendor)
- Load JSON file
- Call `assessScrapedItems()`
- Print `formatAssessmentReport()`

**Step 4:** Add TypeScript types and test compile

Run: `npm run typecheck:cli`
Fix any errors. Ensure exports work.

**Step 5:** Commit

```bash
git add src/cli/assess-purchases.ts src/lib/purchasing/
git commit -m "refactor: modularize assess-purchases into importable library"
```

---

## Task 2: Add fuzzy SKU matching for purchase requests

**Files:**
- Create: `src/lib/purchasing/request-matcher.ts`
- Modify: `src/cli/assess-purchases.ts` to also handle requests
- Create: `src/cli/assess-requests.ts` (new standalone CLI)

**Step 1:** Create request matcher using Fuse.js

Create `src/lib/purchasing/request-matcher.ts`:

```typescript
import { FinaleClient } from '../finale/client';
import Fuse from 'fuse.js';

interface ProductCatalogEntry {
  sku: string;
  name: string;
  vendor?: string;
}

export class RequestMatcher {
  private fuse: Fuse<ProductCatalogEntry> | null = null;
  private finaleClient: FinaleClient;

  constructor(finaleClient: FinaleClient) {
    this.finaleClient = finaleClient;
  }

  async buildCatalog() {
    const supabase = await import('../supabase');
    const db = supabase.createClient();
    if (!db) return;

    const { data: pos } = await db
      .from('purchase_orders')
      .select('line_items, vendor_name')
      .order('created_at', { ascending: false })
      .limit(100);

    const products: ProductCatalogEntry[] = [];
    const seen = new Set<string>();

    for (const po of (pos || [])) {
      for (const item of (po.line_items || [])) {
        const key = (item.sku || item.description || '').toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          products.push({
            sku: item.sku || 'N/A',
            name: item.description || item.name || key,
            vendor: po.vendor_name,
          });
        }
      }
    }

    this.fuse = new Fuse(products, {
      keys: ['name', 'sku'],
      threshold: 0.4,
      includeScore: true,
      minMatchCharLength: 3,
    });
  }

  fuzzyMatch(query: string): { product: ProductCatalogEntry; score: number } | null {
    if (!this.fuse) return null;
    const results = this.fuse.search(query);
    if (results.length === 0) return null;
    const best = results[0];
    return { product: best.item, score: 1 - (best.score || 1) };
  }

  async getAssessedRequest(
    request: any,
    daysBack: number = 90
  ): Promise<{ request: any; assessment: any | null; matchedSku: string | null }> {
    const details = request.details || '';
    const match = this.fuzzyMatch(details);

    if (!match) {
      return { request, assessment: null, matchedSku: null };
    }

    // Use the existing assessor to evaluate the matched SKU
    const { assessScrapedItems } = await import('./assessor');
    const scrapedData: ScrapedData = {
      'MatchedRequest': [{
        sku: match.product.sku,
        description: match.product.name,
        urgency: 'REQUEST',
      }],
    };

    const assessments = await assessScrapedItems(
      scrapedData,
      this.finaleClient,
      daysBack
    );

    const assessment = assessments[0]?.items[0] || null;
    return { request, assessment, matchedSku: match.product.sku };
  }
}
```

**Step 2:** Create standalone CLI for request assessment

Create `src/cli/assess-requests.ts`:

```typescript
#!/usr/bin/env node
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as fs from 'fs';
import * as path from 'path';
import { FinaleClient } from '../lib/finale/client';
import { RequestMatcher } from '../lib/purchasing/request-matcher';

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  // Load purchase-requests.json
  const requestsPath = path.resolve(__dirname, '../purchase-requests.json');
  if (!fs.existsSync(requestsPath)) {
    console.error('purchase-requests.json not found');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(requestsPath, 'utf-8'));
  const requests = (raw.requests || []).filter((r: any) => r.status === 'Pending');

  if (requests.length === 0) {
    console.log('No pending requests to assess.');
    process.exit(0);
  }

  console.log(`\n  Assessing ${requests.length} pending purchase requests...\n`);

  const finale = new FinaleClient();
  await finale.testConnection();

  const matcher = new RequestMatcher(finale);
  await matcher.buildCatalog();

  const results: Array<{ request: any; assessment: any; matchedSku: string | null }> = [];

  for (const req of requests) {
    const result = await matcher.getAssessedRequest(req);
    results.push(result);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }

  // Pretty print
  console.log('\n' + '═'.repeat(80));
  console.log(`  PURCHASE REQUEST ASSESSMENT — ${results.length} pending requests`);
  console.log('═'.repeat(80));

  let highCount = 0;
  for (const { request, assessment, matchedSku } of results) {
    const status = assessment
      ? `[${assessment.necessity}] ${matchedSku} — ${assessment.description || ''}`
      : `[NO MATCH] ${request.details}`;
    const icon = assessment?.necessity === 'HIGH_NEED' ? '🔴' : assessment?.necessity === 'MEDIUM' ? '🟡' : '⚪';
    console.log(`  ${icon} ${status}`);
    if (assessment?.necessity === 'HIGH_NEED') highCount++;
  }

  console.log('\n' + '═'.repeat(80));
  if (highCount > 0) {
    console.log(`\n  ACTION: ${highCount} request(s) marked HIGH_NEED — consider expediting\n`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

**Step 3:** Add npm scripts for easy execution

In `package.json`, add:
```json
{
  "scripts": {
    "assess:purchases": "node --import tsx src/cli/assess-purchases.ts",
    "assess:requests": "node --import tsx src/cli/assess-requests.ts"
  }
}
```

**Step 4:** Test with real data

```bash
npm run assess:purchases
npm run assess:requests
```

**Step 5:** Commit

```bash
git add src/cli/assess-requests.ts src/lib/purchasing/request-matcher.ts
git commit -m "feat: add purchase request assessment with fuzzy matching"
```

---

## Task 3: Create snapshots table for storing assessment history

**Files:** (migration-only, no code changes initially)
- Create: `supabase/migrations/20260407_create_purchase_snapshots.sql`

**Step 1:** Design schema

```sql
CREATE TABLE IF NOT EXISTS purchase_assessment_snapshots (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  scraped_at TIMESTAMPTZ NOT NULL,
  snapshot_type TEXT NOT NULL CHECK (snapshot_type IN ('purchases', 'requests')),
  data JSONB NOT NULL,
  high_need_count INTEGER NOT NULL,
  medium_count INTEGER NOT NULL,
  low_count INTEGER NOT NULL,
  noise_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchase_snapshots_created_at ON purchase_assessment_snapshots(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_snapshots_type ON purchase_assessment_snapshots(snapshot_type);

-- Row Level Security (if enabled): allow service role full access
ALTER TABLE purchase_assessment_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON purchase_assessment_snapshots
  USING (auth.role() = 'service_role');
```

**Step 2:** Apply migration

```bash
node _run_migration.js supabase/migrations/20260407_create_purchase_snapshots.sql
```

**Step 3:** Create storage helper

Create `src/lib/purchasing/snapshot-store.ts`:

```typescript
import { createClient } from '../supabase';

export interface SnapshotMetadata {
  id?: number;
  created_at?: string;
  scraped_at: string;
  snapshot_type: 'purchases' | 'requests';
  high_need_count: number;
  medium_count: number;
  low_count: number;
  noise_count: number;
  total_count: number;
}

export async function saveSnapshot(
  type: 'purchases' | 'requests',
  data: any[],
  counts: { high_need: number; medium: number; low: number; noise: number }
): Promise<SnapshotMetadata | null> {
  const supabase = createClient();
  if (!supabase) return null;

  const { data: result, error } = await supabase
    .from('purchase_assessment_snapshots')
    .insert({
      scraped_at: new Date().toISOString(),
      snapshot_type: type,
      data,
      high_need_count: counts.high_need,
      medium_count: counts.medium,
      low_count: counts.low,
      noise_count: counts.noise,
      total_count: data.length,
    })
    .select('*')
    .single();

  if (error) {
    console.error('[snapshot] save error:', error.message);
    return null;
  }

  return result as SnapshotMetadata;
}

export async function getLatestSnapshot(
  type: 'purchases' | 'requests',
  limit?: number
): Promise<SnapshotMetadata[]> {
  const supabase = createClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('purchase_assessment_snapshots')
    .select('*')
    .eq('snapshot_type', type)
    .order('created_at', { ascending: false })
    .limit(limit || 1);

  if (error) return [];
  return (data || []) as SnapshotMetadata[];
}

export function diffSnapshots(
  current: any[],
  previous: any[],
  keyFn: (item: any) => string
): { newItems: any[]; unchanged: any[]; updated: any[] } {
  const prevMap = new Map<string, typeof previous[0]>();
  for (const item of previous) {
    prevMap.set(keyFn(item), item);
  }

  const newItems: any[] = [];
  const unchanged: any[] = [];
  const updated: any[] = [];

  for (const curr of current) {
    const key = keyFn(curr);
    const prev = prevMap.get(key);
    if (!prev) {
      newItems.push(curr);
    } else {
      // Simple diff: if any field differs, consider it updated
      if (JSON.stringify(curr) !== JSON.stringify(prev)) {
        updated.push(curr);
      } else {
        unchanged.push(curr);
      }
      prevMap.delete(key); // Mark as seen
    }
  }

  // Anything left in prevMap was removed/deleted (unlikely for our use case)
  return { newItems, unchanged, updated };
}
```

**Step 4:** Commit

```bash
git add supabase/migrations/20260407_create_purchase_snapshots.sql src/lib/purchasing/snapshot-store.ts
git commit -m "feat: add snapshot storage for diffing assessment results"
```

---

## Task 4: Add daily cron job in OpsManager

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`
- Create: `src/lib/purchasing/pipeline.ts` (orchestration)
- Modify: `start-bot.ts` to pass dependencies

**Step 1:** Create pipeline orchestration module

Create `src/lib/purchasing/pipeline.ts`:

```typescript
import { FinaleClient } from '../finale/client';
import { assessScrapedItems } from '../purchasing/assessor';
import { RequestMatcher } from '../purchasing/request-matcher';
import { saveSnapshot, diffSnapshots } from '../purchasing/snapshot-store';
import { Telegraf } from 'telegraf';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface PipelineResult {
  purchases: {
    assessments: any[];
    newHighNeed: any[];
    newMedium: any[];
    total: number;
  };
  requests: {
    assessments: any[];
    newHighNeed: any[];
    newPending: any[];
    total: number;
  };
}

export async function runPurchasingPipeline(bot: Telegraf): Promise<PipelineResult | null> {
  console.log('[purchases-pipeline] Starting scrape → assess → diff cycle');

  // Step 1: Run scraper
  try {
    await execAsync('node --import tsx src/cli/scrape-purchases.ts', { timeout: 5 * 60 * 1000 });
    console.log('[purchases-pipeline] Scrape completed');
  } catch (err: any) {
    await bot.telegram.sendMessage(
      process.env.TELEGRAM_CHAT_ID || '',
      `❌ Purchasing pipeline failed at scrape step:\n\`\`\`${err.message}\`\`\``,
      { parse_mode: 'Markdown' }
    );
    return null;
  }

  // Step 2: Assess purchases
  const { assessScrapedItems } = await import('../purchasing/assessor');
  const purchasesData = JSON.parse(
    require('fs').readFileSync(require('path').resolve(__dirname, '../../purchases-data.json'), 'utf-8')
  );

  const finale = new FinaleClient();
  await finale.testConnection();

  const purchaseAssessments = await assessScrapedItems(purchasesData, finale, 90);
  const highNeedPurchases = purchaseAssessments.flatMap(v => v.items.filter(i => i.necessity === 'HIGH_NEED'));
  const mediumPurchases = purchaseAssessments.flatMap(v => v.items.filter(i => i.necessity === 'MEDIUM'));

  // Step 3: Assess pending requests
  const requestsRaw = JSON.parse(
    require('fs').readFileSync(require('path').resolve(__dirname, '../../purchase-requests.json'), 'utf-8')
  );
  const pendingRequests = (requestsRaw.requests || []).filter((r: any) => r.status === 'Pending');

  const matcher = new RequestMatcher(finale);
  await matcher.buildCatalog();

  const requestAssessments: Array<{ request: any; assessment: any; matchedSku: string | null }> = [];
  for (const req of pendingRequests) {
    const result = await matcher.getAssessedRequest(req);
    requestAssessments.push(result);
  }

  const highNeedRequests = requestAssessments.filter(r => r.assessment?.necessity === 'HIGH_NEED');
  const newPending = requestAssessments; // All pending are "new" for notification

  // Step 4: Save snapshots
  await saveSnapshot('purchases', purchaseAssessments.flatMap(v => v.items), {
    high_need: highNeedPurchases.length,
    medium: mediumPurchases.length,
    low: purchaseAssessments.flatMap(v => v.items.filter(i => i.necessity === 'LOW')).length,
    noise: purchaseAssessments.flatMap(v => v.items.filter(i => i.necessity === 'NOISE')).length,
  });

  await saveSnapshot('requests', requestAssessments, {
    high_need: highNeedRequests.length,
    medium: requestAssessments.filter(r => r.assessment?.necessity === 'MEDIUM').length,
    low: requestAssessments.filter(r => r.assessment?.necessity === 'LOW').length,
    noise: requestAssessments.filter(r => r.assessment?.necessity === 'NOISE' || !r.assessment).length,
  });

  // Step 5: Diff against previous snapshots and generate alerts
  const prevPurchases = await getLatestSnapshot('purchases', 2);
  const prevRequests = await getLatestSnapshot('requests', 2);

  // Find new HIGH_NEED items (compare by sku + vendor + necessity)
  const previousPurchaseSkus = new Set(
    (prevPurchases[1]?.data || []).map((d: any) => `${d.sku}|${d.necessity}`)
  );
  const trulyNewHighNeed = highNeedPurchases.filter(
    p => !previousPurchaseSkus.has(`${p.sku}|HIGH_NEED`)
  );

  // New pending requests (by details string hash)
  const previousRequestDetails = new Set(
    (prevRequests[1]?.data || []).map((r: any) => r.request.details)
  );
  const trulyNewRequests = newPending.filter(
    r => !previousRequestDetails.has(r.request.details)
  );

  // Step 6: Send Telegram digest
  await sendPipelineDigest(bot, {
    purchases: { total: purchaseAssessments.reduce((a, v) => a + v.items.length, 0), newHighNeed: trulyNewHighNeed },
    requests: { total: newPending.length, newPending: trulyNewRequests },
  });

  return { purchases: { assessments: purchaseAssessments, newHighNeed: trulyNewHighNeed, newMedium: mediumPurchases, total: purchaseAssessments.reduce((a, v) => a + v.items.length, 0) }, requests: { assessments: requestAssessments, newHighNeed: highNeedRequests, newPending: trulyNewRequests, total: newPending.length } };
}

async function sendPipelineDigest(
  bot: Telegraf,
  result: PipelineResult
) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;

  let message = `🏠 *Purchasing Pipeline Report*\n\n`;

  if (result.purchases.newHighNeed.length > 0) {
    message += `🔴 *NEW HIGH NEED ITEMS* (${result.purchases.newHighNeed.length})\n`;
    for (const item of result.purchases.newHighNeed.slice(0, 10)) {
      message += `  • ${item.sku} — ${item.description}\n    ${item.explanation}\n\n`;
    }
  }

  if (result.requests.newPending.length > 0) {
    message += `📋 *NEW PURCHASE REQUESTS* (${result.requests.newPending.length})\n`;
    for (const { request, assessment } of result.requests.newPending.slice(0, 10)) {
      const status = assessment ? `[${assessment.necessity}]` : '[NO MATCH]';
      message += `  ${status} ${request.details} (${request.department})\n`;
    }
  }

  if (result.purchases.newHighNeed.length === 0 && result.requests.newPending.length === 0) {
    message += `✅ No new critical items or requests.`;
  }

  await bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}
```

**Step 2:** Register cron job in OpsManager

Modify `src/lib/intelligence/ops-manager.ts`:

In the constructor, after line ~139, add:

```typescript
import { runPurchasingPipeline } from '../purchasing/pipeline';
```

In `start()` method, after the StaleDraftPOAlert cron (line ~466), add:

```typescript
// Purchasing Intelligence Pipeline — scrape → assess → diff → notify
// Runs at 9:00 AM Monday-Friday
cron.schedule("0 9 * * 1-5", () => {
  this.safeRun("PurchasingPipeline", async () => {
    const { runPurchasingPipeline } = await import('../../lib/purchasing/pipeline');
    await runPurchasingPipeline(this.bot);
  });
}, { timezone: "America/Denver" });
```

**Step 3:** Ensure dependencies are passed

The pipeline needs access to `this.bot` (Telegraf instance). We'll call it directly.

**Step 4:** Commit

```bash
git add src/lib/purchasing/pipeline.ts
git commit -m "feat: add purchasing pipeline orchestration and cron job"
```

---

## Task 5: Add Telegram bot tool for on-demand execution

**Files:**
- Create: `src/cli/commands/purchasing.ts` (new command module)
- Modify: `src/cli/commands/index.ts` (import and register)

**Step 1:** Create the command module

Create `src/cli/commands/purchasing.ts`:

```typescript
import type { BotCommand, BotDeps } from './types';

export const purchasingCommands: BotCommand[] = [
  {
    name: 'purchases',
    description: 'Run purchasing intelligence assessment ON-DEMAND (scrape + analyze)',
    handler: async (ctx, deps) => {
      ctx.sendChatAction('typing');
      await ctx.reply('🔍 Starting on-demand purchasing assessment...\n_Scraping dashboard → Finale analysis_', { parse_mode: 'Markdown' });

      try {
        // Step 1: Scrape
        const { execAsync } = await import('child_process');
        const { promisify } = await import('util');
        const exec = promisify(execAsync);

        await ctx.reply('📥 Scraping basauto dashboard...');
        await exec('node --import tsx src/cli/scrape-purchases.ts', { timeout: 5 * 60 * 1000 });

        // Step 2: Assess purchases
        await ctx.reply('📊 Assessing purchase suggestions against Finale inventory...');
        const { default: assessModule } = await import('../lib/purchasing/assessor');
        const purchasesData = JSON.parse(
          require('fs').readFileSync(require('path').resolve(__dirname, '../../purchases-data.json'), 'utf-8')
        );

        const finale = deps.finale;
        const assessments = await assessModule.assessScrapedItems(purchasesData, finale, 90);

        const allItems = assessments.flatMap(v => v.items);
        const highCount = allItems.filter(i => i.necessity === 'HIGH_NEED').length;
        const medCount = allItems.filter(i => i.necessity === 'MEDIUM').length;
        const lowCount = allItems.filter(i => i.necessity === 'LOW').length;
        const noiseCount = allItems.filter(i => i.necessity === 'NOISE').length;

        // Step 3: Assess pending requests
        await ctx.reply('📋 Assessing pending purchase requests...');
        const { RequestMatcher } = await import('../../lib/purchasing/request-matcher');
        const requestsRaw = JSON.parse(
          require('fs').readFileSync(require('path').resolve(__dirname, '../../purchase-requests.json'), 'utf-8')
        );
        const pendingRequests = (requestsRaw.requests || []).filter((r: any) => r.status === 'Pending');

        const matcher = new RequestMatcher(finale);
        await matcher.buildCatalog();

        const requestResults: Array<{ request: any; assessment: any; matchedSku: string | null }> = [];
        for (const req of pendingRequests) {
          const result = await matcher.getAssessedRequest(req);
          requestResults.push(result);
        }

        const highNeedRequests = requestResults.filter(r => r.assessment?.necessity === 'HIGH_NEED');

        // Step 4: Format response
        let response = `✅ *Assessment Complete*\n\n`;
        response += `📦 Purchase Suggestions: ${allItems.length} total\n`;
        response += `  🔴 HIGH_NEED: ${highCount}\n`;
        response += `  🟡 MEDIUM: ${medCount}\n`;
        response += `  🟠 LOW: ${lowCount}\n`;
        response += `  ⚪ NOISE: ${noiseCount}\n\n`;
        response += `📋 Pending Requests: ${pendingRequests.length} total\n`;
        response += `  🔴 HIGH_NEED: ${highNeedRequests.length}\n\n`;

        if (highCount > 0) {
          response += `*Top HIGH_NEED items:*\n`;
          for (const va of assessments) {
            const highItems = va.items.filter(i => i.necessity === 'HIGH_NEED').slice(0, 3);
            for (const item of highItems) {
              response += `  • ${item.sku} — ${item.description}\n    ${item.explanation}\n`;
            }
          }
        }

        await ctx.reply(response, { parse_mode: 'Markdown' });

        // Step 5: Save snapshot for diffing (optional)
        const { saveSnapshot } = await import('../../lib/purchasing/snapshot-store');
        await saveSnapshot('purchases', allItems, { high_need: highCount, medium: medCount, low: lowCount, noise: noiseCount });
        await saveSnapshot('requests', requestResults, {
          high_need: highNeedRequests.length,
          medium: requestResults.filter(r => r.assessment?.necessity === 'MEDIUM').length,
          low: requestResults.filter(r => r.assessment?.necessity === 'LOW').length,
          noise: requestResults.filter(r => r.assessment?.necessity === 'NOISE' || !r.assessment).length,
        });

        await ctx.reply('💾 Snapshots saved. Use /status to see cron job results.');
      } catch (err: any) {
        console.error('[purchases] on-demand failed:', err);
        await ctx.reply(`❌ Assessment failed: ${err.message}`);
      }
    },
  },
  {
    name: 'purchasestatus',
    description: 'Show latest purchasing assessment snapshot (without scraping)',
    handler: async (ctx, deps) => {
      const { getLatestSnapshot } = await import('../../lib/purchasing/snapshot-store');
      const [purchases, requests] = await Promise.all([
        getLatestSnapshot('purchases', 1),
        getLatestSnapshot('requests', 1),
      ]);

      if (purchases.length === 0 && requests.length === 0) {
        await ctx.reply('📭 No snapshots found. Run /purchases first.');
        return;
      }

      let response = `📊 *Latest Assessment Snapshots*\n\n`;

      if (purchases[0]) {
        const p = purchases[0];
        response += `🛒 *Purchases* (${p.scraped_at})\n`;
        response += `  Total: ${p.total_count} | 🔴 ${p.high_need_count} | 🟡 ${p.medium_count}\n\n`;
      }

      if (requests[0]) {
        const r = requests[0];
        response += `📋 *Requests* (${r.scraped_at})\n`;
        response += `  Total: ${r.total_count} | 🔴 ${r.high_need_count}\n`;
      }

      await ctx.reply(response, { parse_mode: 'Markdown' });
    },
  },
];
```

**Step 2:** Register commands in index.ts

Modify `src/cli/commands/index.ts`:

```typescript
import { purchasingCommands } from './purchasing';

export const allCommands: BotCommand[] = [
  ...statusCommands,
  ...inventoryCommands,
  ...operationsCommands,
  ...memoryCommands,
  ...kaizenCommands,
  ...purchasingCommands, // ← add this
];
```

**Step 3:** Test bot commands

```bash
npm run dev
# In Telegram: /purchases
# Wait for full cycle
# Then: /purchasestatus
```

**Step 4:** Commit

```bash
git add src/cli/commands/purchasing.ts
git commit -m "feat: add /purchases and /purchasestatus Telegram commands"
```

---

## Task 6: Add cookie expiry detection and Telegram reminder

**Files:**
- Modify: `src/cli/scrape-purchases.ts`

**Step 1:** Define expiry check

Add constants at top:

```typescript
// Cookie expiry warning threshold (days)
const COOKIE_EXPIRY_WARNING_DAYS = 7;
// basauto-session.json cookie extraction date is stored as metadata
let SESSION_EXTRACTED_AT: Date | null = null;
```

**Step 2:** After injecting cookies, check expiry

In `openContext()` after line 80 (after `await context.addCookies(cookies);`), add:

```typescript
// Check cookie age if we have session metadata
if (raw.metadata?.extractedAt) {
  SESSION_EXTRACTED_AT = new Date(raw.metadata.extractedAt);
  const ageDays = (Date.now() - SESSION_EXTRACTED_AT.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > 30 - COOKIE_EXPIRY_WARNING_DAYS) {
    console.warn(`⚠️  Session cookie is ${Math.round(ageDays)} days old — expires around 2026-05-07`);
    console.warn(`   Refresh soon: extract fresh cookies from Chrome DevTools and replace .basauto-session.json`);
  }
}
```

**Step 3:** Detect redirect to /auth/signin

In `ensureSignedIn()` function, modify the early return check (around line 89):

```typescript
if (!page.url().includes('/auth/signin') && page.url().includes('/purchases')) {
  return true; // already signed in
}

// NEW: If we're on /auth/signin, alert immediately (session likely expired)
if (page.url().includes('/auth/signin')) {
  console.error('\n✗ Redirected to /auth/signin — session has expired or invalid.');
  console.error('  Refresh .basauto-session.json by extracting fresh cookies from Chrome DevTools.\n');

  // Send Telegram reminder
  try {
    const { Telegraf } = await import('telegraf');
    const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
    await bot.telegram.sendMessage(
      process.env.TELEGRAM_CHAT_ID!,
      `🔐 *Session Expired* — basauto scraper detected redirect to /auth/signin.\n\n` +
      `Please refresh your \`.basauto-session.json\` by:\n` +
      `1. Open Chrome DevTools → Application → Cookies → https://basauto.vercel.app\n` +
      `2. Copy the \`Next-Auth\` session-token (and any related cookies)\n` +
      `3. Overwrite \`.basauto-session.json\` with the new export\n\n` +
      `Cookie originally set: ${SESSION_EXTRACTED_AT ? SESSION_EXTRACTED_AT.toISOString() : 'unknown'}`,
      { parse_mode: 'Markdown' }
    );
    await bot.stop();
  } catch (telemErr) {
    console.warn('Failed to send Telegram reminder:', telemErr);
  }

  return false;
}
```

**Step 4:** Document the refresh process

Add comment at top of file (near line 21):

```typescript
// Cookie expires ~30 days after extraction. Expected expiry: 2026-05-07.
// If scraper hits /auth/signin, extract fresh cookies from Chrome DevTools:
//   - Open basauto.vercel.app in Chrome (signed in)
//   - DevTools → Application → Storage → Cookies → https://basauto.vercel.app
//   - Copy all cookies (or export as JSON) to .basauto-session.json
```

**Step 5:** Commit

```bash
git add src/cli/scrape-purchases.ts
git commit -m "feat: add session expiry detection and Telegram reminders"
```

---

## Task 7: End-to-end testing and validation

**Step 1:** Run the full pipeline manually

```bash
# Clean old data
rm purchases-data.json purchase-requests.json

# Run scraper (should complete without sign-in)
node --import tsx src/cli/scrape-purchases.ts

# Verify outputs exist
ls -lh purchases-data.json purchase-requests.json

# Run assessments
npm run assess:purchases
npm run assess:requests

# Check snapshots in Supabase
# Use Supabase Studio: query `SELECT * FROM purchase_assessment_snapshots ORDER BY created_at DESC LIMIT 2;`
```

**Step 2:** Run the on-demand bot command (if bot is running)

```bash
# In separate terminal, start bot
node --import tsx src/cli/start-bot.ts

# Telegram: /purchases
# Wait for completion
# Telegram: /purchasestatus
```

**Step 3:** Verify cron registration

Add a diagnostic command or check logs:

```bash
# In bot logs, look for:
# [cron] PurchasingPipeline scheduled at 0 9 * * 1-5 (America/Denver)
```

Or add a `/crons` command if available.

**Step 4:** Test cookie expiry reminder

Simulate by deleting `.basauto-session.json` or manually editing cookies to include malformed/expired dates, then run scraper and verify Telegram message arrives.

**Step 5:** Type check and lint

```bash
npm run typecheck:cli
npm run lint
```

Fix any errors.

**Step 6:** Commit final changes

```bash
git add .
git commit -m "feat: complete purchasing intelligence pipeline with cron, bot tools, and cookie monitoring"
```

---

## Task 8: Documentation and final cleanup

**Files:**
- Update: `CLAUDE.md` (add new commands, explain snapshots)
- Create: `docs/purchasing-pipeline.md` (architecture, troubleshooting)

**Step 1:** Update CLAUDE.md

Add to Commands section:
```markdown
# Purchasing Intelligence
npm run assess:purchases      # Assess scraped items against Finale (purchases-data.json)
npm run assess:requests       # Assess pending purchase requests (purchase-requests.json)
```

Add to OpsManager cron section:
```markdown
- 9:00 AM Mon-Fri — Purchasing Pipeline (scrape → assess → diff → Telegram)
```

Add to Bot Tools:
```markdown
/purchases       # Run on-demand assessment (scrape + analyze)
/purchasestatus  # Show latest snapshot without scraping
```

**Step 2:** Create troubleshooting guide

Create `docs/purchasing-pipeline.md` with:
- Overview diagram
- Data flow explanation
- Debugging steps
- Cookie refresh procedure
- Snapshot schema reference

**Step 3:** Final commit

```bash
git add CLAUDE.md docs/purchasing-pipeline.md
git commit -m "docs: add purchasing pipeline documentation and commands reference"
```

---

## Completion Criteria

✅ All TypeScript compiles with `npm run typecheck:cli`  
✅ ESLint passes with `npm run lint`  
✅ `/purchases` command runs successfully and sends Telegram digest  
✅ `/purchasestatus` shows snapshots from Supabase  
✅ Cron job visible in OpsManager logs at startup  
✅ Cookie expiry reminder sends test Telegram message  
✅ assess-purchases.ts and assess-requests.ts both work on sample data  
✅ Snapshots table in Supabase has data after first run  
✅ Only new HIGH_NEED items and new pending requests trigger alerts (diff works)  

---

## Rollback Plan

If issues arise:
1. Disable cron by commenting out the `cron.schedule(...)` line in OpsManager
2. Remove bot commands by commenting out `...purchasingCommands` in index.ts
3. Keep scraper standalone — no side effects if cron fails
4. Snapshots table is harmless (read-only for diffs)

---

## Notes for Implementer

- **Reuse existing code heavily**: assess-purchases.ts already has 90% of the logic you need.
- **Fuzzy matching**: The SlackWatchdog's product catalog + Fuse.js pattern is proven — copy it exactly.
- **Snapshot diff**: Use SKU as key for purchases, use `request.details` string for requests.
- **Cookie expiry**: The user said "expires 2026-05-07 (about 30 days out)" — set expiry check to warn at 23 days.
- **Timezone**: All crons use `America/Denver` (see existing pattern in ops-manager.ts:258).
- **Concurrency**: scraper takes ~2-3 min, assessment ~1-2 min per 50 items. Pipeline runs serially but within safe limits.
- **Error handling**: Use `safeRun()` pattern from ops-manager.ts for cron reliability (already integrated).
