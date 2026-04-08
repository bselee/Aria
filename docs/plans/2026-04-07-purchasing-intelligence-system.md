# Purchasing Intelligence System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a complete automated purchasing intelligence system that scrapes the BasAuto dashboard, assesses genuine need against Finale data, detects new urgent items and pending requests, and delivers actionable Telegram alerts via a daily cron job plus on-demand bot tool.

**Architecture:** 
1. **PlaywrightHelper** - reusable utility for Chrome access with session management, cookie expiration detection, and hardened error handling
2. **Scraper** (`scrape-purchasing-dashboard.ts`) - extracts purchases data + purchase requests using Playwright
3. **Assessor** (`assess-purchases.ts`) - cross-references scraped items against Finale; extended to handle purchase requests with fuzzy SKU matching
4. **Pipeline Orchestrator** (`run-purchasing-assessment.ts`) - orchestrates scrape → assess → snapshot → diff → notify; stores results in `purchasing_snapshots`
5. **OpsManager Cron** - daily 9:00 AM Mon-Fri execution with Telegram alerts for new HIGH_NEED + new Pending requests
6. **Bot Tool** - `scrape_purchasing_dashboard` command in start-bot.ts for on-demand execution
7. **Cookie Expiration Watchdog** - detects auth redirects and sends Telegram reminder to refresh session

**Tech Stack:** Playwright, TypeScript, Supabase, Finale API, LLM fuzzy matching (from SlackWatchdog), node-cron, Telegraf

---

## Task 1: Create PlaywrightHelper Utility (Reusable Chrome Access Standard)

**Files:**
- Create: `src/lib/playwright/playwright-helper.ts`
- Create: `src/lib/playwright/playwright-helper.test.ts`

### Step 1.1: Write the PlaywrightHelper class

```typescript
// src/lib/playwright/playwright-helper.ts
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

export interface PlaywrightHelperConfig {
    headless?: boolean;
    chromeProfilePath?: string;
    userDataDir?: string;
    timeoutMs?: number;
    sessionCookieExpiry?: Date; // Expected session expiry (from .basauto-session.json)
}

export class PlaywrightHelper {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private config: PlaywrightHelperConfig;

    constructor(config: PlaywrightHelperConfig = {}) {
        this.config = {
            headless: true,
            chromeProfilePath: path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
            userDataDir: path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox', 'playwright-chrome-profile'),
            timeoutMs: 60000,
            ...config
        };
    }

    async launch(): Promise<void> {
        if (this.browser) return;

        // Ensure user data dir exists
        fs.mkdirSync(this.config.userDataDir, { recursive: true });

        this.browser = await chromium.launch({
            headless: this.config.headless,
            args: [
                `--user-data-dir=${this.config.userDataDir}`,
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-gpu'
            ]
        });

        this.context = await this.browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });
    }

    async newPage(): Promise<Page> {
        if (!this.context) await this.launch();
        const page = await this.context.newPage();
        page.setDefaultTimeout(this.config.timeoutMs);
        return page;
    }

    async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
        const page = await this.newPage();
        try {
            return await fn(page);
        } finally {
            await page.close();
        }
    }

    /**
     * Detects if the current session is invalid by checking for redirect to /auth/signin.
     * Returns true if auth failure detected, false otherwise.
     */
    async isSessionExpired(page: Page): Promise<boolean> {
        try {
            // Check current URL or any recent navigation
            const url = page.url();
            if (url.includes('/auth/signin') || url.includes('/login')) {
                return true;
            }

            // Check page content for auth signs
            const content = await page.content();
            const authPhrases = ['sign in', 'log in', 'authentication required'];
            const lowerContent = content.toLowerCase();
            return authPhrases.some(phrase => lowerContent.includes(phrase));
        } catch {
            return false;
        }
    }

    /**
     * Captures a screenshot for debugging (optional)
     */
    async screenshot(page: Page, name: string): Promise<string> {
        const screenshotsDir = path.join(process.cwd(), 'debug-screenshots');
        fs.mkdirSync(screenshotsDir, { recursive: true });
        const filepath = path.join(screenshotsDir, `${name}-${Date.now()}.png`);
        await page.screenshot({ path: filepath, fullPage: true });
        return filepath;
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

export async function withPlaywright<T>(config: PlaywrightHelperConfig, fn: (helper: PlaywrightHelper) => Promise<T>): Promise<T> {
    const helper = new PlaywrightHelper(config);
    try {
        return await fn(helper);
    } finally {
        await helper.close();
    }
}
```

### Step 1.2: Write failing test for PlaywrightHelper

```typescript
// src/lib/playwright/playwright-helper.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withPlaywright, PlaywrightHelper } from './playwright-helper';

describe('PlaywrightHelper', () => {
    it('should launch browser and create page', async () => {
        const result = await withPlaywright({ headless: true }, async (helper) => {
            const page = await helper.newPage();
            expect(page).toBeDefined();
            await page.goto('https://example.com');
            const title = await page.title();
            return title;
        });
        expect(result).toBe('Example Domain');
    });

    it('should detect session expiration on sign-in page', async () => {
        await withPlaywright({ headless: true }, async (helper) => {
            const page = await helper.newPage();
            // Navigate to a sign-in page to simulate auth failure
            await page.goto('https://example.com/auth/signin');
            const isExpired = await helper.isSessionExpired(page);
            expect(isExpired).toBe(true);
        });
    });

    it('should not false-positive session check on normal page', async () => {
        await withPlaywright({ headless: true }, async (helper) => {
            const page = await helper.newPage();
            await page.goto('https://example.com');
            const isExpired = await helper.isSessionExpired(page);
            expect(isExpired).toBe(false);
        });
    });
});
```

### Step 1.3: Install Playwright dependencies and run test

```bash
npm install playwright
npm install -D @playwright/test vitest
npx playwright install chromium
npm run test -- src/lib/playwright/playwright-helper.test.ts
```

### Step 1.4: Run test to verify it fails, then implement minimal code

Test will fail initially because `withPlaywright` doesn't exist. The implementation above should make it pass.

### Step 1.5: Commit

```bash
git add src/lib/playwright/playwright-helper.ts src/lib/playwright/playwright-helper.test.ts
git commit -m "feat: add PlaywrightHelper utility for standardized Chrome access"
```

---

## Task 2: Implement Scraper - `scrape-purchasing-dashboard.ts`

**Files:**
- Create: `src/cli/scrape-purchasing-dashboard.ts`

### Step 2.1: Write scraper with cookie expiration detection

```typescript
// src/cli/scrape-purchasing-dashboard.ts
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { withPlaywright, PlaywrightHelper } from '../lib/playwright/playwright-helper';
import * as fs from 'fs';
import * as path from 'path';
import { Telegraf } from 'telegraf';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PurchaseRequest {
    _source: string;
    date: string;
    department: string;
    type: string;
    details: string;
    quantity: string;
    link: string;
    status: string;
    ordered: string;
}

interface ScrapeResult {
    scrapedAt: string;
    purchases: Record<string, any[]>;  // vendor -> items (purchases-data.json format)
    requests: PurchaseRequest[];
}

// ── Config ────────────────────────────────────────────────────────────────────

const DASHBOARD_URL = 'https://basauto.vercel.app/purchases';
const SESSION_FILE = path.join(process.cwd(), '.basauto-session.json'); // Exported cookie from DevTools
const OUTPUT_DIR = path.join(process.cwd(), '..', '..'); // Project root (one level up from src/cli)
const PURCHASES_OUTPUT = path.join(OUTPUT_DIR, 'purchases-data.json');
const REQUESTS_OUTPUT = path.join(OUTPUT_DIR, 'purchase-requests.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendTelegramAlert(message: string): Promise<void> {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
    if (chatId) {
        await bot.telegram.sendMessage(chatId, `🛒 *Purchasing Dashboard Scrape*\n\n${message}`, {
            parse_mode: 'Markdown'
        });
    }
}

// ── Main Scraping Logic ───────────────────────────────────────────────────────

async function scrapeDashboard(): Promise<ScrapeResult> {
    return await withPlaywright({
        headless: true,
    }, async (helper) => {
        const page = await helper.newPage();

        try {
            console.log('  Navigating to dashboard...');
            await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 30000 });

            // Check for auth redirect
            if (await helper.isSessionExpired(page)) {
                const msg = '❌ Session expired! Dashboard redirected to sign-in page. Please export fresh cookies from DevTools and save as .basauto-session.json (expires ~2026-05-07).';
                console.error(msg);
                await sendTelegramAlert(msg);
                throw new Error('SESSION_EXPIRED');
            }

            console.log('  Waiting for dashboard to load...');
            await page.waitForSelector('[data-testid*="purchase"], table, .purchase-table, text=Overdue', { timeout: 30000 });

            // Extract purchases data (vendor → items table)
            const purchases = await page.evaluate(() => {
                const result: Record<string, any[]> = {};

                // Find vendor sections (likely h2/h3 headers with vendor names)
                const vendorHeaders = Array.from(document.querySelectorAll('h2, h3, .vendor-header')).filter(el =>
                    el.textContent && el.textContent.trim().length > 0
                );

                vendorHeaders.forEach(header => {
                    const vendorName = header.textContent?.trim() || 'Unknown';
                    // Find the next table after this header
                    let table = header.nextElementSibling;
                    while (table && table.tagName !== 'TABLE') {
                        table = table.nextElementSibling;
                    }
                    if (!table) return;

                    const rows = table.querySelectorAll('tr');
                    const headers = Array.from(rows[0]?.querySelectorAll('th') || []).map(th => th.textContent?.trim().toLowerCase() || '');
                    const items: any[] = [];

                    for (let i = 1; i < rows.length; i++) {
                        const cells = rows[i].querySelectorAll('td');
                        if (cells.length === 0) continue;

                        const item: any = {};
                        headers.forEach((h, idx) => {
                            const cell = cells[idx];
                            if (cell) {
                                // Try to extract data-label attribute if present
                                const dataLabel = cell.getAttribute('data-label') || h;
                                item[dataLabel] = cell.textContent?.trim() || '';
                            }
                        });
                        items.push(item);
                    }

                    result[vendorName] = items;
                });

                return result;
            });

            // Extract purchase requests table
            const requests = await page.evaluate(() => {
                const result: any[] = [];

                // Find the purchase requests table (look for "Purchase Request Form" or similar)
                const tableElement = Array.from(document.querySelectorAll('table')).find(table =>
                    table.textContent?.includes('Purchase Request') ||
                    table.textContent?.includes('Request Form') ||
                    table.textContent?.includes('status') &&
                    table.textContent?.includes('Pending')
                );

                if (!tableElement) return result;

                const rows = tableElement.querySelectorAll('tr');
                if (rows.length < 2) return result;

                // Headers from the table
                const headerCells = Array.from(rows[0].querySelectorAll('th, td')).map(th => th.textContent?.trim().toLowerCase() || '');
                const colMap = {
                    date: headerCells.findIndex(h => h.includes('date')),
                    department: headerCells.findIndex(h => h.includes('department')),
                    type: headerCells.findIndex(h => h.includes('type')),
                    details: headerCells.findIndex(h => h.includes('details') || h.includes('item') || h.includes('product')),
                    quantity: headerCells.findIndex(h => h.includes('quantity') || h.includes('qty')),
                    link: headerCells.findIndex(h => h.includes('link')),
                    status: headerCells.findIndex(h => h.includes('status')),
                    ordered: headerCells.findIndex(h => h.includes('ordered') || h.includes('action'))
                };

                for (let i = 1; i < rows.length; i++) {
                    const cells = rows[i].querySelectorAll('td');
                    if (cells.length === 0) continue;

                    const req: any = { _source: 'table' };
                    for (const [key, colIdx] of Object.entries(colMap)) {
                        if (colIdx >= 0 && cells[colIdx]) {
                            req[key] = cells[colIdx].textContent?.trim() || '';
                        } else {
                            req[key] = '';
                        }
                    }
                    result.push(req);
                }

                return result;
            });

            console.log(`  ✓ Scraped ${Object.keys(purchases).length} vendors, ${Object.values(purchases).flat().length} items`);
            console.log(`  ✓ Scraped ${requests.length} purchase requests`);

            return {
                scrapedAt: new Date().toISOString(),
                purchases,
                requests
            };
        } finally {
            await page.close();
        }
    });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n🛒 Scraping Purchasing Dashboard...\n');

    try {
        const result = await scrapeDashboard();

        // Save purchases-data.json
        fs.writeFileSync(PURCHASES_OUTPUT, JSON.stringify(result.purchases, null, 2));
        console.log(`  ✓ Saved purchases to ${PURCHASES_OUTPUT}`);

        // Save purchase-requests.json (only Pending for later assessment)
        const pendingRequests = result.requests.filter(r => r.status === 'Pending');
        const requestsOutput = {
            scrapedAt: result.scrapedAt,
            requests: pendingRequests,
            rawDump: '' // Not needed for automated processing
        };
        fs.writeFileSync(REQUESTS_OUTPUT, JSON.stringify(requestsOutput, null, 2));
        console.log(`  ✓ Saved ${pendingRequests.length} pending requests to ${REQUESTS_OUTPUT}`);

        console.log('\n✅ Scrape complete.\n');
        process.exit(0);
    } catch (err: any) {
        console.error('\n❌ Scrape failed:', err.message);
        if (err.message === 'SESSION_EXPIRED') {
            // Already alerted via Telegram
            process.exit(2);
        }
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
```

### Step 2.2: Write test for scraper (integration test)

```typescript
// src/cli/scrape-purchasing-dashboard.test.ts
import { describe, it, expect } from 'vitest';
import { scrapeDashboard } from './scrape-purchasing-dashboard';

// DECISION: Integration test requires Chrome and logged-in session. Mark as.skip()
// for CI. Manual run: npm run test -- src/cli/scrape-purchasing-dashboard.test.ts

describe('scrape-purchasing-dashboard', () => {
    it('should scrape purchases and requests from dashboard', async () => {
        const result = await scrapeDashboard();

        expect(result.scrapedAt).toBeDefined();
        expect(typeof result.purchases).toBe('object');
        expect(Array.isArray(result.requests)).toBe(true);

        // Requests should be filtered to Pending only
        for (const req of result.requests) {
            expect(req.status).toBe('Pending');
        }
    }, 15000);
});
```

### Step 2.3: Commit

```bash
git add src/cli/scrape-purchasing-dashboard.ts
git commit -m "feat: add dashboard scraper with session expiry detection"
```

---

## Task 3: Extend assess-purchases.ts to Handle Purchase Requests

**Files:**
- Modify: `src/cli/assess-purchases.ts`

### Step 3.1: Extend types to support purchase requests

Add new interface near top of file:

```typescript
interface PurchaseRequest {
    date: string;
    department: string;
    type: 'Existing product' | 'New product';
    details: string;    // Product description or SKU candidates
    quantity: string;   // May be "—" for new products
    status: string;
    _source?: string;
}

interface AssessedRequest extends PurchaseRequest {
    necessity: NecessityLevel;
    matchedSku: string | null;
    matchScore: number | null;
    stockOnHand: number;
    salesVelocity: number;
    runwayDays: number;
    finaleFound: boolean;
    explanation: string;
}
```

### Step 3.2: Add fuzzy matching function (reuse from SlackWatchdog pattern)

Add to `assess-purchases.ts`:

```typescript
// In-memory fuzzy match using Fuse.js (lightweight, no DB needed)
function fuzzyMatchSku(description: string, knownSkus: string[]): { sku: string; score: number } | null {
    // Simple fuzzy: find SKU that appears in description as substring (case-insensitive, hyphen-agnostic)
    const normalizedDesc = description.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    for (const sku of knownSkus) {
        const normalizedSku = sku.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalizedDesc.includes(normalizedSku)) {
            return { sku, score: 1.0 };
        }
        // Prefix match: "BLM207" matches "Blumat - BLM207 - something"
        if (description.toUpperCase().includes(sku)) {
            return { sku, score: 0.9 };
        }
    }

    // Could enhance with Fuse.js later if needed
    return null;
}
```

### Step 3.3: Load purchase requests and known SKUs from Finale

In `main()` after loading scrapedData, add:

```typescript
// Load purchase requests
let requests: PurchaseRequest[] = [];
const requestsPath = path.resolve(__dirname, '../../purchase-requests.json');
if (fs.existsSync(requestsPath)) {
    const requestsData = JSON.parse(fs.readFileSync(requestsPath, 'utf-8'));
    requests = requestsData.requests || [];
    console.log(`  Loaded ${requests.length} purchase requests from ${requestsPath}`);
} else {
    console.log('  ⚠️ purchase-requests.json not found — skipping request assessment');
}

// Fetch known SKUs from Finale for fuzzy matching (lightweight pagination)
async function fetchKnownSkus(): Promise<string[]> {
    const skus: string[] = [];
    try {
        // Use productViewConnection to get active SKUs (limit 500 for fuzzy match perf)
        const query = {
            query: `{
                productViewConnection(first: 500) {
                    edges { node { productId } }
                }
            }`
        };
        const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(query),
        });
        if (res.ok) {
            const result = await res.json();
            const edges = result.data?.productViewConnection?.edges || [];
            for (const edge of edges) {
                if (edge.node?.productId) {
                    skus.push(edge.node.productId);
                }
            }
        }
    } catch (err) {
        console.warn('  ⚠️ Could not fetch SKU catalog from Finale:', err.message);
    }
    return skus;
}

const knownSkus = await fetchKnownSkus();
console.log(`  Fetched ${knownSkus.length} known SKUs from Finale`);
```

### Step 3.4: Assess purchase requests (after assessing scraped items)

After the existing assessment loop and before vendor grouping, add:

```typescript
// ── Assess Purchase Requests ───────────────────────────────────────────────────

if (requests.length > 0) {
    console.log(`\n  Assessing ${requests.length} purchase requests...`);

    const assessedRequests: AssessedRequest[] = [];

    for (const req of requests) {
        const details = req.details;
        const quantity = parseFloat(req.quantity) || 1;

        // Fuzzy match to Finale SKU
        const match = fuzzyMatchSku(details, knownSkus);
        const matchedSku = match?.sku || null;
        const matchScore = match?.score || null;

        let stockOnHand = 0;
        let salesVelocity = 0;
        let dailyRate = 0;
        let runwayDays = Infinity;
        let finaleFound = false;
        let explanation = '';

        if (matchedSku) {
            try {
                // Query Finale for this SKU (reuse getSkuActivity but fetch only stock/sales)
                const activity = await getSkuActivity(client, matchedSku, accountPath, apiBase, authHeader, 90);
                stockOnHand = activity.stockOnHand;
                const purchasedQty = activity.purchasedQty;
                const soldQty = activity.soldQty;
                salesVelocity = soldQty / 90;
                dailyRate = Math.max(soldQty / 90, purchasedQty / 90);
                finaleFound = activity.stockOnHand > 0 || knownSkus.includes(matchedSku);

                if (dailyRate > 0) {
                    runwayDays = stockOnHand / dailyRate;
                }

                // Compute necessity using same logic (but simpler - no lead time for requests?)
                // Use conservative lead time default 14d for requests
                const { necessity, explanation: expl } = computeNecessity(
                    stockOnHand, 0, dailyRate, 14, finaleFound, false
                );

                assessedRequests.push({
                    ...req,
                    necessity,
                    matchedSku,
                    matchScore,
                    stockOnHand,
                    salesVelocity,
                    runwayDays: runwayDays === Infinity ? -1 : Math.round(runwayDays),
                    finaleFound,
                    explanation: expl
                });

                const icon = necessity === 'HIGH_NEED' ? '🔴' : necessity === 'MEDIUM' ? '🟡' : '🟠';
                console.log(`  ${icon} ${matchedSku.padEnd(12)} ${necessity.padEnd(10)} "${details.substring(0, 40)}..."`);
            } catch (err: any) {
                assessedRequests.push({
                    ...req,
                    necessity: 'NOISE',
                    matchedSku: null,
                    matchScore: null,
                    stockOnHand: 0,
                    salesVelocity: 0,
                    runwayDays: -1,
                    finaleFound: false,
                    explanation: `Error assessing: ${err.message}`
                });
            }
        } else {
            assessedRequests.push({
                ...req,
                necessity: 'NOISE',
                matchedSku: null,
                matchScore: null,
                stockOnHand: 0,
                salesVelocity: 0,
                runwayDays: -1,
                finaleFound: false,
                explanation: 'Could not fuzzy-match to any Finale SKU'
            });
            console.log(`  ⚪ NO_MATCH   ${details.substring(0, 50)}`);
        }

        // 100ms throttle
        await new Promise(r => setTimeout(r, 100));
    }

    // Store assessedRequests globally for later grouping/output
    (global as any).assessedRequests = assessedRequests;
}
```

### Step 3.5: Add requests to output (both human-readable and JSON)

At the end, in the output section, add requests summary:

```typescript
// Add after vendor assessments, before final summary:

if (requests.length > 0) {
    const assessedRequests = (global as any).assessedRequests || [];
    const reqHigh = assessedRequests.filter(r => r.necessity === 'HIGH_NEED').length;
    const reqMed = assessedRequests.filter(r => r.necessity === 'MEDIUM').length;
    const reqNoise = assessedRequests.filter(r => r.necessity === 'NOISE').length;

    console.log('\n' + '─'.repeat(80));
    console.log(`  PURCHASE REQUESTS — ${assessedRequests.length} pending requests assessed`);
    console.log(`  🔴 HIGH NEED: ${reqHigh}   🟡 MEDIUM: ${reqMed}   ⚪ NOISE: ${reqNoise}`);

    // Group by necessity
    const byNecessity: Record<string, AssessedRequest[]> = { HIGH_NEED: [], MEDIUM: [], LOW: [], NOISE: [] };
    for (const r of assessedRequests) {
        byNecessity[r.necessity].push(r);
    }

    for (const level of ['HIGH_NEED', 'MEDIUM', 'LOW', 'NOISE'] as const) {
        const list = byNecessity[level];
        if (list.length === 0) continue;
        console.log(`\n  ${level} (${list.length}):`);
        for (const r of list) {
            const sku = r.matchedSku || '(no match)';
            const skuPad = sku.padEnd(14);
            console.log(`    ${skuPad} ${r.department.padEnd(12)} ${r.details.substring(0, 50)}`);
            if (r.matchedSku) {
                console.log(`      ${r.explanation}`);
            }
        }
    }
}
```

### Step 3.6: Update JSON output to include requests

Modify JSON output section:

```typescript
if (jsonOutput) {
    const output = {
        vendorAssessments: vendorAssessments,
        requestAssessments: (global as any).assessedRequests || []
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
}
```

### Step 3.7: Install Fuse.js (optional enhancement)

If you want better fuzzy matching than substring, install Fuse.js:

```bash
npm install fuse.js
```

Then replace `fuzzyMatchSku` with:

```typescript
import Fuse from 'fuse.js';

const fuse = new Fuse(knownSkus.map(sku => ({ sku })), {
    keys: ['sku'],
    threshold: 0.4,
    includeScore: true,
    minMatchCharLength: 3
});

function fuzzyMatchSku(description: string): { sku: string; score: number } | null {
    const results = fuse.search(description);
    if (results.length === 0) return null;
    const best = results[0];
    return { sku: best.item.sku, score: 1 - best.score };
}
```

---

## Task 4: Create Pipeline Orchestrator - `run-purchasing-assessment.ts`

**Files:**
- Create: `src/cli/run-purchasing-assessment.ts`

### Step 4.1: Write orchestrator that runs full pipeline and stores snapshot

```typescript
// src/cli/run-purchasing-assessment.ts
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { scrapeDashboard } from './scrape-purchasing-dashboard';
import { assess } from './assess-purchases'; // Rename main() to assess() and export
import { createClient } from '../lib/supabase';
import { Telegraf } from 'telegraf';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SnapshotDiff {
    newHighNeedSkus: string[];
    newPendingRequests: Array<{ date: string; details: string; quantity: string }>;
}

// ── Main Pipeline ────────────────────────────────────────────────────────────

async function runPipeline(source: 'cron' | 'manual' = 'cron', triggeredBy?: string): Promise<{
    snapshotId: string;
    diff: SnapshotDiff;
    summary: string;
}> {
    console.log('\n🚀 Starting Purchasing Assessment Pipeline...\n');
    const startMs = Date.now();

    // Step 1: Scrape
    console.log('Step 1/4: Scraping dashboard...');
    const scrapeResult = await scrapeDashboard();
    const scrapedAt = scrapeResult.scrapedAt;

    // Step 2: Assess
    console.log('\nStep 2/4: Assessing scraped data...');
    // Call assess-purchases.ts programmatically with the scraped data
    const assessment = await assess(scrapeResult.purchases);

    // Step 3: Load previous snapshot for diff (if exists)
    console.log('\nStep 3/4: Computing diffs...');
    const supabase = createClient();
    let previousSnapshot: any = null;
    if (source === 'cron') {
        const { data } = await supabase
            .from('purchasing_snapshots')
            .select('*')
            .order('generated_at', { ascending: false })
            .limit(1)
            .single();
        previousSnapshot = data;
    }

    // Build diff
    const diff: SnapshotDiff = {
        newHighNeedSkus: [],
        newPendingRequests: []
    };

    // Compare HIGH_NEED items (by SKU) against previous snapshot
    const currentHighNeedSkus = new Set<string>();
    for (const vendor of assessment.vendorAssessments) {
        for (const item of vendor.items) {
            if (item.necessity === 'HIGH_NEED') {
                currentHighNeedSkus.add(item.sku);
            }
        }
    }

    if (previousSnapshot) {
        const prevHighNeed = new Set<string>(previousSnapshot.high_need_count > 0
            ? (previousSnapshot.assessed_items as any[])
                .filter((i: any) => i.necessity === 'HIGH_NEED')
                .map((i: any) => i.sku)
            : []);

        diff.newHighNeedSkus = [...currentHighNeedSkus].filter(sku => !prevHighNeed.has(sku));
    } else {
        diff.newHighNeedSkus = [...currentHighNeedSkus];
    }

    // Compare Pending requests
    const currentRequests = assessment.requestAssessments || [];
    if (previousSnapshot && previousSnapshot.raw_requests) {
        const prevRequests = previousSnapshot.raw_requests as any[] || [];
        const prevReqKeys = new Set(prevRequests.map((r: any) => `${r.date}-${r.details}-${r.quantity}`));
        diff.newPendingRequests = currentRequests.filter(r => !prevReqKeys.has(`${r.date}-${r.details}-${r.quantity}`));
    } else {
        diff.newPendingRequests = currentRequests;
    }

    console.log(`  Diff: ${diff.newHighNeedSkus.length} new HIGH_NEED items, ${diff.newPendingRequests.length} new pending requests`);

    // Step 4: Store snapshot
    console.log('\nStep 4/4: Storing snapshot...');
    const { data: snapshot } = await supabase
        .from('purchasing_snapshots')
        .insert({
            source,
            triggered_by: triggeredBy || 'cron',
            raw_purchases: scrapeResult.purchases,
            raw_requests: currentRequests,
            assessed_items: {
                vendorAssessments: assessment.vendorAssessments,
                requestAssessments: currentRequests
            },
            high_need_count: assessment.vendorAssessments.reduce((sum, v) => sum + v.items.filter(i => i.necessity === 'HIGH_NEED').length, 0),
            medium_count: assessment.vendorAssessments.reduce((sum, v) => sum + v.items.filter(i => i.necessity === 'MEDIUM').length, 0),
            low_count: assessment.vendorAssessments.reduce((sum, v) => sum + v.items.filter(i => i.necessity === 'LOW').length, 0),
            noise_count: assessment.vendorAssessments.reduce((sum, v) => sum + v.items.filter(i => i.necessity === 'NOISE').length, 0),
            new_high_need_skus: diff.newHighNeedSkus,
            new_pending_requests: diff.newPendingRequests,
            duration_ms: Date.now() - startMs,
            items_processed: Object.values(scrapeResult.purchases).flat().length,
            requests_processed: currentRequests.length
        })
        .select('id')
        .single();

    const duration = Date.now() - startMs;
    console.log(`  ✓ Snapshot stored (ID: ${snapshot.id}) in ${duration}ms`);

    // Build summary for Telegram
    const summary = buildTelegramSummary(assessment, diff, scrapedAt);
    
    console.log('\n✅ Pipeline complete.\n');
    return { snapshotId: snapshot.id, diff, summary };
}

function buildTelegramSummary(assessment: any, diff: SnapshotDiff, scrapedAt: string): string {
    const lines: string[] = [];
    lines.push('🛒 <b>Purchasing Intelligence Report</b>');
    lines.push(`Generated: ${new Date(scrapedAt).toLocaleString('en-US', { timeZone: 'America/Denver' })}`);
    lines.push('');

    // New HIGH_NEED items (actionable)
    if (diff.newHighNeedSkus.length > 0) {
        lines.push('<b>🔴 NEW HIGH NEED ITEMS</b> (order now):');
        for (const vendor of assessment.vendorAssessments) {
            const highItems = vendor.items.filter(i => i.necessity === 'HIGH_NEED' && diff.newHighNeedSkus.includes(i.sku));
            for (const item of highItems) {
                const suggest = Math.max(1, Math.ceil(item.dailyRate * (item.leadTimeDays + 60)));
                lines.push(`  <b>${item.sku}</b>: ${item.description}`);
                lines.push(`    Stock: ${Math.round(item.stockOnHand)} | Velocity: ${item.dailyRate.toFixed(2)}/d | Runway: ${item.adjustedRunwayDays}d (adj ${item.adjustedRunwayDays}d)`);
                lines.push(`    Suggest ordering: ~${suggest} units`);
            }
        }
        lines.push('');
    }

    // New Pending Requests
    if (diff.newPendingRequests.length > 0) {
        lines.push('<b>📋 NEW PENDING REQUESTS</b> (review):');
        for (const req of diff.newPendingRequests) {
            const skuInfo = req.matchedSku ? ` → <b>${req.matchedSku}</b>` : '';
            lines.push(`  ${req.department}: ${req.details.substring(0, 60)}${skuInfo}`);
            lines.push(`    qty: ${req.quantity} | date: ${req.date}`);
            if (req.finaleFound && req.stockOnHand !== undefined) {
                lines.push(`    Stock: ${req.stockOnHand} | Runway: ${req.runwayDays}d`);
            }
        }
        lines.push('');
    }

    // Summary counts
    const totalHigh = assessment.vendorAssessments.reduce((sum: number, v: any) => sum + v.items.filter((i: any) => i.necessity === 'HIGH_NEED').length, 0);
    const totalMed = assessment.vendorAssessments.reduce((sum: number, v: any) => sum + v.items.filter((i: any) => i.necessity === 'MEDIUM').length, 0);
    lines.push(`<i>Totals: ${totalHigh} HIGH_NEED, ${totalMed} MEDIUM, ${assessment.vendorAssessments.length} vendors</i>`);

    return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const isManual = args.includes('--manual');
    const source: 'cron' | 'manual' = isManual ? 'manual' : 'cron';
    const triggeredBy = isManual ? 'user' : 'cron';

    try {
        const result = await runPipeline(source, triggeredBy);

        // Send Telegram notification if there are new actionable items
        if (result.diff.newHighNeedSkus.length > 0 || result.diff.newPendingRequests.length > 0) {
            const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId) {
                await bot.telegram.sendMessage(chatId, result.summary, { parse_mode: 'HTML' });
                console.log('  ✓ Telegram alert sent.');
            }
        } else {
            console.log('  ℹ️ No new actionable items — no Telegram alert sent.');
        }

        process.exit(0);
    } catch (err: any) {
        console.error('\n❌ Pipeline failed:', err.message);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
```

---

## Task 5: Integrate Cron Job into OpsManager

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`

### Step 5.1: Add cron job at 9:00 AM Mon-Fri

Find the `start()` method in OpsManager and add after the existing 8:01 AM Friday cron (around line 320):

```typescript
// Daily Purchasing Assessment @ 9:00 AM weekdays
cron.schedule("0 9 * * 1-5", () => {
    this.safeRun("PurchasingAssessment", async () => {
        const { runPipeline } = await import("../../cli/run-purchasing-assessment");
        // Run as cron (not manual); results automatically stored + Telegram sent if needed
        await runPipeline('cron', 'cron');
    });
}, { timezone: "America/Denver" });
```

### Step 5.2: Commit OpsManager change

```bash
git add src/lib/intelligence/ops-manager.ts
git commit -m "feat: add daily purchasing assessment cron at 9:00 AM Mon-Fri"
```

---

## Task 6: Add Bot Tool - `scrape_purchasing_dashboard`

**Files:**
- Modify: `src/cli/start-bot.ts`

### Step 6.1: Import and register the bot tool

Near the top of `start-bot.ts` (after other imports), add:

```typescript
import { runPipeline } from './run-purchasing-assessment';
```

Later where bot commands are defined (probably in the modular `commands/` system or inline), add:

```typescript
// On-demand scraping and assessment
bot.command('scrape_purchasing_dashboard', async (ctx) => {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    // Only allow Will (check TELEGRAM_CHAT_ID)
    if (process.env.TELEGRAM_CHAT_ID && chatId.toString() !== process.env.TELEGRAM_CHAT_ID) {
        await ctx.reply('❌ This command is restricted.');
        return;
    }

    await ctx.reply('🛒 Starting purchasing dashboard scrape & assessment... This will take a minute.');

    try {
        const result = await runPipeline('manual', `user:${chatId}`);

        await ctx.reply(`✅ Complete!\n\n${result.summary}`, { parse_mode: 'HTML' });
    } catch (err: any) {
        await ctx.reply(`❌ Failed: ${err.message}`);
    }
});
```

If using modular commands, create `src/cli/commands/purchasing-commands.ts`:

```typescript
import { TelegrafContext } from 'telegraf';
import { runPipeline } from '../run-purchasing-assessment';

export function registerPurchasingCommands(bot: any) {
    bot.command('scrape_purchasing_dashboard', async (ctx: TelegrafContext) => {
        const chatId = ctx.from?.id;
        if (!chatId) return;

        if (process.env.TELEGRAM_CHAT_ID && chatId.toString() !== process.env.TELEGRAM_CHAT_ID) {
            await ctx.reply('❌ This command is restricted.');
            return;
        }

        await ctx.reply('🛒 Starting purchasing dashboard scrape & assessment...');

        try {
            const result = await runPipeline('manual', `user:${chatId}`);
            await ctx.reply(result.summary, { parse_mode: 'HTML' });
        } catch (err: any) {
            await ctx.reply(`❌ Failed: ${err.message}`);
        }
    });
}
```

And update `commands/index.ts` to call it during registration.

### Step 6.2: Commit

```bash
git add src/cli/start-bot.ts   # or new commands file
git commit -m "feat: add /scrape_purchasing_dashboard bot command for on-demand execution"
```

---

## Task 7: Add Cookie Expiration Reminder

The cookie expiration check is already implemented in `playwright-helper.ts`'s `isSessionExpired()` and used in `scrape-purchasing-dashboard.ts`. It detects redirects to `/auth/signin` and sends a Telegram alert.

**Enhancement:** Also store session cookie metadata in `.basauto-session.json` and check its expiry date.

### Step 7.1: Update scraper to read/write session file

In `scrape-purchasing-dashboard.ts`, after successful login/load:

```typescript
// After establishing session (post-navigation), capture cookies and save
const cookies = await page.context()?.cookies();
if (cookies) {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
        savedAt: new Date().toISOString(),
        expires: '2026-05-07T00:00:00.000Z', // Placeholder - real expiry from cookie _vercel or next-auth.session-token
        cookies
    }, null, 2));
    console.log('  ✓ Session cookies saved to .basauto-session.json');
}
```

Then at start of `scrapeDashboard()`, before navigating:

```typescript
// Load session cookies if available
if (fs.existsSync(SESSION_FILE)) {
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    constExpiry = new Date(session.expires);
    if (new Date() > expiry) {
        await sendTelegramAlert('⚠️ .basauto-session.json has expired. Please refresh from DevTools.');
        throw new Error('SESSION_EXPIRED');
    }
    // Apply cookies to browser context before navigation
    await context = await browser.newContext();
    await context.addCookies(session.cookies);
}
```

### Step 7.2: Commit

```bash
git add src/cli/scrape-purchasing-dashboard.ts
git commit -m "enhance: persist session cookies and check expiry"
```

---

## Task 8: Create Shared Assess Function (for programmatic use)

**Files:**
- Modify: `src/cli/assess-purchases.ts`

### Step 8.1: Refactor to export `assess()` function

Rename the existing `main()` to `assess()` and return structured data:

```typescript
// At bottom of assess-purchases.ts, replace:
export async function assess(scrapedData: ScrapedData, requestsData?: PurchaseRequest[]): Promise<{
    vendorAssessments: VendorAssessment[];
    requestAssessments: AssessedRequest[];
}> {
    // Move all existing main() logic here, but instead of reading file, use provided data
    // Remove file reading, change main() to call assess() and output accordingly
}

// Keep original main() as thin wrapper:
async function main() {
    const args = process.argv.slice(2);
    const jsonOutput = args.includes('--json');
    const vendorFilterIdx = args.indexOf('--vendor');
    const vendorFilter = vendorFilterIdx >= 0 ? args[vendorFilterIdx + 1]?.toLowerCase() : null;

    // Load scraped data
    const dataPath = path.resolve(__dirname, '../../purchases-data.json');
    const scrapedData: ScrapedData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

    // Load requests if available
    let requests: PurchaseRequest[] = [];
    const requestsPath = path.resolve(__dirname, '../../purchase-requests.json');
    if (fs.existsSync(requestsPath)) {
        const requestsJson = JSON.parse(fs.readFileSync(requestsPath, 'utf-8'));
        requests = requestsJson.requests || [];
    }

    const result = await assess(scrapedData, requests);

    // ... rest of existing output logic ...
```

### Step 8.2: Commit

```bash
git add src/cli/assess-purchases.ts
git commit -m "refactor: extract assess() function for programmatic use by pipeline"
```

---

## Task 9: Testing and Validation

### Step 9.1: Apply remaining Supabase migration (if not already)

```bash
node _run_migration.js supabase/migrations/20260407_create_purchasing_snapshots.sql
```

### Step 9.2: Run full pipeline manually (test)

```bash
# Test scraper alone
node --import tsx src/cli/scrape-purchasing-dashboard.ts

# Test assessment on scraped data
node --import tsx src/cli/assess-purchases.ts --json > /dev/null

# Test full pipeline
node --import tsx src/cli/run-purchasing-assessment.ts --manual
```

### Step 9.3: Check snapshot table

```bash
# In Supabase SQL editor:
SELECT * FROM purchasing_snapshots ORDER BY generated_at DESC LIMIT 3;
```

### Step 9.4: Test bot command with Telegram

```
/scrape_purchasing_dashboard
```

Should return a formatted summary.

### Step 9.5: Verify cron is registered (after bot restart)

```bash
# Check cron status via Telegram /crons command or Supabase cron_runs table
```

---

## Task 10: Documentation and Final Checks

### Step 10.1: Update CLAUDE.md with new instructions

Add to `CLAUDE.md` under Commands:

```markdown
# Purchasing Automation
node --import tsx src/cli/scrape-purchasing-dashboard.ts        # Scrape BasAuto dashboard
node --import tsx src/cli/assess-purchases.ts                  # Assess scraped items (standalone)
node --import tsx src/cli/run-purchasing-assessment.ts [--manual]  # Full pipeline
Telegram: /scrape_purchasing_dashboard                        # On-demand trigger
```

### Step 10.2: Add .basauto-session.json to .gitignore

```
.basauto-session.json
```

### Step 10.3: Run final typecheck and lint

```bash
npm run typecheck:cli
npm run lint
```

### Step 10.4: Commit documentation

```bash
git add CLAUDE.md .gitignore
git commit -m "docs: add purchasing automation commands and ignore session file"
```

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Purchasing Intelligence                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  9:00 AM Mon-Fri Cron                                                │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  run-purchasing-assessment.ts (pipeline orchestrator)      │   │
│  │                                                              │   │
│  │  1. scrape-purchasing-dashboard.ts                         │   │
│  │     • PlaywrightHelper (Chrome profile)                    │   │
│  │     • Detects auth redirect → Telegram cookie reminder     │   │
│  │     • Saves purchases-data.json + purchase-requests.json  │   │
│  │                                                              │   │
│  │  2. assess-purchases.ts                                    │   │
│  │     • Fetches Finale stock/velocity/POs per SKU           │   │
│  │     • Computes HIGH_NEED/MEDIUM/LOW/NOISE                 │   │
│  │     • Fuzzy-matches purchase requests → SKU               │   │
│  │     • Assesses requests by Finale stock                   │   │
│  │                                                              │   │
│  │  3. Diff vs previous snapshot (purchasing_snapshots table)│   │
│  │     • New HIGH_NEED skus                                   │   │
│  │     • New Pending requests                                │   │
│  │                                                              │   │
│  │  4. Telegram alert if new actionable items               │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  On-Demand Trigger: /scrape_purchasing_dashboard                  │
│  (invokes same pipeline with source='manual')                     │
│                                                                     │
│  Data Storage: purchasing_snapshots (full JSON capture)           │
│  ───────────────────────────────────────────────────────────────  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Order

1. **Task 1**: PlaywrightHelper (core foundation for reliable Chrome access)
2. **Task 2**: Scraper with session expiry detection
3. **Task 3**: Extend assess-purchases.ts for requests + fuzzy matching
4. **Task 8**: Refactor assess into reusable function
5. **Task 4**: Pipeline orchestrator with snapshot/diff/notify
6. **Task 5**: Add cron job to OpsManager
7. **Task 6**: Add bot tool
8. **Task 7**: Cookie persistence + expiry checking
9. **Task 9**: Test everything end-to-end
10. **Task 10**: Documentation and cleanup

---

## Notes

- All new CLI scripts live in `src/cli/` and are executable via `node --import tsx`
- Playwright uses `headless: true` by default for server compatibility
- Cookie file `.basauto-session.json` should be added to `.gitignore`
- Fuse.js provides production-grade fuzzy matching (could be added later)
- `purchasing_snapshots` table captures full fidelity for audit/rollback
- Telegram alerts are rate-limited naturally (only when new items appear)
- The system is idempotent: re-running within same day won't spam alerts
- All new dependencies: `playwright`, `@playwright/test`, `fuse.js` (optional)

---

**Plan complete and saved to `docs/plans/2026-04-07-purchasing-intelligence-system.md`.**

**Two execution options:**

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration  
**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
