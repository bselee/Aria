import { type Page } from "playwright";
import path from "path";

import { BrowserManager } from "@/lib/scraping/browser-manager";

const BASE_URL = "https://basauto.vercel.app";
const PURCHASES_URL = `${BASE_URL}/purchases`;
const SESSION_FILE = path.resolve(process.cwd(), ".basauto-session.json");

export interface BasautoScrapedPurchases {
    purchases: Record<string, any[]>;
    requests: any[];
    rawDump?: string;
}

async function ensureSignedIn(page: Page): Promise<void> {
    await page.goto(PURCHASES_URL, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(3_000);

    if (!page.url().includes("/auth/signin") && page.url().includes("/purchases")) {
        return;
    }

    throw new Error("Not signed in to basauto.vercel.app. Refresh .basauto-session.json before retrying.");
}

export async function scrapePurchasesTab(page: Page): Promise<Record<string, any[]>> {
    try {
        await page.waitForSelector("button", { state: "visible", timeout: 15_000 });
    } catch {
        // hydration best-effort
    }
    await page.waitForTimeout(2_000);

    const purchasesTab = page.getByRole("tab", { name: /^Purchases$/ }).first();
    if (await purchasesTab.isVisible().catch(() => false)) {
        await purchasesTab.click().catch(() => {});
        await page.waitForTimeout(1_500);
    }

    const allButtons = await page.locator("button").all();
    const vendorChips: Array<{ el: any; name: string }> = [];

    for (const btn of allButtons) {
        const text = (await btn.textContent())?.trim() || "";
        const isVisible = await btn.isVisible().catch(() => false);
        if (!isVisible) continue;
        if (
            text.match(/^[A-Z][\w\s.,&'()-]+\d+$/i) &&
            !["Purchases", "Overdue", "Purchase Request", "Tutorial"].some(value => text.includes(value))
        ) {
            vendorChips.push({ el: btn, name: text });
        }
    }

    const allVendorData: Record<string, any[]> = {};

    for (const { el, name } of vendorChips) {
        await el.click();
        await page.waitForTimeout(2_500);

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
                recommendedReorderQty: metrics['RECOMMENDED REORDER QUANTITY'] || '',
                remaining: metrics['REMAINING'] || '',
              });
            }
            return results;
          })()
        `);

        allVendorData[name] = items as any[];
    }

    return allVendorData;
}

export async function scrapeRequestsTab(page: Page): Promise<{ requests: any[]; rawDump?: string }> {
    const tabs = await page.locator("button, [role=\"tab\"], a").all();
    let tabEl: any = null;
    for (const tab of tabs) {
        const text = ((await tab.textContent().catch(() => ""))?.trim() || "").toLowerCase();
        const visible = await tab.isVisible().catch(() => false);
        if (!visible) continue;
        if (text === "purchase request form" || text === "purchase requests" || text.startsWith("purchase request")) {
            tabEl = tab;
            break;
        }
    }

    if (!tabEl) {
        return { requests: [] };
    }

    await tabEl.click();
    await page.waitForTimeout(2_000);

    return page.evaluate(`
      (function() {
        var panel = document.querySelector('[role="tabpanel"]') || document.querySelector('main') || document.body;
        var rows = panel.querySelectorAll('tr');
        var requests = [];
        if (rows.length > 1) {
          var headers = [];
          rows[0].querySelectorAll('th, td').forEach(function(c) {
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
        var clone = panel.cloneNode(true);
        clone.querySelectorAll('script, style').forEach(function(n) { n.remove(); });
        var rawDump = (clone.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 4000);
        return { requests: requests, rawDump: rawDump };
      })()
    `) as Promise<{ requests: any[]; rawDump?: string }>;
}

export async function scrapeBasautoPurchasingData(options: { includeRequests?: boolean } = {}): Promise<BasautoScrapedPurchases> {
    const includeRequests = options.includeRequests ?? true;
    const manager = BrowserManager.getInstance();
    const sessionValid = await manager.checkSession(PURCHASES_URL, SESSION_FILE);
    if (!sessionValid) {
        throw new Error("basauto session expired");
    }

    const page = await manager.launchBrowser({
        headless: true,
        cookiesPath: SESSION_FILE,
    });

    try {
        await ensureSignedIn(page);
        const purchases = await scrapePurchasesTab(page);
        let requests: any[] = [];
        let rawDump: string | undefined;

        if (includeRequests) {
            const requestResult = await scrapeRequestsTab(page);
            requests = requestResult.requests;
            rawDump = requestResult.rawDump;
        }

        return { purchases, requests, rawDump };
    } finally {
        await manager.destroy();
    }
}
