/**
 * @file    reconcile-uline.ts
 * @purpose Single-command ULINE invoice reconciliation pipeline.
 *          Scrapes invoice details, maps SKUs, updates pricing & freight on Finale POs.
 * @author  Will / Antigravity
 * @created 2026-03-16
 * @updated 2026-03-16
 * @deps    playwright, dotenv, finale/client
 *
 * Usage:
 *   node --import tsx src/cli/reconcile-uline.ts                # Full pipeline (scrape + reconcile 2026)
 *   node --import tsx src/cli/reconcile-uline.ts --scrape-only  # Just scrape, don't update Finale
 *   node --import tsx src/cli/reconcile-uline.ts --update-only  # Use existing JSON, skip scrape
 *   node --import tsx src/cli/reconcile-uline.ts --po 124426    # Single PO
 *   node --import tsx src/cli/reconcile-uline.ts --year 2025    # Different year filter
 *   node --import tsx src/cli/reconcile-uline.ts --dry-run      # Show diffs without saving
 *
 * PREREQ: Close Chrome before running (Playwright needs exclusive profile access).
 *         User must have logged into uline.com in their regular Chrome browser.
 *
 * DECISION(2026-03-16): Consolidated from 6 separate tmp/ scripts into one CLI tool.
 * Prior scripts: scrape-uline-details.ts, build-sku-mapping.ts, update-po-prices.ts,
 * add-freight-reconcile.ts, fix-duplicate-freight.ts, audit-freight.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { chromium, type Page } from 'playwright';
import { FinaleClient } from '../lib/finale/client';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const INVOICES_URL = 'https://www.uline.com/MyAccount/Invoices';
const SANDBOX_DIR = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');
const JSON_PATH = path.join(SANDBOX_DIR, 'uline-invoice-details.json');
const CHROME_PROFILE = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const FREIGHT_PROMO = '/buildasoilorganics/api/productpromo/10007';
const TAX_PROMO = '/buildasoilorganics/api/productpromo/10008';

// ── SKU Mapping ───────────────────────────────────────────────────────────────

// DECISION(2026-03-16): ULINE uses their catalog numbers, Finale uses BuildASoil's
// internal SKUs. These 7 are the only cross-references. All others match directly.
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

interface InvoiceLineItem {
    itemNumber: string;
    description: string;
    qtyOrdered: number;
    unitMeasure: string;
    unitPrice: number;
    extendedPrice: number;
    qtyShipped: number;
    qtyBackOrdered: number;
}

interface UlineInvoice {
    invoiceNumber: string;
    orderNumber: string;
    poNumber: string;
    invoiceDate: string;
    dueDate: string;
    dateShipped: string;
    shipVia: string;
    terms: string;
    subtotal: number;
    tax: number;
    shipping: number;
    total: number;
    amountDue: number;
    pastDue: string;
    items: InvoiceLineItem[];
}

// ── Parse CLI Args ────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    return {
        scrapeOnly: args.includes('--scrape-only'),
        updateOnly: args.includes('--update-only'),
        dryRun: args.includes('--dry-run'),
        singlePO: args.includes('--po') ? args[args.indexOf('--po') + 1] : null,
        year: args.includes('--year') ? parseInt(args[args.indexOf('--year') + 1]) : new Date().getFullYear(),
    };
}

// ── Phase 1: Scrape ───────────────────────────────────────────────────────────

async function scrapeInvoiceDetail(page: Page): Promise<UlineInvoice | null> {
    try {
        await page.waitForSelector('text=INVOICE DETAIL', { timeout: 15_000 });
        await page.waitForTimeout(1_000);

        return await page.evaluate(() => {
            let invoiceNumber = '';
            document.querySelectorAll('td, th, h2, h3, span, div, b').forEach(el => {
                const t = el.textContent?.trim() || '';
                const m = t.match(/INVOICE\s*#\s*(\d+)/i);
                if (m && !invoiceNumber) invoiceNumber = m[1];
            });

            const headerCells: string[] = [];
            document.querySelectorAll('table tr').forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 7) {
                    const first = cells[0]?.textContent?.trim() || '';
                    if (/^\d{7}$/.test(first) && headerCells.length === 0) {
                        cells.forEach(c => headerCells.push(c.textContent?.trim() || ''));
                    }
                }
            });

            let subtotal = 0, tax = 0, shipping = 0, total = 0;
            document.querySelectorAll('td').forEach(td => {
                const t = td.textContent?.trim() || '';
                const next = td.nextElementSibling?.textContent?.trim() || '';
                if (t === 'Subtotal:') subtotal = parseFloat(next.replace(/[$,]/g, '')) || 0;
                if (t === 'Tax:') tax = parseFloat(next.replace(/[$,]/g, '')) || 0;
                if (/Shipping|Handling/i.test(t) && next.startsWith('$')) shipping = parseFloat(next.replace(/[$,]/g, '')) || 0;
                if (t === 'Total:') total = parseFloat(next.replace(/[$,]/g, '')) || 0;
            });

            const items: InvoiceLineItem[] = [];
            let itemTable: HTMLTableElement | null = null;
            document.querySelectorAll('table').forEach(table => {
                table.querySelectorAll('th, td.dRTitle').forEach(th => {
                    if (/Item\s*#/i.test(th.textContent || '') && !itemTable) {
                        itemTable = table as HTMLTableElement;
                    }
                });
            });

            if (itemTable) {
                (itemTable as HTMLTableElement).querySelectorAll('tr').forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 6) {
                        const num = cells[0]?.textContent?.trim() || '';
                        if (!num || /Item\s*#/i.test(num) || !/[A-Z0-9]/i.test(num)) return;
                        items.push({
                            itemNumber: num,
                            description: cells[1]?.textContent?.trim() || '',
                            qtyOrdered: parseInt(cells[2]?.textContent?.trim() || '0') || 0,
                            unitMeasure: cells[3]?.textContent?.trim() || '',
                            unitPrice: parseFloat((cells[4]?.textContent?.trim() || '0').replace(/[$,]/g, '')) || 0,
                            extendedPrice: parseFloat((cells[5]?.textContent?.trim() || '0').replace(/[$,]/g, '')) || 0,
                            qtyShipped: parseInt(cells[6]?.textContent?.trim() || '0') || 0,
                            qtyBackOrdered: parseInt(cells[7]?.textContent?.trim() || '0') || 0,
                        });
                    }
                });
            }

            return {
                invoiceNumber,
                orderNumber: headerCells[1] || '',
                poNumber: headerCells[2] || '',
                invoiceDate: headerCells[7] || '',
                dueDate: headerCells[4] || '',
                dateShipped: headerCells[5] || '',
                shipVia: headerCells[3] || '',
                terms: headerCells[6] || '',
                subtotal, tax, shipping, total,
                amountDue: parseFloat((headerCells[8] || '0').replace(/[$,]/g, '')) || 0,
                pastDue: headerCells[9] || '',
                items,
            };
        });
    } catch {
        return null;
    }
}

async function scrapeAll(): Promise<UlineInvoice[]> {
    console.log('\n📋 Phase 1: Scraping ULINE Invoice Details');
    console.log('   ⚠️  Chrome must be closed for this step\n');

    if (!fs.existsSync(SANDBOX_DIR)) fs.mkdirSync(SANDBOX_DIR, { recursive: true });

    const context = await chromium.launchPersistentContext(
        path.join(CHROME_PROFILE, 'Default'),
        { headless: false, channel: 'chrome', acceptDownloads: true, viewport: { width: 1280, height: 900 }, args: ['--disable-blink-features=AutomationControlled'] }
    );

    const page = context.pages()[0] || await context.newPage();
    const invoices: UlineInvoice[] = [];

    try {
        await page.goto(INVOICES_URL, { waitUntil: 'load', timeout: 30_000 });

        const landed = await Promise.race([
            page.waitForSelector('a[href*="InvoiceDetail"]', { timeout: 30_000 }).then(() => 'grid' as const),
            page.waitForSelector('#txtEmail', { timeout: 30_000 }).then(() => 'login' as const),
        ]).catch(() => 'unknown' as const);

        if (landed === 'login') {
            await page.fill('#txtEmail', process.env.ULINE_EMAIL || '');
            await page.fill('#txtPassword', process.env.ULINE_PASSWORD || '');
            await page.click('#btnSignIn');
            console.log('   🔐 Waiting for login (solve CAPTCHA if needed)...');
            await page.waitForSelector('a[href*="InvoiceDetail"]', { timeout: 120_000 });
        }

        if (landed === 'unknown') throw new Error('Could not detect invoice table or login');

        await page.waitForTimeout(2_000);

        const links = await page.evaluate(() => {
            const out: Array<{ href: string; text: string }> = [];
            document.querySelectorAll('a[href*="InvoiceDetail"]').forEach(a => {
                out.push({ href: (a as HTMLAnchorElement).href, text: a.textContent?.trim() || '' });
            });
            return out;
        });

        console.log(`   Found ${links.length} invoices\n`);

        for (let i = 0; i < links.length; i++) {
            process.stdout.write(`   [${i + 1}/${links.length}] ${links[i].text}...`);
            await page.goto(links[i].href, { waitUntil: 'load', timeout: 30_000 });
            await page.waitForTimeout(1_000);

            const detail = await scrapeInvoiceDetail(page);
            if (detail) {
                invoices.push(detail);
                const itemCount = detail.items.filter(it => it.unitPrice > 0).length;
                process.stdout.write(` PO#${detail.poNumber} | ${itemCount} items | $${detail.total}\n`);
            } else {
                process.stdout.write(` ⚠️ parse failed\n`);
            }
            await page.waitForTimeout(500);
        }

        fs.writeFileSync(JSON_PATH, JSON.stringify(invoices, null, 2));
        console.log(`\n   ✅ Saved ${invoices.length} invoices → ${JSON_PATH}`);
    } finally {
        await context.close();
    }

    return invoices;
}

// ── Phase 2: Reconcile ────────────────────────────────────────────────────────

interface ReconcileResult {
    po: string;
    priceChanges: number;
    freightAdded: number;
    taxAdded: number;
    status: string;
    errors: string[];
}

async function reconcilePO(
    finale: FinaleClient,
    post: Function,
    poId: string,
    invoices: UlineInvoice[],
    dryRun: boolean,
): Promise<ReconcileResult> {
    const result: ReconcileResult = { po: poId, priceChanges: 0, freightAdded: 0, taxAdded: 0, status: '', errors: [] };

    // Merge ULINE items across all invoices for this PO
    // DECISION(2026-03-16): Must track qty alongside price for UOM conversion.
    // ULINE sells by case/box, Finale tracks individual units.
    // Example: S-1665 poly bags — ULINE sells 1 box ($103), Finale has 500 bags ($0.206 each)
    const ulineItemMap: Record<string, { unitPrice: number; ulineSku: string; qty: number }> = {};
    let totalFreight = 0;
    let totalTax = 0;
    let ulineSubtotal = 0;
    const invNums: string[] = [];

    for (const inv of invoices) {
        invNums.push(inv.invoiceNumber);
        totalFreight += inv.shipping;
        totalTax += inv.tax;
        ulineSubtotal += inv.subtotal;
        for (const item of inv.items) {
            if (item.unitPrice <= 0) continue;
            const fId = toFinaleId(item.itemNumber);
            // If same SKU appears on multiple invoices, sum the qty
            if (ulineItemMap[fId]) {
                ulineItemMap[fId].qty += item.qtyOrdered;
            } else {
                ulineItemMap[fId] = { unitPrice: item.unitPrice, ulineSku: item.itemNumber, qty: item.qtyOrdered };
            }
        }
    }

    try {
        const po = await finale.getOrderDetails(poId);
        const origStatus = po.statusId;
        result.status = origStatus;

        if (!dryRun && po.actionUrlEdit && (origStatus === 'ORDER_LOCKED' || origStatus === 'ORDER_COMPLETED')) {
            await post(po.actionUrlEdit, {});
        }

        const unlocked = dryRun ? po : await finale.getOrderDetails(poId);

        // Update prices — UOM-AWARE
        for (const item of unlocked.orderItemList || []) {
            const fId = item.productUrl?.split('/').pop() || '';
            const uItem = ulineItemMap[fId];
            if (!uItem) continue;

            // DECISION(2026-03-16): Detect UOM conversion by comparing quantities.
            // If Finale qty > ULINE qty, Finale tracks individual units within a case/box.
            // The correct Finale unit price = ULINE price / (finaleQty / ulineQty)
            let correctPrice = uItem.unitPrice;
            const finaleQty = item.quantity;
            const ulineQty = uItem.qty;

            if (ulineQty > 0 && finaleQty !== ulineQty) {
                const factor = finaleQty / ulineQty;
                correctPrice = uItem.unitPrice / factor;
                if (Math.abs(item.unitPrice - correctPrice) > 0.001) {
                    console.log(`     ${fId}: $${item.unitPrice.toFixed(4)} → $${correctPrice.toFixed(4)} (ULINE $${uItem.unitPrice} ÷ ${factor} UOM factor)`);
                    if (!dryRun) item.unitPrice = correctPrice;
                    result.priceChanges++;
                }
            } else if (Math.abs(item.unitPrice - correctPrice) > 0.001) {
                console.log(`     ${fId}: $${item.unitPrice} → $${correctPrice}`);
                if (!dryRun) item.unitPrice = correctPrice;
                result.priceChanges++;
            }
        }

        // Sanity check: verify Finale subtotal matches ULINE subtotal
        const finaleSubtotal = (unlocked.orderItemList || []).reduce((s: number, i: any) => {
            const fId = i.productUrl?.split('/').pop() || '';
            const uItem = ulineItemMap[fId];
            if (!uItem) return s + i.quantity * i.unitPrice;
            // Use the price we're about to set
            const finaleQty = i.quantity;
            const ulineQty = uItem.qty;
            const price = (ulineQty > 0 && finaleQty !== ulineQty)
                ? uItem.unitPrice / (finaleQty / ulineQty)
                : uItem.unitPrice;
            return s + finaleQty * price;
        }, 0);

        if (Math.abs(finaleSubtotal - ulineSubtotal) > 10) {
            console.log(`     ⚠️  SUBTOTAL MISMATCH: Finale=$${finaleSubtotal.toFixed(2)} vs ULINE=$${ulineSubtotal.toFixed(2)} — SKIPPING`);
            result.errors.push(`Subtotal mismatch: Finale=$${finaleSubtotal.toFixed(2)} vs ULINE=$${ulineSubtotal.toFixed(2)}`);
            // Re-commit without changes
            if (!dryRun && (origStatus === 'ORDER_LOCKED' || origStatus === 'ORDER_COMPLETED')) {
                const after = await finale.getOrderDetails(poId);
                if (after.actionUrlComplete) await post(after.actionUrlComplete, {});
            }
            return result;
        }

        // Check freight — avoid duplicates
        const existingAdj = unlocked.orderAdjustmentList || [];
        const existingFreight = existingAdj
            .filter((a: any) => a.productPromoUrl === FREIGHT_PROMO)
            .reduce((s: number, a: any) => s + a.amount, 0);

        if (totalFreight > 0 && Math.abs(existingFreight - totalFreight) > 0.01) {
            // Only add if significantly different
            const label = `Freight - ULINE Inv ${invNums.join('+')}`;
            const alreadyLabeled = existingAdj.some((a: any) => a.description?.includes('ULINE Inv'));
            if (!alreadyLabeled) {
                console.log(`     + Freight: $${totalFreight} (${label})`);
                if (!dryRun) {
                    existingAdj.push({ amount: totalFreight, description: label, productPromoUrl: FREIGHT_PROMO });
                }
                result.freightAdded = totalFreight;
            }
        }

        // Save
        if (!dryRun && (result.priceChanges > 0 || result.freightAdded > 0)) {
            await post(`/buildasoilorganics/api/order/${encodeURIComponent(poId)}`, unlocked);
        }

        // Re-commit
        if (!dryRun && (origStatus === 'ORDER_LOCKED' || origStatus === 'ORDER_COMPLETED')) {
            const after = await finale.getOrderDetails(poId);
            if (after.actionUrlComplete) await post(after.actionUrlComplete, {});
            result.status = (await finale.getOrderDetails(poId)).statusId;
        }
    } catch (err: any) {
        result.errors.push(err.message);
    }

    return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs();
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   ULINE → Finale Invoice Reconciliation Tool    ║');
    console.log('╚══════════════════════════════════════════════════╝');

    if (args.dryRun) console.log('   🔍 DRY RUN — no changes will be saved\n');

    // Phase 1: Get invoice data
    let invoices: UlineInvoice[];

    if (args.updateOnly && fs.existsSync(JSON_PATH)) {
        invoices = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
        console.log(`\n📋 Using cached data: ${invoices.length} invoices from ${JSON_PATH}`);
    } else if (args.updateOnly) {
        console.error('❌ --update-only specified but no cached data found. Run without --update-only first.');
        process.exit(1);
    } else {
        invoices = await scrapeAll();
    }

    if (args.scrapeOnly) {
        console.log('\n✅ Scrape complete. Use --update-only to reconcile without re-scraping.');
        return;
    }

    // Phase 2: Group invoices by PO and reconcile
    console.log('\n💰 Phase 2: Reconciling Prices & Freight\n');

    const byPO: Record<string, UlineInvoice[]> = {};
    for (const inv of invoices) {
        if (!/^\d{5,6}$/.test(inv.poNumber)) continue;
        // Year filter
        const parts = inv.invoiceDate?.split('/');
        if (parts?.length >= 3) {
            const yr = parseInt(parts[2]);
            if (args.year && yr !== args.year) continue;
        }
        if (args.singlePO && inv.poNumber !== args.singlePO) continue;
        if (!byPO[inv.poNumber]) byPO[inv.poNumber] = [];
        byPO[inv.poNumber].push(inv);
    }

    const poIds = Object.keys(byPO).sort();
    console.log(`   ${poIds.length} POs to process (year=${args.year}${args.singlePO ? `, PO=${args.singlePO}` : ''})\n`);

    const finale = new FinaleClient();
    const post = (finale as any).post.bind(finale);
    const results: ReconcileResult[] = [];

    for (let i = 0; i < poIds.length; i++) {
        const poId = poIds[i];
        console.log(`   [${i + 1}/${poIds.length}] PO ${poId}...`);
        const result = await reconcilePO(finale, post, poId, byPO[poId], args.dryRun);
        results.push(result);

        const icon = result.errors.length > 0 ? '❌' : result.priceChanges > 0 || result.freightAdded > 0 ? '✅' : '⏭️';
        console.log(`   ${icon} ${result.priceChanges} prices, $${result.freightAdded} freight | ${result.status}\n`);
    }

    // Summary
    const totalPrices = results.reduce((s, r) => s + r.priceChanges, 0);
    const totalFreight = results.filter(r => r.freightAdded > 0).length;
    const errors = results.filter(r => r.errors.length > 0);

    console.log('╔══════════════════════════════════════════════════╗');
    console.log(`║   DONE${args.dryRun ? ' (DRY RUN)' : ''}                                     ║`);
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║   POs processed:    ${String(poIds.length).padEnd(28)}║`);
    console.log(`║   Prices updated:   ${String(totalPrices).padEnd(28)}║`);
    console.log(`║   Freight added:    ${String(totalFreight).padEnd(28)}║`);
    console.log(`║   Errors:           ${String(errors.length).padEnd(28)}║`);
    console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
