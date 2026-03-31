import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  snapshotVendorButtons,
  extractVendorChipNames,
  clickVendorChip,
} from "@/lib/purchasing/purchases-scraper-nav";

const PURCHASES_URL = "https://basauto.vercel.app/purchases";
const CDP_ENDPOINT = "http://127.0.0.1:9222";
const PAGE_SETTLE_MS = 750;

async function ensurePurchasesPage(page: any) {
  if (!page.url().includes("/purchases")) {
    await page.goto(PURCHASES_URL, { waitUntil: "networkidle", timeout: 60000 });
  }

  await page.waitForSelector("button", { timeout: 30000 });
  await page.waitForTimeout(PAGE_SETTLE_MS);
}

async function scrapePurchases() {
  console.log(`Connecting to Chrome via CDP on ${CDP_ENDPOINT}...`);
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  console.log("Connected!\n");

  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("basauto"));
  if (!page) {
    page = await context.newPage();
  }

  await ensurePurchasesPage(page);
  console.log("URL:", page.url(), "\n");

  const vendorNames = extractVendorChipNames(await snapshotVendorButtons(page));
  console.log(`Found ${vendorNames.length} vendor chips:`);
  vendorNames.forEach((name) => console.log(`  - ${name}`));

  const allVendorData: Record<string, any[]> = {};

  for (const vendorName of vendorNames) {
    console.log(`\n=== ${vendorName} ===`);
    await clickVendorChip(page, vendorName);
    await page.waitForTimeout(PAGE_SETTLE_MS);

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

    allVendorData[vendorName] = items as any[];

    for (const item of items as any[]) {
      console.log(`  [${item.urgency || "?"}] ${item.sku} - ${item.description}`);
      console.log(
        `    Purchase By: ${item.purchaseAgainBy} | Reorder Qty: ${item.recommendedReorderQty} | Lead: ${item.supplierLeadTime}`,
      );
      console.log(
        `    Remaining: ${item.remaining} | Days Left: ${item.daysBuildsLeft} | Velocity: ${item.dailyVelocity}`,
      );
    }
  }

  const outputPath = path.join(process.cwd(), "purchases-data.json");
  fs.writeFileSync(outputPath, JSON.stringify(allVendorData, null, 2));
  console.log(`Saved to ${outputPath}`);

  await browser.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  scrapePurchases().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
