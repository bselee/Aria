import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  snapshotVendorButtons,
  extractVendorChipNames,
  clickVendorChip,
  waitForVendorChips,
  waitForVendorPanelReady,
} from "@/lib/purchasing/purchases-scraper-nav";
import {
  parsePurchasesGuidanceItem,
  type PurchasesGuidanceRawItem,
} from "@/lib/purchasing/purchases-guidance-parser";

const PURCHASES_URL = "https://basauto.vercel.app/purchases";
const CDP_ENDPOINT = "http://127.0.0.1:9222";

async function ensurePurchasesPage(page: any) {
  if (!page.url().includes("/purchases")) {
    await page.goto(PURCHASES_URL, { waitUntil: "networkidle", timeout: 60000 });
  }

  await waitForVendorChips(page);
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
    const headingText = await page
      .locator("h1, h2, h3, h4, h5")
      .first()
      .textContent()
      .then((text) => (text ? text.trim() : ""));

    await clickVendorChip(page, vendorName);
    await waitForVendorPanelReady(page, headingText || null);

    const rawItems = await page.evaluate(`
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

          var metricGroups = [];
          var candidates = card.querySelectorAll('div, section, article, li');
          for (var m = 0; m < candidates.length; m++) {
            var candidate = candidates[m];
            if (!candidate.children || candidate.children.length < 2) continue;

            var texts = [];
            for (var n = 0; n < candidate.children.length; n++) {
              var childText = (candidate.children[n].textContent || '').trim().replace(/\\s+/g, ' ');
              if (!childText || texts.indexOf(childText) !== -1) continue;
              if (childText.length > 120) continue;
              texts.push(childText);
            }

            if (texts.length >= 2) {
              metricGroups.push(texts);
            }
          }

          results.push({
            sku: sku,
            description: description,
            urgency: urgency,
            metricGroups: metricGroups,
          });
        }
        return results;
      })()
    `);
    const items = (rawItems as PurchasesGuidanceRawItem[]).map((rawItem) => parsePurchasesGuidanceItem(rawItem));

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
