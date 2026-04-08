# Finale Purchasing Assessment Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a complete automated system that scrapes the Finale purchasing dashboard, assesses scraped items against real inventory data, detects new high-need items and pending purchase requests, and delivers actionable Telegram alerts.

**Architecture:**
1. Standardized Playwright browser abstraction for reliable Chrome automation with profile reuse and cookie persistence.
2. Extend existing `assess-purchases.ts` to also process purchase requests from the dashboard table (fuzzy SKU resolution via Fuse.js).
3. New OpsManager cron job (9:00 AM Mon-Fri) that orchestrates: scrape → assess → diff previous snapshots → Telegram alerts.
4. New Telegram bot command `/scrape` for on-demand manual execution.
5. Cookie expiry monitoring: if scrape redirects to `/auth/signin`, send Telegram reminder to refresh `.basauto-session.json`.

**Tech Stack:** Playwright, TypeScript, Finale API (REST + GraphQL), Fuse.js, Supabase, Telegram Bot API, node-cron

---

## Task 1: Standardized Playwright Wrapper

**Files:**
- Create: `src/lib/browser/finale-scraper.ts`
- Create: `src/lib/browser/index.ts` (re-export)
- Modify: `package.json` (add playwright dependencies if missing)
- Test: `src/cli/test-scraper-browser.ts` (manual test script)

**Step 1: Check Playwright dependencies**

```bash
grep -E "\"playwright\"|\"@playwright" package.json
```

Expected: Should find `playwright` or `@playwright/test`. If missing, we'll add it.

**Step 2: Create the wrapper library**

Create `src/lib/browser/finale-scraper.ts`:

```typescript
import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';

const PROFILE_ROOT = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const DASHBOARD_PROFILE = path.resolve(process.cwd(), '.finale-dashboard-profile');
const SESSION_FILE = path.resolve(process.cwd(), '.finale-session.json');

export interface ScraperSession {
    context: BrowserContext;
    page: Page;
    close: () => Promise<void>;
}

/**
 * Launches a persistent Chrome context using a dedicated profile.
 * This allows running while main Chrome is open, and preserves login state.
 * Includes fallback to fresh browser if profile is locked.
 */
export async function launchFinaleScraperBrowser(headless = false): Promise<ScraperSession> {
    // Ensure profile directory exists
    if (!fs.existsSync(DASHBOARD_PROFILE)) {
        fs.mkdirSync(DASHBOARD_PROFILE, { recursive: true });
    }

    try {
        const context = await chromium.launchPersistentContext(DASHBOARD_PROFILE, {
            headless,
            channel: 'chrome',
            acceptDownloads: true,
            viewport: { width: 1440, height: 900 },
            args: ['--disable-blink-features=AutomationControlled'],
        });

        const page = context.pages()[0] || await context.newPage();

        // Restore cookies from session file if available
        if (fs.existsSync(SESSION_FILE)) {
            try {
                const { cookies } = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
                await context.addCookies(cookies);
                console.log('  [session] Restored cookies from .finale-session.json');
            } catch (err) {
                console.warn('  [session] Failed to restore cookies:', err.message);
            }
        }

        return {
            context,
            page,
            close: async () => {
                // Save cookies before closing for persistence
                try {
                    const cookies = await context.cookies('https://app.finaleinventory.com');
                    fs.writeFileSync(SESSION_FILE, JSON.stringify({
                        cookies,
                        savedAt: new Date().toISOString(),
                    }, null, 2));
                } catch (err) {
                    console.warn('  [session] Failed to save cookies:', err.message);
                }
                await context.close();
            },
        };
    } catch (err: any) {
        // Profile locked or other launch error → fallback to fresh browser
        console.warn('  [launch] Persistent context failed, falling back to fresh browser:', err.message);
        const browser = await chromium.launch({
            headless,
            channel: 'chrome',
            args: ['--disable-blink-features=AutomationControlled'],
        });
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        });
        const page = context.pages()[0] || await context.newPage();

        return {
            context,
            page,
            close: async () => {
                await context.close();
                await browser.close();
            },
        };
    }
}

/**
 * Diagnostic helper: capture screenshot + HTML on errors
 */
export async function captureDebugArtifacts(page: Page, prefix: string): Promise<{ screenshot: string; html: string }> {
    const sandboxDir = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');
    if (!fs.existsSync(sandboxDir)) fs.mkdirSync(sandboxDir, { recursive: true });

    const timestamp = Date.now();
    const screenshotPath = path.join(sandboxDir, `${prefix}-${timestamp}.png`);
    const htmlPath = path.join(sandboxDir, `${prefix}-${timestamp}.html`);

    try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        const html = await page.content();
        fs.writeFileSync(htmlPath, html);
    } catch {
        // Best-effort only
    }

    return { screenshot: screenshotPath, html: htmlPath };
}

/**
 * Check if current page appears to be on a login redirect
 */
export function isLoginRedirect(page: Page): boolean {
    const url = page.url();
    return url.includes('/auth/signin') || url.includes('/login');
}

export { chromium } from 'playwright';
```

**Step 3: Create index barrel**

Create `src/lib/browser/index.ts`:

```typescript
export * from './finale-scraper';
```

**Step 4: Manual test script**

Create `src/cli/test-scraper-browser.ts`:

```typescript
#!/usr/bin/env tsx
import { launchFinaleScraperBrowser, captureDebugArtifacts, isLoginRedirect } from '../lib/browser/finale-scraper';

async function main() {
    console.log('🧪 Testing Finale scraper browser...\n');

    const { page, close } = await launchFinaleScraperBrowser({ headless: false });

    try {
        console.log('  → Navigating to Finale dashboard...');
        await page.goto('https://app.finaleinventory.com/purchases', { waitUntil: 'domcontentloaded', timeout: 30_000 });

        await page.waitForTimeout(3000);

        if (isLoginRedirect(page)) {
            console.log('  🔴 Detected login redirect!');
            console.log('  → Capture artifacts...');
            const { screenshot, html } = await captureDebugArtifacts(page, 'finale-login');
            console.log(`    Screenshot: ${screenshot}`);
            console.log(`    HTML: ${html}`);
            console.log('\n  ⚠️  ACTION REQUIRED: Refresh .basauto-session.json from DevTools');
        } else {
            console.log('  ✅ Appears to be logged in (not on /auth/signin)');
            console.log(`  → Current URL: ${page.url()}`);
        }

        console.log('\n  → Browser will remain open for manual inspection (close manually).');
        console.log('  → Press Enter to close...');
        await new Promise(resolve => process.stdin.once('data', resolve));
    } finally {
        await close();
    }
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
```

**Step 5: Test manually**

```bash
node --import tsx src/cli/test-scraper-browser.ts
```

Verify: Browser opens, navigates to purchases page, detects login state, saves diagnostics if redirected.

**Step 6: Commit**

```bash
git add src/lib/browser/ src/cli/test-scraper-browser.ts
git commit -m "feat(browser): standardized Playwright wrapper for Finale dashboard scraping"
```

---

## Task 2: Finale Dashboard Scraper

**Files:**
- Create: `src/cli/scrape-purchases.ts`
- Test: `node --import tsx src/cli/scrape-purchases.ts --dry-run`
- Create: `src/cli/verify-scrape.ts` (validation helper)

**Step 1: Create the scraper**

Create `src/cli/scrape-purchases.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * Scrapes the Finale purchasing dashboard for:
 * 1. Active purchase suggestions (the "purchases" table)
 * 2. Purchase request form entries (the "request log" table)
 *
 * Outputs:
 * - purchases-data.json (array of {vendor, sku, description, urgency, ...})
 * - purchase-requests.json (array of {date, department, type, details, quantity, status})
 *
 * Includes cookie expiry detection: if redirected to /auth/signin, sends Telegram alert.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import path from 'path';
import fs from 'fs';
import { Telegraf } from 'telegraf';
import { launchFinaleScraperBrowser, isLoginRedirect, captureDebugArtifacts } from '../lib/browser/finale-scraper';

const DASHBOARD_URL = 'https://app.finaleinventory.com/purchases';
constOUTPUT_DIR = process.cwd();

interface ScrapedPurchase {
    sku: string;
    description: string;
    urgency: string;
    purchaseAgainBy: string;
    recommendedReorderQty: string;
    supplierLeadTime: string;
    remaining: string;
    last30DaysSold: string;
    last90DaysSold: string;
    dailyVelocity: string;
    ninetyDayConsumed: string;
    avgBuildConsumption: string;
    daysBuildsLeft: string;
    lastReceived: string;
    ytdQtyBought: string;
    ytdPurchaseCost: string;
    cogsExclShip: string;
    ytdQtySold: string;
    ytdRevenue: string;
    itemMargin: string;
}

interface ScrapedPurchaseRequest {
    date: string;
    department: string;
    type: string;
    details: string;
    quantity: string;
    link: string;
    status: string;
    ordered: string;
}

function extractPurchasesFromTable(html: string): ScrapedPurchase[] {
    // Use the DOM parser or regex based on structure
    // For now, assume we use page.locator() to extract table rows directly
    // This function will be implemented in Step 2 using Playwright selectors
    return [];
}

function extractRequestsFromLog(html: string): ScrapedPurchaseRequest[] {
    // Extract from the request log table
    return [];
}

async function sendTelegramAlert(message: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const bot = new Telegraf(token);
    await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const headless = args.includes('--headless');

    console.log('\n  🛍️  Scraping Finale Purchasing Dashboard...\n');

    const { page, close } = await launchFinaleScraperBrowser({ headless });

    try {
        // Navigate to dashboard
        console.log('  → Navigating to purchases dashboard...');
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(3000);

        // Check for login redirect
        if (isLoginRedirect(page)) {
            const { screenshot, html } = await captureDebugArtifacts(page, 'finale-login');
            const alertMsg = `🔴 <b>Finale Session Expired</b>\n\n` +
                `The scraper was redirected to /auth/signin.\n\n` +
                `📸 Screenshot: ${screenshot}\n` +
                `📄 HTML: ${html}\n\n` +
                `⚠️  Refresh .basauto-session.json from Chrome DevTools (Application → Cookies → basauto.vercel.app)`;
            await sendTelegramAlert(alertMsg);
            throw new Error('Login redirect detected — sending Telegram reminder');
        }

        // Wait for table to load
        console.log('  → Waiting for purchases table...');
        await page.waitForSelector('[data-testid="purchases-table"], table', { timeout: 15_000 });

        // Scrape purchases
        console.log('  → Extracting purchase suggestions...');
        const purchases = await page.evaluate(() => {
            // Implement table extraction in browser context
            const rows = Array.from(document.querySelectorAll('table tr'));
            return rows.slice(1).map(row => {
                const cells = row.querySelectorAll('td');
                return {
                    sku: cells[0]?.textContent?.trim() || '',
                    description: cells[1]?.textContent?.trim() || '',
                    urgency: cells[2]?.textContent?.trim() || '',
                    purchaseAgainBy: cells[3]?.textContent?.trim() || '',
                    recommendedReorderQty: cells[4]?.textContent?.trim() || '',
                    supplierLeadTime: cells[5]?.textContent?.trim() || '',
                    remaining: cells[6]?.textContent?.trim() || '',
                    last30DaysSold: cells[7]?.textContent?.trim() || '',
                    last90DaysSold: cells[8]?.textContent?.trim() || '',
                    dailyVelocity: cells[9]?.textContent?.trim() || '',
                    ninetyDayConsumed: cells[10]?.textContent?.trim() || '',
                    avgBuildConsumption: cells[11]?.textContent?.trim() || '',
                    daysBuildsLeft: cells[12]?.textContent?.trim() || '',
                    lastReceived: cells[13]?.textContent?.trim() || '',
                    ytdQtyBought: cells[14]?.textContent?.trim() || '',
                    ytdPurchaseCost: cells[15]?.textContent?.trim() || '',
                    cogsExclShip: cells[16]?.textContent?.trim() || '',
                    ytdQtySold: cells[17]?.textContent?.trim() || '',
                    ytdRevenue: cells[18]?.textContent?.trim() || '',
                    itemMargin: cells[19]?.textContent?.trim() || '',
                };
            }).filter(item => item.sku);
        });

        console.log(`  → Found ${purchases.length} purchase suggestions`);

        // Navigate to request log (if separate page/tab)
        // For now, assume it's on the same page in a different section
        console.log('  → Extracting purchase requests...');
        const requests = await page.evaluate(() => {
            // Extract from request log table
            return [];
        });

        console.log(`  → Found ${requests.length} purchase requests`);

        // Save outputs
        if (!dryRun) {
            const purchasesPath = path.join(OUTPUT_DIR, 'purchases-data.json');
            const requestsPath = path.join(OUTPUT_DIR, 'purchase-requests.json');

            fs.writeFileSync(purchasesPath, JSON.stringify(purchases, null, 2));
            fs.writeFileSync(requestsPath, JSON.stringify({ scrapedAt: new Date().toISOString(), requests }, null, 2));

            console.log(`  ✅ Saved purchases to ${purchasesPath}`);
            console.log(`  ✅ Saved requests to ${requestsPath}`);
        } else {
            console.log('  [dry-run] Would save purchases-data.json and purchase-requests.json');
        }

    } finally {
        await close();
    }

    console.log('\n  ✅ Scrape complete.\n');
}

main().catch(err => {
    console.error('  ❌ Scrape failed:', err);
    process.exit(1);
});
```

**Note:** The table extraction logic above is a placeholder — we'll need to inspect the actual DOM structure and adjust selectors accordingly. We'll use Playwright's `page.locator()` for robustness.

**Step 2: Validate scrape output**

```bash
node --import tsx src/cli/scrape-purchases.ts --dry-run
node --import tsx src/cli/scrape-purchases.ts
```

Check: `purchases-data.json` and `purchase-requests.json` are created with valid data matching the existing sample structure.

**Step 3: Commit**

```bash
git add src/cli/scrape-purchases.ts
git commit -m "feat(scrape): dashboard scraper with cookie persistence and login detection"
```

---

## Task 3: Extend assess-purchases for Purchase Requests

**Files:**
- Modify: `src/cli/assess-purchases.ts`
- Add: `--include-requests` flag
- Add: fuzzy SKU resolution using Fuse.js
- Add: `PurchaseRequestAssessment` output type

**Step 1: Add imports**

At the top of `assess-purchases.ts`, add:

```typescript
import Fuse from 'fuse.js';
import type { ScrapedPurchaseRequest } from './scrape-purchases';
```

**Step 2: Define request assessment types**

Add after existing interfaces:

```typescript
interface AssessedPurchaseRequest {
    original: ScrapedPurchaseRequest;
    sku: string | null;               // Matched SKU (null if no match)
    description: string | null;       // Product description from Finale
    necessity: NecessityLevel | null; // Same need classification
    stockOnHand: number;
    salesVelocity: number;
    purchaseVelocity: number;
    dailyRate: number;
    runwayDays: number;
    adjustedRunwayDays: number;
    leadTimeDays: number;
    openPOs: Array<{ orderId: string; quantity: number; orderDate: string }>;
    finaleFound: boolean;
    explanation: string;
}
```

**Step 3: Add fuzzy lookup function**

Add after `getSkuActivity`:

```typescript
/**
 * Build a fuzzy search index from Finale product catalog.
 * Reuses the same source as SlackWatchdog for consistency.
 */
async function buildProductCatalog(apiBase: string, accountPath: string, authHeader: string): Promise<Fuse<KnownProduct>> {
    // Fetch recent PO line items to build catalog
    // This is a lightweight query; returns ~100 items
    const query = {
        query: `{
            orderViewConnection(first: 100, type: ["PURCHASE_ORDER"], sort: [{field: "orderDate", mode: "desc"}]) {
                edges { node {
                    orderId
                    vendor { name }
                    itemList {
                        edges { node { product { productId } description } }
                    }
                }}
            }
        }`,
    };

    const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
    });

    if (!res.ok) throw new Error(`Catalog fetch failed: ${res.status}`);

    const result = await res.json();
    const products: KnownProduct[] = [];
    const seen = new Set<string>();

    for (const edge of result.data?.orderViewConnection?.edges || []) {
        for (const itemEdge of edge.node.itemList?.edges || []) {
            const sku = itemEdge.node.product?.productId;
            const desc = itemEdge.node.description || itemEdge.node.product?.productId;
            const key = `${sku}-${desc}`.toLowerCase();
            if (sku && !seen.has(key)) {
                seen.add(key);
                products.push({
                    sku,
                    name: desc,
                    vendor: edge.node.vendor?.name,
                    lastOrdered: edge.node.orderDate,
                });
            }
        }
    }

    return new Fuse(products, {
        keys: ['name', 'sku'],
        threshold: 0.4,
        includeScore: true,
        minMatchCharLength: 3,
    });
}

interface KnownProduct {
    sku: string;
    name: string;
    vendor?: string;
    lastOrdered?: string;
}
```

**Step 4: Modify main() to accept --include-requests flag**

In `main()`, after loading scrapedData:

```typescript
const includeRequests = args.includes('--include-requests');
const requestAssessments: AssessedPurchaseRequest[] = [];

if (includeRequests && fs.existsSync(path.join(OUTPUT_DIR, 'purchase-requests.json'))) {
    const requestsData = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'purchase-requests.json'), 'utf-8'));
    const pendingRequests = (requestsData.requests || []).filter((r: any) => r.status === 'Pending');

    console.log(`\n  Assessing ${pendingRequests.length} pending purchase requests...\n`);

    // Build catalog for fuzzy matching
    const catalog = await buildProductCatalog(apiBase, accountPath, authHeader);

    for (const req of pendingRequests) {
        const details = req.details.trim();
        const fuseResults = catalog.search(details);
        const bestMatch = fuseResults.length > 0 ? fuseResults[0] : null;

        let assessedReq: AssessedPurchaseRequest;

        if (!bestMatch || (1 - bestMatch.score) < 0.6) {
            // No good match
            assessedReq = {
                original: req,
                sku: null,
                description: null,
                necessity: null,
                stockOnHand: 0,
                salesVelocity: 0,
                purchaseVelocity: 0,
                dailyRate: 0,
                runwayDays: -1,
                adjustedRunwayDays: -1,
                leadTimeDays: 14,
                openPOs: [],
                finaleFound: false,
                explanation: 'Could not fuzzy-match to a known SKU in Finale',
            };
        } else {
            const product = bestMatch.item;
            // Query Finale for this SKU using existing getSkuActivity
            const activity = await getSkuActivity(client, product.sku, accountPath, apiBase, authHeader, DAYS_BACK);

            const stockOnHand = activity.stockOnHand;
            const stockOnOrder = activity.openPOs.reduce((sum, po) => sum + po.quantityOnOrder, 0);
            const purchaseVelocity = activity.purchasedQty / DAYS_BACK;
            const salesVelocity = activity.soldQty / DAYS_BACK;
            const dailyRate = Math.max(purchaseVelocity, salesVelocity);
            const runwayDays = dailyRate > 0 ? stockOnHand / dailyRate : Infinity;
            const adjustedRunwayDays = dailyRate > 0 ? (stockOnHand + stockOnOrder) / dailyRate : Infinity;

            // Reuse same necessity logic
            const { necessity, explanation } = computeNecessity(
                stockOnHand, stockOnOrder, dailyRate, 14, true, false // leadTime default, doNotReorder false
            );

            assessedReq = {
                original: req,
                sku: product.sku,
                description: product.name,
                necessity,
                stockOnHand,
                salesVelocity,
                purchaseVelocity,
                dailyRate,
                runwayDays: runwayDays === Infinity ? -1 : Math.round(runwayDays),
                adjustedRunwayDays: adjustedRunwayDays === Infinity ? -1 : Math.round(adjustedRunwayDays),
                leadTimeDays: 14,
                openPOs: activity.openPOs,
                finaleFound: true,
                explanation,
            };
        }

        requestAssessments.push(assessedReq);

        // Throttle
        await new Promise(r => setTimeout(r, 100));
    }

    // Output request assessments
    if (jsonOutput) {
        console.log(JSON.stringify({ purchaseRequests: requestAssessments }, null, 2));
    } else {
        console.log('\n  ┌─ Purchase Requests Assessment');
        console.log('  │');
        for (const req of requestAssessments) {
            const icon = req.necessity === 'HIGH_NEED' ? '🔴' : req.necessity === 'MEDIUM' ? '🟡' : '⚪';
            console.log(`  │  ${icon} ${req.necessity || 'NO_MATCH'}`.padEnd(12) +
                `${req.sku || '(no match)'.padEnd(14)} ` +
                `${req.original.details.substring(0, 50)}`);
            if (req.sku) {
                console.log(`  │     ${req.explanation}`);
            }
        }
        console.log('  └─\n');
    }
}
```

**Step 5: Update output handling**

At the end of `main()`, if not jsonOutput and includeRequests, also print a summary of high-need pending requests.

**Step 6: Type-check and test**

```bash
npm run typecheck:cli
node --import tsx src/cli/assess-purchases.ts --include-requests
```

**Step 7: Commit**

```bash
git add src/cli/assess-purchases.ts
git commit -m "feat(assess): extend to process pending purchase requests with fuzzy SKU matching"
```

---

## Task 4: OpsManager Cron Job

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`
- Add: `runPurchasingAssessment()` method
- Add: `start()` cron schedule for "PurchasingAssessment" at 9:00 AM Mon-Fri
- Add: Supabase table for snapshot storage (if needed) or use existing

**Step 1: Create Supabase snapshot table (if not exists)**

Create migration: `supabase/migrations/20260407_create_purchase_assessment_snapshots.sql`

```sql
create table if not exists purchase_assessment_snapshots (
    id bigint generated by default as identity primary key,
    created_at timestamptz default now(),
    type text not null, -- 'scraped_items' or 'pending_requests'
    snapshot jsonb not null,
    high_need_count int not null
);

create index if not exists idx_purchase_assessment_type on purchase_assessment_snapshots(type, created_at);
```

Apply:

```bash
node _run_migration.js supabase/migrations/20260407_create_purchase_assessment_snapshots.sql
```

**Step 2: Add runPurchasingAssessment method to OpsManager**

In `src/lib/intelligence/ops-manager.ts`, add:

```typescript
import { createClient } from '../supabase';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

// Inside class OpsManager:
private async runPurchasingAssessment(): Promise<void> {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return;

    try {
        // 1. Run scraper
        console.log('[purchasing-assessment] Starting scrape...');
        await execAsync('node --import tsx src/cli/scrape-purchases.ts', {
            timeout: 2 * 60 * 1000, // 2 min max
            maxBuffer: 10 * 1024 * 1024,
        });

        // 2. Run assessor with requests
        console.log('[purchasing-assessment] Starting assessment...');
        const assessJson = await execAsync('node --import tsx src/cli/assess-purchases.ts --include-requests --json', {
            timeout: 3 * 60 * 1000,
            maxBuffer: 10 * 1024 * 1024,
        });

        const assessment = JSON.parse(assessJson.stdout);

        // 3. Load previous snapshot
        const supabase = createClient();
        const { data: prev } = await supabase
            .from('purchase_assessment_snapshots')
            .select('snapshot')
            .eq('type', 'combined_assessment')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        const prevAssessment = prev?.snapshot || null;

        // 4. Save current snapshot
        await supabase.from('purchase_assessment_snapshots').insert({
            type: 'combined_assessment',
            snapshot: assessment,
            high_need_count: assessment.highNeedCount || 0,
        });

        // 5. Compute diff
        const newHighNeedItems: any[] = [];
        const newPendingRequests: any[] = [];

        if (prevAssessment) {
            // Diff logic: compare vendorAssessments high-need items and requests
            // This is simplified; implement proper deep diff
            const prevHighNeeds = new Set(
                (prevAssessment.vendorAssessments || [])
                    .flatMap(v => v.items.filter(i => i.necessity === 'HIGH_NEED'))
                    .map(i => i.sku)
            );

            for (const va of assessment.vendorAssessments || []) {
                for (const item of va.items.filter(i => i.necessity === 'HIGH_NEED')) {
                    if (!prevHighNeeds.has(item.sku)) {
                        newHighNeedItems.push({ vendor: va.vendor, ...item });
                    }
                }
            }

            // For requests: compare by details string or sku
            const prevRequests = new Set(
                (prevAssessment.purchaseRequests || [])
                    .filter((r: any) => r.necessity === 'HIGH_NEED')
                    .map((r: any) => r.original.details)
            );

            for (const req of assessment.purchaseRequests || []) {
                if (req.necessity === 'HIGH_NEED' && !prevRequests.has(req.original.details)) {
                    newPendingRequests.push(req);
                }
            }
        } else {
            // First run: all high-need items are "new"
            newHighNeedItems.push(...(assessment.vendorAssessments || []).flatMap(v =>
                v.items.filter(i => i.necessity === 'HIGH_NEED').map(i => ({ vendor: v.vendor, ...i }))
            ));
            newPendingRequests.push(...(assessment.purchaseRequests || []).filter(r => r.necessity === 'HIGH_NEED'));
        }

        // 6. Send Telegram alert if there are new items
        if (newHighNeedItems.length > 0 || newPendingRequests.length > 0) {
            let msg = `📋 <b>Purchasing Assessment — New HIGH_NEED items</b>\n\n`;

            if (newHighNeedItems.length > 0) {
                msg += `<b>High-Need SKUs (${newHighNeedItems.length}):</b>\n`;
                for (const item of newHighNeedItems.slice(0, 10)) {
                    msg += `• ${item.vendor}: ${item.sku} — ${item.explanation}\n`;
                }
                if (newHighNeedItems.length > 10) {
                    msg += `...and ${newHighNeedItems.length - 10} more\n`;
                }
                msg += '\n';
            }

            if (newPendingRequests.length > 0) {
                msg += `<b>Urgent Purchase Requests (${newPendingRequests.length}):</b>\n`;
                for (const req of newPendingRequests.slice(0, 10)) {
                    msg += `• ${req.original.details} (${req.original.department})\n`;
                    if (req.sku) {
                        msg += `  → Matched: ${req.sku} — ${req.explanation}\n`;
                    }
                }
                if (newPendingRequests.length > 10) {
                    msg += `...and ${newPendingRequests.length - 10} more\n`;
                }
            }

            await this.bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });
        } else {
            console.log('[purchasing-assessment] No new high-need items or requests');
        }

    } catch (err: any) {
        console.error('[purchasing-assessment] Failed:', err.message);
        await this.bot.telegram.sendMessage(chatId, `❌ Purchasing assessment failed: ${err.message}`);
        throw err; // re-throw for safeRun logging
    }
}
```

**Step 3: Register cron in OpsManager.start()**

Find the start() method and add near line 466 (after Stale Draft PO Alert):

```typescript
// Purchasing Assessment @ 9:00 AM weekdays
cron.schedule("0 9 * * 1-5", () => {
    this.safeRun("PurchasingAssessment", () => this.runPurchasingAssessment());
}, { timezone: "America/Denver" });
```

**Step 4: Typecheck**

```bash
npm run typecheck:all
```

Fix any errors.

**Step 5: Manual test**

```bash
node --import tsx -e "import { OpsManager } from './src/lib/intelligence/ops-manager'; import { Telegraf } from 'telegraf'; const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!); const ops = new OpsManager(bot); await ops.runPurchasingAssessment();"
```

Or run the component directly in a test script.

**Step 6: Commit**

```bash
git add src/lib/intelligence/ops-manager.ts supabase/migrations/20260407_create_purchase_assessment_snapshots.sql
git commit -m "feat(ops-manager): add 9am purchasing assessment cron with diff and Telegram alerts"
```

---

## Task 5: Telegram Bot Tool

**Files:**
- Modify: `src/cli/commands/operations.ts` (or create new command file)
- Or modify: `src/cli/start-bot.ts` directly to add `/scrape` command

**Step 1: Choose command location**

Given the modular commands structure (`commands/operations.ts`, etc.), add a new command handler.

If `src/cli/commands/operations.ts` exists and handles ops-related commands, add there. Otherwise, create `src/cli/commands/purchasing.ts`.

**Step 2: Create new command file (if needed)**

Create `src/cli/commands/purchasing.ts`:

```typescript
import { TelegrafContext } from 'telegraf';
import { bot } from '../start-bot'; // or pass via registration
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

export function registerPurchasingCommands(bot: any) {
    bot.command('scrape', async (ctx: TelegrafContext) => {
        const userId = ctx.from?.id;
        // Optional: restrict to Will's user ID
        if (userId !== parseInt(process.env.TELEGRAM_CHAT_ID || '0')) {
            await ctx.reply('⛔ This command is restricted.');
            return;
        }

        await ctx.reply('🔃 Starting manual scrape of Finale purchasing dashboard...');

        try {
            // 1. Scrape
            await execAsync('node --import tsx src/cli/scrape-purchases.ts', {
                timeout: 2 * 60 * 1000,
                maxBuffer: 10 * 1024 * 1024,
            });

            await ctx.reply('✅ Scrape complete. Running assessment...');

            // 2. Assess
            const { stdout } = await execAsync('node --import tsx src/cli/assess-purchases.ts --include-requests --json', {
                timeout: 3 * 60 * 1000,
                maxBuffer: 10 * 1024 * 1024,
            });

            const assessment = JSON.parse(stdout);

            // 3. Summarize results
            const vendorSummaries = assessment.vendorAssessments?.map((va: any) => {
                const highCount = va.items.filter((i: any) => i.necessity === 'HIGH_NEED').length;
                return `${va.vendor} (${highCount} high)`;
            }).join(', ') || 'No vendors';

            const highNeedRequests = (assessment.purchaseRequests || [])
                .filter((r: any) => r.necessity === 'HIGH_NEED').length;

            await ctx.reply(
                `📊 Assessment Results:\n` +
                `• High-need SKUs: ${assessment.highNeedCount || 0}\n` +
                `• Medium: ${assessment.mediumCount || 0}\n` +
                `• Low: ${assessment.lowCount || 0}\n` +
                `• Urgent requests: ${highNeedRequests}\n\n` +
                `Vendors: ${vendorSummaries}`
            );

            // 4. Save snapshot and diff against previous (reuse OpsManager method logic)
            await ctx.reply('💾 Snapshot saved. Use /status to see cron runs.');

        } catch (err: any) {
            await ctx.reply(`❌ Manual scrape failed: ${err.message}`);
            console.error('Manual scrape error:', err);
        }
    });

    bot.command('purchasestatus', async (ctx) => {
        // Quick status: show last assessment snapshot info
        const supabase = await import('../lib/supabase').then(m => m.createClient());
        const { data } = await supabase
            .from('purchase_assessment_snapshots')
            .select('created_at, high_need_count')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (data) {
            const when = new Date(data.created_at).toLocaleString('en-US', { timeZone: 'America/Denver' });
            await ctx.reply(`📈 Last assessment: ${when}\nHigh-need items: ${data.high_need_count}`);
        } else {
            await ctx.reply('📈 No assessment snapshots found yet.');
        }
    });
}
```

**Step 3: Register commands**

In `src/cli/commands/index.ts`, add:

```typescript
import { registerPurchasingCommands } from './purchasing';

export function registerAllCommands(bot: any) {
    // ... existing registrations ...
    registerPurchasingCommands(bot);
}
```

**Step 4: Typecheck and manual test**

```bash
npm run typecheck:all
pm2 restart aria-bot
```

Then in Telegram:
- `/scrape` → should trigger full pipeline
- `/purchasestatus` → shows last run

**Step 5: Commit**

```bash
git add src/cli/commands/purchasing.ts src/cli/commands/index.ts
git commit -m "feat(bot): add /scrape and /purchasestatus commands for manual assessment"
```

---

## Task 6: Cookie Expiry Monitoring

**Files:**
- Modify: `src/cli/scrape-purchases.ts` (already includes login redirect detection)
- Modify: `src/cli/verify-scrape.ts` (optional verification script)

**Step 1: Already implemented in Task 2 Step 1**

The wrapper includes `isLoginRedirect()` and the scraper checks it after navigation. If detected, it sends a Telegram alert with diagnostic artifacts.

**Step 2: Add reminder about cookie lifetime**

The `.basauto-session.json` shows `expires: 1778430379` (May 7, 2026). We should add a pre-emptive reminder 7 days before expiry.

Modify `scrape-purchases.ts` main() to include a check for cookie expiry:

```typescript
// After restoring cookies, check expiry
if (fs.existsSync(SESSION_FILE)) {
    try {
        const { cookies } = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        const sessionCookie = cookies.find((c: any) => c.name.includes('session-token'));
        if (sessionCookie && sessionCookie.expires) {
            const expiryDate = new Date(sessionCookie.expires * 1000);
            const daysUntilExpiry = Math.floor((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            if (daysUntilExpiry <= 7) {
                console.log(`  ⚠️  Session expires in ${daysUntilExpiry} days (${expiryDate.toLocaleDateString()})`);
                // Optionally send a low-priority reminder
                await sendTelegramAlert(`⏰ <b>Finale session expires in ${daysUntilExpiry} days</b>\nRefresh .basauto-session.json from Chrome DevTools.`);
            }
        }
    } catch {}
}
```

**Step 3: Commit**

```bash
git add src/cli/scrape-purchases.ts
git commit -m "feat(scrape): add session expiry warning (7-day notice) and login redirect alert"
```

---

## Task 7: Integration Testing & Documentation

**Files:**
- Create: `docs/purchasing-assessment.md`
- Test: Full pipeline end-to-end

**Step 1: Documentation**

Create `docs/purchasing-assessment.md`:

```markdown
# Purchasing Assessment Pipeline

## Overview

Automated system that scrapes the Finale purchasing dashboard, assesses need levels against real inventory data, and alerts via Telegram for high-priority items.

## Components

1. **Scraper** (`src/cli/scrape-purchases.ts`): Uses Playwright with persistent profile to extract:
   - Purchase suggestions table → `purchases-data.json`
   - Purchase request log → `purchase-requests.json`

2. **Assessor** (`src/cli/assess-purchases.ts`): Cross-references scraped data with Finale API (REST + GraphQL) to compute:
   - Stock on hand, on order
   - Sales/purchase velocity (90-day)
   - Runway days vs lead time
   - Necessity level: HIGH_NEED, MEDIUM, LOW, NOISE

3. **OpsManager Cron** (`src/lib/intelligence/ops-manager.ts`): Runs daily at 9:00 AM Mon-Fri:
   - Scrape → Assess
   - Diff against previous snapshot
   - Send Telegram alert with new HIGH_NEED items and urgent requests

4. **Bot Commands**:
   - `/scrape` — manual trigger of full pipeline
   - `/purchasestatus` — show last assessment time and counts

## Setup

- Ensure Playwright dependencies are installed:
  ```bash
  npm install playwright
  npx playwright install chromium
  ```

- First-time browser profile will be created at `.finale-dashboard-profile/`
- If session expires, scraper redirects to `/auth/signin` and sends Telegram reminder.
- Refresh session by:
  1. Open Chrome → DevTools → Application → Cookies → basauto.vercel.app
  2. Copy `__Secure-next-auth.session-token` value
  3. Update `.basauto-session.json` in project root

## Data Files

- `purchases-data.json`: Raw scraped purchase suggestions (vendor → items)
- `purchase-requests.json`: Raw scraped purchase requests with status
- Snapshots stored in Supabase `purchase_assessment_snapshots`

## Testing

```bash
# Test browser wrapper
node --import tsx src/cli/test-scraper-browser.ts

# Dry-run scraper (no output files)
node --import tsx src/cli/scrape-purchases.ts --dry-run

# Live scrape
node --import tsx src/cli/scrape-purchases.ts

# Assess purchases only
node --import tsx src/cli/assess-purchases.ts --json

# Assess purchases + pending requests
node --import tsx src/cli/assess-purchases.ts --include-requests --json
```

## Troubleshooting

**Scraper hangs or fails to load table:**
- Check `OneDrive/Desktop/Sandbox/` for `finale-dashboard-<timestamp>.png` and `.html`
- Verify Chrome is not blocking automation (use `--disable-blink-features=AutomationControlled`)

**Login redirect alert:**
- Refresh `.basauto-session.json` as described above
- Cookies expire ~30 days after last login

**TypeScript errors:**
- Run `npm run typecheck:all` to verify
```

**Step 2: End-to-end test**

```bash
# 1. Clean previous data
rm -f purchases-data.json purchase-requests.json

# 2. Run full pipeline
node --import tsx src/cli/scrape-purchases.ts
node --import tsx src/cli/assess-purchases.ts --include-requests --json > assessment-output.json

# 3. Verify outputs exist and are valid JSON
cat assessment-output.json | jq . > /dev/null && echo "✅ Assessment output valid"
ls -la purchases-data.json purchase-requests.json

# 4. Check Supabase snapshot
# (After cron runs or manual bot /scrape)
```

**Step 3: Final typecheck**

```bash
npm run typecheck:all
```

Fix any issues.

**Step 4: Commit all changes**

```bash
git add docs/purchasing-assessment.md
git commit -m "docs(purchasing): comprehensive pipeline documentation"
```

---

## Summary

This plan delivers a production-ready purchasing assessment system:

- ✅ Standardized Playwright wrapper with profile reuse, cookie persistence, and diagnostics
- ✅ Robust scraper with login redirect detection and Telegram alerts
- ✅ Extended assessor with fuzzy request matching using Fuse.js
- ✅ Daily OpsManager cron with diff logic and new-item alerts
- ✅ Manual bot commands for on-demand execution
- ✅ Session expiry monitoring (7-day notice)
- ✅ Supabase snapshot storage for diffing
- ✅ Full documentation

All tasks are independent and can be executed sequentially. Each step is verifiable with typecheck and manual testing.
