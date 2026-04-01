import { chromium, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';

async function scrapePurchases() {
  console.log('Connecting to Chrome via CDP on 127.0.0.1:9222...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  console.log('Connected!\n');

  const context = browser.contexts()[0];
  let page = context.pages().find(p => p.url().includes('basauto'));
  if (!page) {
    page = await context.newPage();
  }

  if (!page.url().includes('/purchases')) {
    await page.goto('https://basauto.vercel.app/purchases', { waitUntil: 'networkidle', timeout: 60000 });
  }
  await page.waitForTimeout(2000);
  console.log('URL:', page.url(), '\n');

  // Find vendor chip buttons
  const allButtons = await page.locator('button').all();
  const vendorChips: Array<{ el: any; name: string }> = [];

  for (let i = 0; i < allButtons.length; i++) {
    const btn = allButtons[i];
    const text = (await btn.textContent())?.trim() || '';
    const isVisible = await btn.isVisible().catch(() => false);
    if (!isVisible) continue;
    // Vendor chips: "AC Infinity Inc.1", "Amazon4", "ULINE7", etc.
    if (text.match(/^[A-Z][\w\s.,&'()-]+\d+$/i) &&
        !['Purchases', 'Overdue', 'Purchase Request', 'Tutorial'].some(s => text.includes(s))) {
      vendorChips.push({ el: btn, name: text });
    }
  }

  console.log(`Found ${vendorChips.length} vendor chips:`);
  vendorChips.forEach(vc => console.log(`  - ${vc.name}`));

  const allVendorData: Record<string, any[]> = {};

  for (let v = 0; v < vendorChips.length; v++) {
    const { el, name } = vendorChips[v];
    console.log(`\n=== ${name} ===`);

    await el.click();
    await page.waitForTimeout(2500);

    // Use page.evaluate with a plain JS string to avoid tsx transform issues
    const items = await page.evaluate(`
      (function() {
        var results = [];
        var headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');

        for (var i = 0; i < headings.length; i++) {
          var h = headings[i];
          var sku = (h.textContent || '').trim();
          if (!sku.match(/^[A-Z0-9][\\w-]{2,15}$/i)) continue;

          // Walk up to find card container
          var card = h.parentElement;
          for (var j = 0; j < 5; j++) {
            if (!card || !card.parentElement) break;
            var parentLen = (card.parentElement.textContent || '').length;
            var cardLen = (card.textContent || '').length;
            if (parentLen > cardLen * 2) break;
            card = card.parentElement;
          }
          if (!card) continue;

          // Get description (element right after heading)
          var description = '';
          var nextEl = h.nextElementSibling;
          if (nextEl && (nextEl.textContent || '').length < 200) {
            description = (nextEl.textContent || '').trim();
          }

          // Find urgency badge text
          var urgency = '';
          var allSpans = card.querySelectorAll('span, div, p, a');
          for (var k = 0; k < allSpans.length; k++) {
            var spanText = (allSpans[k].textContent || '').trim().toUpperCase();
            if (spanText === 'URGENT' || spanText === 'OVERDUE' || spanText === 'PURCHASE' || spanText === 'OK') {
              urgency = spanText;
              break;
            }
          }

          // Extract label→value pairs from leaf nodes
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
      console.log(`    Purchase By: ${item.purchaseAgainBy} | Reorder Qty: ${item.recommendedReorderQty} | Lead: ${item.supplierLeadTime}`);
      console.log(`    Remaining: ${item.remaining} | Days Left: ${item.daysBuildsLeft} | Velocity: ${item.dailyVelocity}`);
    }
  }

  // Save JSON
  const outputPath = path.join(process.cwd(), 'purchases-data.json');
  fs.writeFileSync(outputPath, JSON.stringify(allVendorData, null, 2));

  // Summary
  console.log('\n============================');
  console.log('   PURCHASING SUMMARY');
  console.log('============================\n');

  let totalItems = 0;
  const byUrgency: Record<string, any[]> = { OVERDUE: [], URGENT: [], PURCHASE: [], OTHER: [] };

  for (const [vendor, items] of Object.entries(allVendorData)) {
    totalItems += items.length;
    for (const item of items) {
      const vendorClean = vendor.replace(/\d+$/, '').trim();
      const entry = { vendor: vendorClean, ...item };
      const u = (item.urgency || '').toUpperCase();
      if (byUrgency[u]) byUrgency[u].push(entry);
      else byUrgency.OTHER.push(entry);
    }
  }

  console.log(`Vendors: ${Object.keys(allVendorData).length} | Items: ${totalItems}`);
  console.log(`OVERDUE: ${byUrgency.OVERDUE.length} | URGENT: ${byUrgency.URGENT.length} | PURCHASE: ${byUrgency.PURCHASE.length}\n`);

  for (const level of ['OVERDUE', 'URGENT', 'PURCHASE']) {
    if (byUrgency[level].length === 0) continue;
    console.log(`--- ${level} ---`);
    for (const item of byUrgency[level]) {
      console.log(`  ${item.vendor} | ${item.sku} — ${item.description}`);
      console.log(`    Buy by: ${item.purchaseAgainBy} | Qty: ${item.recommendedReorderQty} | Remaining: ${item.remaining} | Days left: ${item.daysBuildsLeft}`);
    }
    console.log('');
  }

  console.log(`Saved to ${outputPath}`);
  browser.close();
}

scrapePurchases().catch(console.error);
