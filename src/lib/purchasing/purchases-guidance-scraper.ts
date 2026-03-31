import { chromium } from "playwright";
import {
  clickVendorChip,
  extractVendorChipNames,
  snapshotVendorButtons,
  waitForVendorChips,
  waitForVendorPanelReady,
} from "./purchases-scraper-nav";
import {
  parsePurchasesGuidanceItem,
  type PurchasesGuidanceParsedItem,
  type PurchasesGuidanceRawItem,
} from "./purchases-guidance-parser";

const DEFAULT_PURCHASES_URL = "https://basauto.vercel.app/purchases";
const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

export type PurchasesGuidanceDataset = Record<string, PurchasesGuidanceParsedItem[]>;

export interface ScrapePurchasesGuidanceOptions {
  purchasesUrl?: string;
  cdpEndpoint?: string;
}

async function ensurePurchasesPage(page: any, purchasesUrl: string) {
  if (!page.url().includes("/purchases")) {
    await page.goto(purchasesUrl, { waitUntil: "networkidle", timeout: 60_000 });
  }

  await waitForVendorChips(page);
}

export async function scrapePurchasesGuidanceViaCDP(
  options: ScrapePurchasesGuidanceOptions = {},
): Promise<PurchasesGuidanceDataset> {
  const purchasesUrl = options.purchasesUrl ?? DEFAULT_PURCHASES_URL;
  const cdpEndpoint = options.cdpEndpoint ?? process.env.PURCHASES_GUIDANCE_CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT;

  const browser = await chromium.connectOverCDP(cdpEndpoint);

  try {
    const context = browser.contexts()[0];
    let page = context.pages().find((candidate: any) => candidate.url().includes("basauto"));
    if (!page) page = await context.newPage();

    await ensurePurchasesPage(page, purchasesUrl);

    const vendorNames = extractVendorChipNames(await snapshotVendorButtons(page));
    const dataset: PurchasesGuidanceDataset = {};

    for (const vendorName of vendorNames) {
      const headingText = await page
        .locator("h1, h2, h3, h4, h5")
        .first()
        .textContent()
        .then((text: string | null) => (text ? text.trim() : ""));

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

      dataset[vendorName] = (rawItems as PurchasesGuidanceRawItem[]).map((rawItem) => parsePurchasesGuidanceItem(rawItem));
    }

    return dataset;
  } finally {
    await browser.close();
  }
}
