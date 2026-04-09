/**
 * scrape-purchases.ts — Scrape basauto.vercel.app/purchases for vendor purchasing suggestions
 * AND the Purchase Request Form tab for user-submitted requests.
 *
 * Uses Playwright `launchPersistentContext` against a dedicated profile dir
 * (`.basauto-profile/`) so it runs in parallel with Will's main Chrome instead of
 * requiring CDP or closing Chrome first. First run is headed so Will can sign in
 * once; subsequent runs reuse the saved session and can run headless.
 *
 * Usage:
 *   node --import tsx src/cli/scrape-purchases.ts              # normal headless scrape
 *   node --import tsx src/cli/scrape-purchases.ts --login      # headed, sit on sign-in page
 *   node --import tsx src/cli/scrape-purchases.ts --headed     # headless off (debug)
 *   node --import tsx src/cli/scrape-purchases.ts --skip-requests  # only Purchases tab
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { BrowserManager } from '../lib/scraping/browser-manager';
import fs from 'fs';
import path from 'path';

const PROFILE_DIR = path.resolve(process.cwd(), '.basauto-profile');
const SESSION_FILE = path.resolve(process.cwd(), '.basauto-session.json');
const BASE_URL = 'https://basauto.vercel.app';
const PURCHASES_URL = `${BASE_URL}/purchases`;

// 1Password extension, pulled from Will's main Chrome profile so sign-in works
// with his existing vault.
const ONEPASSWORD_EXT_ID = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
function resolveOnePasswordExtension(): string | null {
  const base = path.join(
    process.env.LOCALAPPDATA || 'C:\\Users\\BuildASoil\\AppData\\Local',
    'Google', 'Chrome', 'User Data', 'Default', 'Extensions', ONEPASSWORD_EXT_ID,
  );
  if (!fs.existsSync(base)) return null;
  const versions = fs.readdirSync(base).filter(v => !v.startsWith('.')).sort();
  if (versions.length === 0) return null;
  return path.join(base, versions[versions.length - 1]);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const dataIndex = args.findIndex(a => a === '--data');
  return {
    login: args.includes('--login'),
    headed: args.includes('--headed') || args.includes('--login'),
    skipRequests: args.includes('--skip-requests'),
    dataFile: dataIndex !== -1 && dataIndex + 1 < args.length ? args[dataIndex + 1] : null,
  };
}

async function sendExpiryAlert() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (botToken && chatId) {
    try {
      const { Telegraf } = await import('telegraf');
      const bot = new Telegraf(botToken);
      await bot.telegram.sendMessage(
        chatId,
        '⚠️ basauto.vercel.app session expired or invalid. Please refresh .basauto-session.json from Chrome DevTools:\n' +
        '1. Open Chrome DevTools (F12)\n' +
        '2. Application tab → Cookies → https://basauto.vercel.app\n' +
        '3. Right-click → Copy → Copy as JSON\n' +
        '4. Save to project root as .basauto-session.json',
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.warn('Failed to send Telegram alert:', e);
    }
  }
}

async function ensureSignedIn(page: Page, headed: boolean): Promise<boolean> {
  await page.goto(PURCHASES_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  if (!page.url().includes('/auth/signin') && page.url().includes('/purchases')) {
    return true; // already signed in
  }

  if (!headed) {
    console.error('\n✗ Not signed in to basauto.vercel.app.');
    console.error('  Run once with --login to authenticate:');
    console.error('    node --import tsx src/cli/scrape-purchases.ts --login\n');
    await sendExpiryAlert().catch(() => {});
    return false;
  }

  console.log('\n→ Sign-in required. A browser window is open.');
  console.log('  Complete sign-in in that window. I\'ll poll until you land on /purchases.');
  console.log('  (5 minute timeout)\n');

  const deadline = Date.now() + 5 * 60 * 1000;
  let lastUrl = '';
  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== lastUrl) {
      console.log(`  [url] ${url}`);
      lastUrl = url;
    }
    if (url.includes('/purchases') && !url.includes('/auth/')) {
      await page.waitForTimeout(1500);
      console.log('\n✓ Detected successful sign-in.');
      return true;
    }
    await page.waitForTimeout(1500);
  }

  console.error('\n✗ Timed out waiting for sign-in.');
  await sendExpiryAlert().catch(() => {});
  return false;
}

// ── Purchases tab scrape (vendor chips → per-SKU cards) ──
async function scrapePurchasesTab(page: Page): Promise<Record<string, any[]>> {
  // Extra hydration wait — page uses React Query / SWR; buttons appear after fetch
  try {
    await page.waitForSelector('button', { state: 'visible', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(2000);

  // Make sure we're on the Purchases tab (not Purchase Request Form)
  const purchasesTab = page.getByRole('tab', { name: /^Purchases$/ }).first();
  if (await purchasesTab.isVisible().catch(() => false)) {
    await purchasesTab.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  // Diagnostic: if we still can't find things, dump what we see
  const allButtons = await page.locator('button').all();
  if (allButtons.length < 3) {
    console.log(`  [diag] only ${allButtons.length} buttons on page. URL=${page.url()}`);
    const bodyText = (await page.locator('body').textContent().catch(() => '') || '').slice(0, 800);
    console.log(`  [diag] body sample: ${bodyText.replace(/\s+/g, ' ')}`);
    const screenshotPath = path.join(process.cwd(), 'debug-scrape.png');
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.log(`  [diag] screenshot saved to ${screenshotPath}`);
    const htmlPath = path.join(process.cwd(), 'debug-scrape.html');
    fs.writeFileSync(htmlPath, await page.content().catch(() => ''));
    console.log(`  [diag] html saved to ${htmlPath}`);
  }
  const vendorChips: Array<{ el: any; name: string }> = [];

  for (const btn of allButtons) {
    const text = (await btn.textContent())?.trim() || '';
    const isVisible = await btn.isVisible().catch(() => false);
    if (!isVisible) continue;
    if (
      text.match(/^[A-Z][\w\s.,&'()-]+\d+$/i) &&
      !['Purchases', 'Overdue', 'Purchase Request', 'Tutorial'].some(s => text.includes(s))
    ) {
      vendorChips.push({ el: btn, name: text });
    }
  }

  console.log(`Found ${vendorChips.length} vendor chips:`);
  vendorChips.forEach(vc => console.log(`  - ${vc.name}`));

  const allVendorData: Record<string, any[]> = {};

  for (const { el, name } of vendorChips) {
    console.log(`\n=== ${name} ===`);
    await el.click();
    await page.waitForTimeout(2500);

    const items = await page.evaluate(`
      (function() {
        var results = [];
        var headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
        for (var i = 0; i < headings.length; i++) {
          var h = headings[i];
          var sku = (h.textContent || '').trim();
          if (!sku.match(/^[A-Z0-9][\\w-]{2,15}$/i)) continue;

          var card = h.parentElement;
          for (var j = 0; j < 5; j++) {
            if (!card || !card.parentElement) break;
            var parentLen = (card.parentElement.textContent || '').length;
            var cardLen = (card.textContent || '').length;
            if (parentLen > cardLen * 2) break;
            card = card.parentElement;
          }
          if (!card) continue;

          var description = '';
          var nextEl = h.nextElementSibling;
          if (nextEl && (nextEl.textContent || '').length < 200) {
            description = (nextEl.textContent || '').trim();
          }

          var urgency = '';
          var allSpans = card.querySelectorAll('span, div, p, a');
          for (var k = 0; k < allSpans.length; k++) {
            var spanText = (allSpans[k].textContent || '').trim().toUpperCase();
            if (spanText === 'URGENT' || spanText === 'OVERDUE' || spanText === 'PURCHASE' || spanText === 'OK') {
              urgency = spanText;
              break;
            }
          }

          var metrics = {};
          var leaves = card.querySelectorAll('*');
          var prevLabel = '';
          for (var m = 0; m < leaves.length; m++) {
            var leaf = leaves[m];
            if (leaf.children.length > 0) continue;
            var txt = (leaf.textContent || '').trim();
            if (!txt) continue;
            var isLabel = (txt === txt.toUpperCase()) && txt.length > 3 && txt.length < 50 && !/^[\\d$]/.test(txt);
            if (isLabel) {
              prevLabel = txt;
            } else if (prevLabel && txt.length < 60) {
              metrics[prevLabel] = txt;
              prevLabel = '';
            }
          }

          results.push({
            sku: sku,
            description: description,
            urgency: urgency,
            purchaseAgainBy: metrics['PURCHASE AGAIN BY'] || '',
            recommendedReorderQty: metrics['RECOMMENDED REORDER QUANTITY'] || '',
            supplierLeadTime: metrics['SUPPLIER LEAD TIME'] || '',
            remaining: metrics['REMAINING'] || '',
            last30DaysSold: metrics['LAST 30 DAYS SOLD'] || '',
            last90DaysSold: metrics['LAST 90 DAYS SOLD'] || '',
            dailyVelocity: metrics['DAILY VELOCITY'] || '',
            ninetyDayConsumed: metrics['90 DAY CONSUMED'] || '',
            avgBuildConsumption: metrics['AVG BUILD CONSUMPTION'] || '',
            daysBuildsLeft: metrics['DAYS/BUILDS LEFT'] || '',
            lastReceived: metrics['LAST RECEIVED'] || '',
            ytdQtyBought: metrics['YTD QTY BOUGHT'] || '',
            ytdPurchaseCost: metrics['YTD PURCHASE COST'] || '',
            cogsExclShip: metrics['COGS EXCLUDING SHIP'] || '',
            ytdQtySold: metrics['YTD QTY SOLD'] || '',
            ytdRevenue: metrics['YTD REVENUE'] || '',
            itemMargin: metrics['ITEM MARGIN BEFORE SHIPPING'] || '',
          });
        }
        return results;
      })()
    `);

    allVendorData[name] = items as any[];

    for (const item of items as any[]) {
      console.log(`  [${item.urgency || '?'}] ${item.sku} — ${item.description}`);
    }
  }

  return allVendorData;
}

// ── Purchase Request Form tab scrape ──
// Captures user-submitted open requests. The tab may also contain a submit form —
// we only read the list portion. DOM structure is captured defensively since we
// haven't seen it yet; everything inside the tab panel is dumped to `rawBlocks`
// on the first run so we can iterate selectors.
async function scrapeRequestsTab(page: Page): Promise<{ requests: any[]; rawDump?: string }> {
  const tabs = await page.locator('button, [role="tab"], a').all();
  let tabEl: any = null;
  for (const t of tabs) {
    const txt = ((await t.textContent().catch(() => ''))?.trim() || '').toLowerCase();
    const visible = await t.isVisible().catch(() => false);
    if (!visible) continue;
    if (txt === 'purchase request form' || txt === 'purchase requests' || txt.startsWith('purchase request')) {
      tabEl = t;
      break;
    }
  }

  if (!tabEl) {
    console.log('  (Purchase Request Form tab not found — skipping)');
    return { requests: [] };
  }

  await tabEl.click();
  await page.waitForTimeout(2000);

  const result = await page.evaluate(`
    (function() {
      // Heuristic: find the tab panel / main content region
      var panel = document.querySelector('[role="tabpanel"]') || document.querySelector('main') || document.body;

      // Look for table rows first (most common list layout)
      var rows = panel.querySelectorAll('tr');
      var requests = [];
      if (rows.length > 1) {
        var headerRow = rows[0];
        var headers = [];
        headerRow.querySelectorAll('th, td').forEach(function(c) {
          headers.push((c.textContent || '').trim().toLowerCase().replace(/\\s+/g, '_'));
        });
        for (var i = 1; i < rows.length; i++) {
          var cells = rows[i].querySelectorAll('td');
          if (cells.length === 0) continue;
          var obj = { _source: 'table' };
          for (var c = 0; c < cells.length; c++) {
            var key = headers[c] || ('col' + c);
            obj[key] = (cells[c].textContent || '').trim();
          }
          requests.push(obj);
        }
      }

      // Fallback: card-style list (article / li / div with repeated structure)
      if (requests.length === 0) {
        var cards = panel.querySelectorAll('article, li, [class*="card"], [class*="request"]');
        for (var k = 0; k < cards.length; k++) {
          var card = cards[k];
          var txt = (card.textContent || '').trim();
          if (txt.length < 20 || txt.length > 2000) continue;
          requests.push({
            _source: 'card',
            text: txt.replace(/\\s+/g, ' '),
          });
        }
      }

      // Raw dump of the first 4000 chars so the scraper author can see the DOM
      // shape on initial runs. Strip scripts/styles.
      var clone = panel.cloneNode(true);
      clone.querySelectorAll('script, style').forEach(function(n) { n.remove(); });
      var rawDump = (clone.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 4000);

      return { requests: requests, rawDump: rawDump };
    })()
  `);

  return result as { requests: any[]; rawDump?: string };
}

async function main() {
  const opts = parseArgs();
  const manager = BrowserManager.getInstance();
  const sessionValid = await manager.checkSession(PURCHASES_URL, SESSION_FILE);
  if (!sessionValid) {
    if (!opts.login) {
      throw new Error('Session expired');
    }
  } else if (opts.login) {
    console.log('Already signed in. Use --login only when setting up a new session.\n');
    process.exit(0);
  }

  const page = await manager.launchBrowser({
    headless: !opts.headed,
    cookiesPath: SESSION_FILE
  });

  try {
    const signedIn = await ensureSignedIn(page, opts.headed);
    if (!signedIn) {
      await manager.destroy();
      process.exit(1);
    }

    if (opts.login) {
      console.log('\n✓ Signed in. Cookies saved to .basauto-session.json');
      console.log('  You can now run without --login for headless scrapes.\n');
      await manager.saveCookies();
      await manager.destroy();
      process.exit(0);
    }

    console.log('\n── Scraping Purchases tab ──');
    const purchases = await scrapePurchasesTab(page);

    let requests: any[] = [];
    let rawDump: string | undefined;
    if (!opts.skipRequests) {
      console.log('\n── Scraping Purchase Request Form tab ──');
      const r = await scrapeRequestsTab(page);
      requests = r.requests;
      rawDump = r.rawDump;
      console.log(`  Found ${requests.length} request rows`);
    }

    // Persist
    const purchasesPath = path.join(process.cwd(), opts.dataFile || 'purchases-data.json');
    fs.writeFileSync(purchasesPath, JSON.stringify(purchases, null, 2));
    console.log(`\nSaved purchases → ${purchasesPath}`);

    if (!opts.skipRequests) {
      const requestsPath = path.join(process.cwd(), 'purchase-requests.json');
      fs.writeFileSync(
        requestsPath,
        JSON.stringify({ scrapedAt: new Date().toISOString(), requests, rawDump }, null, 2),
      );
      console.log(`Saved requests → ${requestsPath}`);
    }

    // Summary
    let totalItems = 0;
    const byUrgency: Record<string, any[]> = { OVERDUE: [], URGENT: [], PURCHASE: [], OTHER: [] };
    for (const [vendor, items] of Object.entries(purchases)) {
      totalItems += items.length;
      for (const item of items) {
        const vendorClean = vendor.replace(/\d+$/, '').trim();
        const entry = { vendor: vendorClean, ...item };
        const u = (item.urgency || '').toUpperCase();
        if (byUrgency[u]) byUrgency[u].push(entry);
        else byUrgency.OTHER.push(entry);
      }
    }

    console.log('\n============================');
    console.log('   PURCHASING SUMMARY');
    console.log('============================');
    console.log(`Vendors: ${Object.keys(purchases).length} | Items: ${totalItems}`);
    console.log(`OVERDUE: ${byUrgency.OVERDUE.length} | URGENT: ${byUrgency.URGENT.length} | PURCHASE: ${byUrgency.PURCHASE.length}`);
    if (!opts.skipRequests) console.log(`Requests: ${requests.length}`);
  } finally {
    await manager.destroy();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
