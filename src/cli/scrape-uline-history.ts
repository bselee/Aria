/**
 * @file    scrape-uline-history.ts
 * @purpose Scrape ULINE's "Purchased Products" page to build a purchase history profile.
 *          Extracts every item ever ordered, with dates, quantities, prices, and categories.
 *          Cross-references with Finale SKUs and outputs a JSON + console summary.
 *          Used for: identifying heavy-hitters, ordering cadence, and auto-reorder planning.
 * @author  Will / Antigravity
 * @created 2026-03-16
 * @updated 2026-03-16
 * @deps    playwright, dotenv
 *
 * Usage:
 *   node --import tsx src/cli/scrape-uline-history.ts              # Full scrape
 *   node --import tsx src/cli/scrape-uline-history.ts --analyze    # Analyze cached data only
 *
 * PREREQ: Close Chrome before running (Playwright needs exclusive profile access).
 *         User must have logged into uline.com in their regular Chrome browser.
 *
 * DECISION(2026-03-16): ULINE's "Purchased Products" tab shows ALL historical purchases
 * grouped by order, with model #, description, category, qty, and ext. price.
 * This is richer than Finale's PO data because it includes ULINE's internal categorization
 * and exact pricing at time of purchase (before any reconciliation adjustments).
 *
 * The "Company Orders" radio button shows ALL orders placed by the account,
 * while "My Orders" shows only the logged-in user's orders.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { chromium, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const PURCHASED_PRODUCTS_URL = 'https://www.uline.com/MyAccount/OrderHistory?tab=purchasedproducts';
const SANDBOX_DIR = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');
const JSON_PATH = path.join(SANDBOX_DIR, 'uline-purchase-history.json');
const CHROME_PROFILE = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');

// ── SKU Mapping (from reconcile-uline.ts) ─────────────────────────────────────

const ULINE_TO_FINALE: Record<string, string> = {
    'S-15837B': 'FJG101',
    'S-13505B': 'FJG102',
    'S-13506B': 'FJG103',
    'S-10748B': 'FJG104',
    'S-12229': '10113',
    'S-4551': 'ULS455',
    'H-1621': 'Ho-1621',
};

function toFinaleId(ulineSku: string): string {
    return ULINE_TO_FINALE[ulineSku] || ulineSku;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PurchasedItem {
    orderDate: string;
    orderNumber: string;
    ulineModel: string;
    finaleSku: string;
    category: string;
    description: string;
    quantity: number;
    extPrice: number;
    unitPrice: number;  // calculated: extPrice / quantity
}

interface ProductProfile {
    ulineModel: string;
    finaleSku: string;
    category: string;
    description: string;
    totalOrders: number;
    totalQuantity: number;
    totalSpend: number;
    avgQuantityPerOrder: number;
    avgUnitPrice: number;
    lastOrderDate: string;
    firstOrderDate: string;
    orderFrequencyDays: number | null;  // avg days between orders
    orders: Array<{ date: string; orderNumber: string; quantity: number; unitPrice: number }>;
}

// ── Parse CLI Args ────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    return {
        analyzeOnly: args.includes('--analyze'),
    };
}

// ── Phase 1: Scrape Purchased Products ────────────────────────────────────────

async function scrapePurchasedProducts(): Promise<PurchasedItem[]> {
    console.log('\n📋 Phase 1: Scraping ULINE Purchased Products');
    console.log('   ⚠️  Chrome must be closed for this step\n');

    if (!fs.existsSync(SANDBOX_DIR)) fs.mkdirSync(SANDBOX_DIR, { recursive: true });

    const context = await chromium.launchPersistentContext(
        path.join(CHROME_PROFILE, 'Default'),
        {
            headless: false,
            channel: 'chrome',
            acceptDownloads: true,
            viewport: { width: 1400, height: 900 },
            args: ['--disable-blink-features=AutomationControlled'],
        }
    );

    const page = context.pages()[0] || await context.newPage();
    const items: PurchasedItem[] = [];

    try {
        await page.goto(PURCHASED_PRODUCTS_URL, { waitUntil: 'load', timeout: 30_000 });

        // Handle login if needed
        const landed = await Promise.race([
            page.waitForSelector('text=Purchased Products', { timeout: 15_000 }).then(() => 'ready' as const),
            page.waitForSelector('#txtEmail', { timeout: 15_000 }).then(() => 'login' as const),
        ]).catch(() => 'unknown' as const);

        if (landed === 'login') {
            console.log('   🔐 Login required — filling credentials...');
            await page.fill('#txtEmail', process.env.ULINE_EMAIL || '');
            await page.fill('#txtPassword', process.env.ULINE_PASSWORD || '');
            await page.click('#btnSignIn');
            console.log('   ⏳ Waiting for login (solve CAPTCHA if needed)...');
            await page.waitForSelector('text=Purchased Products', { timeout: 120_000 });
        }

        // Make sure "Company Orders" is selected (not "My Orders")
        const companyRadio = await page.$('input[value="CompanyOrders"], #CompanyOrders, input[type="radio"]:first-of-type');
        if (companyRadio) {
            await companyRadio.click();
            await page.waitForTimeout(2_000);
        }

        // Click "Purchased Products" tab if not already active
        const ppTab = await page.$('text=Purchased Products');
        if (ppTab) {
            await ppTab.click();
            await page.waitForTimeout(2_000);
        }

        console.log('   ✅ Purchased Products page loaded\n');

        // Scrape the table — ULINE renders this as a standard HTML table
        // Structure from screenshot:
        //   Date | Order # | Category | Model # | Description | Qty | Ext. Price | Select
        let pageNum = 1;
        let hasMore = true;

        while (hasMore) {
            console.log(`   📄 Scraping page ${pageNum}...`);

            const pageItems = await page.evaluate(() => {
                const rows: Array<{
                    orderDate: string;
                    orderNumber: string;
                    category: string;
                    ulineModel: string;
                    description: string;
                    quantity: number;
                    extPrice: number;
                }> = [];

                // Find the data table — look for rows with order data
                const allRows = document.querySelectorAll('table tr, .dataRow, tr[class*="row"]');
                let currentDate = '';
                let currentOrder = '';

                allRows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 6) return;

                    // Extract cell values
                    const cellTexts = Array.from(cells).map(c => c.textContent?.trim() || '');

                    // Date column — may be in first cell or span multiple rows
                    const dateMatch = cellTexts[0].match(/\d{2}\/\d{2}\/\d{4}/);
                    if (dateMatch) currentDate = dateMatch[0];

                    // Order number — second cell, usually a link
                    const orderLink = cells[1]?.querySelector('a');
                    const orderText = orderLink?.textContent?.trim() || cellTexts[1];
                    if (/^\d{8,}$/.test(orderText)) currentOrder = orderText;

                    // Model # — look for ULINE model pattern (S-####, H-####, etc.)
                    let modelNum = '';
                    let modelIdx = -1;
                    for (let i = 2; i < cellTexts.length; i++) {
                        if (/^[A-Z]-\d+[A-Z]*$/i.test(cellTexts[i])) {
                            modelNum = cellTexts[i];
                            modelIdx = i;
                            break;
                        }
                    }

                    if (!modelNum) return; // Not a product row

                    // Category is typically before model #
                    const category = modelIdx > 2 ? cellTexts[2] : '';

                    // Description is typically after model #
                    const description = modelIdx + 1 < cellTexts.length ? cellTexts[modelIdx + 1] : '';

                    // Quantity — look for a numeric cell after description
                    let qty = 0;
                    let extPrice = 0;
                    for (let i = modelIdx + 2; i < cellTexts.length; i++) {
                        const numVal = cellTexts[i].replace(/[$,]/g, '');
                        const parsed = parseFloat(numVal);
                        if (!isNaN(parsed) && parsed > 0) {
                            if (qty === 0 && parsed < 100000 && !cellTexts[i].includes('$')) {
                                qty = parsed;
                            } else if (cellTexts[i].includes('$') || (qty > 0 && extPrice === 0)) {
                                extPrice = parsed;
                            }
                        }
                    }

                    if (modelNum && (qty > 0 || extPrice > 0)) {
                        rows.push({
                            orderDate: currentDate,
                            orderNumber: currentOrder,
                            category,
                            ulineModel: modelNum,
                            description,
                            quantity: qty || 1,
                            extPrice,
                        });
                    }
                });

                return rows;
            });

            for (const item of pageItems) {
                items.push({
                    ...item,
                    finaleSku: '', // Will be set below
                    unitPrice: item.quantity > 0 ? item.extPrice / item.quantity : 0,
                });
            }

            console.log(`     Found ${pageItems.length} items (total: ${items.length})`);

            // Check for next page
            // DECISION(2026-03-16): ULINE uses standard pagination or "load more".
            // Look for a "Next" link/button or page numbers.
            const nextBtn = await page.$('a:has-text("Next"), button:has-text("Next"), .pagination a.next, a[rel="next"]');
            if (nextBtn) {
                await nextBtn.click();
                await page.waitForTimeout(2_000);
                pageNum++;
            } else {
                // Try scrolling to load more items
                const scrollBefore = items.length;
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(2_000);

                // If no new items loaded after scroll, we're done
                if (items.length === scrollBefore) {
                    hasMore = false;
                }
            }

            // Safety: don't scrape more than 50 pages
            if (pageNum > 50) {
                console.log('   ⚠️  Hit 50-page limit, stopping');
                hasMore = false;
            }
        }

        // Apply SKU mapping
        for (const item of items) {
            item.finaleSku = toFinaleId(item.ulineModel);
        }

        fs.writeFileSync(JSON_PATH, JSON.stringify(items, null, 2));
        console.log(`\n   ✅ Saved ${items.length} items → ${JSON_PATH}`);

    } finally {
        await context.close();
    }

    return items;
}

// ── Phase 2: Analyze Purchase History ─────────────────────────────────────────

function analyzePurchaseHistory(items: PurchasedItem[]): ProductProfile[] {
    console.log('\n📊 Phase 2: Analyzing Purchase History\n');

    // Group by model number
    const byModel = new Map<string, PurchasedItem[]>();
    for (const item of items) {
        const key = item.ulineModel;
        if (!byModel.has(key)) byModel.set(key, []);
        byModel.get(key)!.push(item);
    }

    const profiles: ProductProfile[] = [];

    for (const [model, modelItems] of byModel.entries()) {
        // Sort by date
        modelItems.sort((a, b) => {
            const da = new Date(a.orderDate).getTime() || 0;
            const db = new Date(b.orderDate).getTime() || 0;
            return da - db;
        });

        const totalQty = modelItems.reduce((s, i) => s + i.quantity, 0);
        const totalSpend = modelItems.reduce((s, i) => s + i.extPrice, 0);
        const totalOrders = modelItems.length;

        // Order frequency — avg days between orders
        let orderFrequencyDays: number | null = null;
        if (totalOrders >= 2) {
            const dates = modelItems
                .map(i => new Date(i.orderDate).getTime())
                .filter(d => d > 0)
                .sort((a, b) => a - b);

            if (dates.length >= 2) {
                const gaps: number[] = [];
                for (let i = 1; i < dates.length; i++) {
                    gaps.push(Math.round((dates[i] - dates[i - 1]) / 86_400_000));
                }
                orderFrequencyDays = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
            }
        }

        profiles.push({
            ulineModel: model,
            finaleSku: modelItems[0].finaleSku,
            category: modelItems[0].category,
            description: modelItems[0].description,
            totalOrders,
            totalQuantity: totalQty,
            totalSpend,
            avgQuantityPerOrder: Math.round(totalQty / totalOrders),
            avgUnitPrice: totalQty > 0 ? totalSpend / totalQty : 0,
            lastOrderDate: modelItems[modelItems.length - 1].orderDate,
            firstOrderDate: modelItems[0].orderDate,
            orderFrequencyDays,
            orders: modelItems.map(i => ({
                date: i.orderDate,
                orderNumber: i.orderNumber,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
            })),
        });
    }

    // Sort by total spend descending (heavy hitters first)
    profiles.sort((a, b) => b.totalSpend - a.totalSpend);

    return profiles;
}

function printAnalysis(profiles: ProductProfile[]) {
    // ── Heavy Hitters (Top 15 by total spend) ──
    console.log('   🏆 HEAVY HITTERS — Top 15 Items by Total Spend');
    console.log('   ┌──────────────┬──────────────┬────────┬──────────┬──────────┬──────────┬──────────────┐');
    console.log('   │ ULINE Model  │ Finale SKU   │ Orders │ Total Qty│ Total $  │ Avg $/ea │ Freq (days)  │');
    console.log('   ├──────────────┼──────────────┼────────┼──────────┼──────────┼──────────┼──────────────┤');

    for (const p of profiles.slice(0, 15)) {
        const freq = p.orderFrequencyDays ? `${p.orderFrequencyDays}d` : '-';
        const crossRef = p.ulineModel !== p.finaleSku ? ' *' : '  ';
        console.log(
            `   │ ${p.ulineModel.padEnd(12)}│ ${(p.finaleSku + crossRef).padEnd(12)}│ ${String(p.totalOrders).padStart(6)} │ ${String(p.totalQuantity).padStart(8)} │ $${p.totalSpend.toFixed(0).padStart(7)} │ $${p.avgUnitPrice.toFixed(2).padStart(7)} │ ${freq.padStart(12)} │`
        );
    }
    console.log('   └──────────────┴──────────────┴────────┴──────────┴──────────┴──────────┴──────────────┘\n');

    // ── Category Breakdown ──
    const byCategory = new Map<string, { count: number; spend: number; items: number }>();
    for (const p of profiles) {
        const cat = p.category || 'Uncategorized';
        const existing = byCategory.get(cat) || { count: 0, spend: 0, items: 0 };
        existing.count += p.totalOrders;
        existing.spend += p.totalSpend;
        existing.items++;
        byCategory.set(cat, existing);
    }

    const categories = Array.from(byCategory.entries())
        .sort((a, b) => b[1].spend - a[1].spend);

    console.log('   📦 CATEGORY BREAKDOWN');
    console.log('   ┌──────────────────────────────┬────────┬──────────┬────────┐');
    console.log('   │ Category                     │ SKUs   │ Total $  │ Orders │');
    console.log('   ├──────────────────────────────┼────────┼──────────┼────────┤');
    for (const [cat, data] of categories.slice(0, 10)) {
        console.log(
            `   │ ${cat.substring(0, 28).padEnd(28)}│ ${String(data.items).padStart(6)} │ $${data.spend.toFixed(0).padStart(7)} │ ${String(data.count).padStart(6)} │`
        );
    }
    console.log('   └──────────────────────────────┴────────┴──────────┴────────┘\n');

    // ── Recurring Items (ordered 3+ times) ──
    const recurring = profiles.filter(p => p.totalOrders >= 3 && p.orderFrequencyDays !== null);
    recurring.sort((a, b) => (a.orderFrequencyDays || 999) - (b.orderFrequencyDays || 999));

    console.log('   🔄 RECURRING ITEMS — Ordered 3+ Times (sorted by frequency)');
    console.log('   ┌──────────────┬────────────────────────────────┬────────┬──────────┬──────────┐');
    console.log('   │ Model #      │ Description                    │ Orders │ Every Nd │ Last     │');
    console.log('   ├──────────────┼────────────────────────────────┼────────┼──────────┼──────────┤');
    for (const p of recurring.slice(0, 20)) {
        console.log(
            `   │ ${p.ulineModel.padEnd(12)}│ ${p.description.substring(0, 30).padEnd(30)}│ ${String(p.totalOrders).padStart(6)} │ ${String(p.orderFrequencyDays || '-').padStart(6)}d │ ${p.lastOrderDate.padEnd(8)} │`
        );
    }
    console.log('   └──────────────┴────────────────────────────────┴────────┴──────────┴──────────┘\n');

    // ── Overdue for Reorder ──
    const now = new Date();
    const overdue = recurring.filter(p => {
        if (!p.orderFrequencyDays || !p.lastOrderDate) return false;
        const lastOrder = new Date(p.lastOrderDate);
        if (isNaN(lastOrder.getTime())) return false;
        const daysSince = Math.round((now.getTime() - lastOrder.getTime()) / 86_400_000);
        return daysSince > p.orderFrequencyDays * 1.2; // 20% overdue threshold
    });

    if (overdue.length > 0) {
        console.log('   ⚠️  POTENTIALLY OVERDUE FOR REORDER');
        console.log('   ┌──────────────┬────────────────────────────────┬──────────┬──────────┬──────────┐');
        console.log('   │ Model #      │ Description                    │ Usual Nd │ Days Ago │ Avg Qty  │');
        console.log('   ├──────────────┼────────────────────────────────┼──────────┼──────────┼──────────┤');
        for (const p of overdue) {
            const daysSince = Math.round((now.getTime() - new Date(p.lastOrderDate).getTime()) / 86_400_000);
            console.log(
                `   │ ${p.ulineModel.padEnd(12)}│ ${p.description.substring(0, 30).padEnd(30)}│ ${String(p.orderFrequencyDays || '-').padStart(6)}d │ ${String(daysSince).padStart(6)}d │ ${String(p.avgQuantityPerOrder).padStart(8)} │`
            );
        }
        console.log('   └──────────────┴────────────────────────────────┴──────────┴──────────┴──────────┘\n');
    }

    // Summary stats
    const totalSpend = profiles.reduce((s, p) => s + p.totalSpend, 0);
    const totalOrders = new Set(profiles.flatMap(p => p.orders.map(o => o.orderNumber))).size;

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║     ULINE Purchase History Summary               ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║   Unique SKUs:          ${String(profiles.length).padEnd(24)}║`);
    console.log(`║   Total orders:         ${String(totalOrders).padEnd(24)}║`);
    console.log(`║   Total spend:          $${totalSpend.toFixed(0).padEnd(23)}║`);
    console.log(`║   Recurring SKUs (3+):  ${String(recurring.length).padEnd(24)}║`);
    console.log(`║   Overdue for reorder:  ${String(overdue.length).padEnd(24)}║`);
    console.log('╚══════════════════════════════════════════════════╝');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs();

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   ULINE Purchase History Analyzer                ║');
    console.log('╚══════════════════════════════════════════════════╝');

    let items: PurchasedItem[];

    if (args.analyzeOnly && fs.existsSync(JSON_PATH)) {
        items = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
        console.log(`\n📋 Using cached data: ${items.length} items from ${JSON_PATH}`);
    } else if (args.analyzeOnly) {
        console.error('❌ --analyze specified but no cached data found. Run without --analyze first.');
        process.exit(1);
    } else {
        items = await scrapePurchasedProducts();
    }

    if (items.length === 0) {
        console.log('\n   ❌ No purchase history found.');
        return;
    }

    const profiles = analyzePurchaseHistory(items);
    printAnalysis(profiles);

    // Save profiles
    const profilePath = path.join(SANDBOX_DIR, 'uline-product-profiles.json');
    fs.writeFileSync(profilePath, JSON.stringify(profiles, null, 2));
    console.log(`\n📄 Product profiles saved → ${profilePath}`);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
