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
 *   node --import tsx src/cli/reconcile-uline.ts --dry-run      # Dry run (default — no writes)
 *   node --import tsx src/cli/reconcile-uline.ts --live         # Live run (writes to Finale)
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
import { upsertVendorInvoice, lookupVendorInvoices } from '../lib/storage/vendor-invoices';
import { BrowserManager } from '../lib/scraping/browser-manager';
import { ReconciliationRun } from '../lib/reconciliation/run-tracker';
import { sendReconciliationSummary } from '../lib/reconciliation/notifier';
import { assertPriceReasonable, assertSubtotalMatch, InvariantViolationError } from '@/lib/reconciliation/invariants';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── ChangeSet Types ────────────────────────────────────────────────────────────

interface ChangeSetItem {
    type: 'price_change' | 'freight_add' | 'po_update';
    poId: string;
    sku?: string;
    oldPrice?: number;
    newPrice?: number;
    freightCents?: number;
    invoiceNumber: string;
}
type ChangeSet = ChangeSetItem[];

// ── Config ────────────────────────────────────────────────────────────────────

const INVOICES_URL = 'https://www.uline.com/MyAccount/Invoices';
const SANDBOX_DIR = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');
const JSON_PATH = path.join(SANDBOX_DIR, 'uline-invoice-details.json');
// Local file (dotfile) for storing ULINE login session cookies.
// Placed in project root to avoid cluttering user documents.
const UL_SESSION_FILE = '.uline-session.json';
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

function cookiesFromFile(filePath: string): any[] {
    if (!fs.existsSync(filePath)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(data)) {
            console.warn(`Cookie file ${filePath} does not contain an array, got ${typeof data}`);
            return [];
        }
        return data;
    } catch (error) {
        console.warn(`Failed to parse cookie file ${filePath}: ${error}`);
        return [];
    }
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
        dryRun: !args.includes('--live'),
        live: args.includes('--live'),
        forceSupplier: args.includes('--force-supplier'),
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

async function scrapeAll(run?: ReconciliationRun | null): Promise<UlineInvoice[]> {
    console.log('\n📋 Phase 1: Scraping ULINE Invoice Details');
    console.log('   ⚠️  Chrome must be closed for this step\n');

    if (!fs.existsSync(SANDBOX_DIR)) fs.mkdirSync(SANDBOX_DIR, { recursive: true });

    const manager = BrowserManager.getInstance();
    // headless: false - use visible browser for manual session setup and bypass bot detection
    // via PersistentSession. Switched from persistent context to avoid multiple process conflicts.
    const page = await manager.launchBrowser({ headless: false, cookiesPath: UL_SESSION_FILE });
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
            // Save cookies after successful login
            await manager.saveCookies();
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
                run?.recordInvoiceFound();
                const itemCount = detail.items.filter(it => it.unitPrice > 0).length;
                process.stdout.write(` PO#${detail.poNumber} | ${itemCount} items | $${detail.total}\n`);
            } else {
                process.stdout.write(` ⚠️ parse failed\n`);
            }
            await page.waitForTimeout(500);
        }

        fs.writeFileSync(JSON_PATH, JSON.stringify(invoices, null, 2));
        console.log(`\n   ✅ Saved ${invoices.length} invoices → ${JSON_PATH}`);

        // Archive each invoice into the unified vendor_invoices table
        console.log('\n   📦 Archiving to vendor_invoices...');
        let archived = 0;
        for (const inv of invoices) {
            try {
                await upsertVendorInvoice({
                    vendor_name: 'ULINE',
                    invoice_number: inv.invoiceNumber,
                    invoice_date: inv.invoiceDate
                        ? inv.invoiceDate.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2')
                        : null,
                    due_date: inv.dueDate
                        ? inv.dueDate.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2')
                        : null,
                    po_number: inv.poNumber || null,
                    subtotal: inv.subtotal,
                    freight: inv.shipping,
                    tax: inv.tax,
                    total: inv.total,
                    status: 'received',
                    source: 'portal_scrape',
                    source_ref: `uline-scrape-${new Date().toISOString().slice(0, 10)}`,
                    line_items: inv.items.filter(i => i.unitPrice > 0).map(i => ({
                        sku: toFinaleId(i.itemNumber),
                        description: i.description,
                        qty: i.qtyOrdered,
                        unit_price: i.unitPrice,
                        ext_price: i.extendedPrice,
                    })),
                    raw_data: inv as unknown as Record<string, unknown>,
                });
                archived++;
                run?.recordInvoiceProcessed();
            } catch (err: any) {
                console.warn(`   ⚠️ Archive failed for ${inv.invoiceNumber}: ${err.message}`);
            }
        }
        console.log(`   ✅ Archived ${archived}/${invoices.length} invoices`);
    } finally {
        await manager.destroy();
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
    get: Function,
    post: Function,
    poId: string,
    invoices: UlineInvoice[],
    dryRun: boolean,
    forceSupplier: boolean,
    run: ReconciliationRun | undefined,
    changes: ChangeSet,
    poFreightMap: Record<string, { invNums: string[]; totalFreight: number; totalTax: number }>,
    poPriceChanges: Record<string, { sku: string; oldPrice: number; newPrice: number; ulineSku: string }[]>,
): Promise<ReconcileResult> {
    const result: ReconcileResult = { po: poId, priceChanges: 0, freightAdded: 0, taxAdded: 0, status: '', errors: [] };

    const ulineItemMap: Record<string, { unitPrice: number; ulineSku: string; qty: number }> = {};
    let totalFreight = 0;
    let totalTax = 0;
    let ulineSubtotal = 0;
    const invNums: string[] = [];

    for (const inv of invoices) {
        const existing = await lookupVendorInvoices({ vendor: 'ULINE', invoice_number: inv.invoiceNumber });
        if (existing.length > 0 && existing[0].status !== 'void') {
            run?.recordWarning(`Invoice ${inv.invoiceNumber} already reconciled, skipping`, { invoiceNumber: inv.invoiceNumber });
            continue;
        }
        invNums.push(inv.invoiceNumber);
        totalFreight += inv.shipping;
        totalTax += inv.tax;
        ulineSubtotal += inv.subtotal;
        for (const item of inv.items) {
            if (item.unitPrice <= 0) continue;
            const fId = toFinaleId(item.itemNumber);
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

        const unlocked = dryRun ? po : await finale.getOrderDetails(poId);

        // Phase 1: collect price changes without modifying PO
        for (const item of unlocked.orderItemList || []) {
            const fId = item.productUrl?.split('/').pop() || '';
            const uItem = ulineItemMap[fId];
            if (!uItem) continue;

            let correctPrice = uItem.unitPrice;
            const finaleQty = item.quantity;
            const ulineQty = uItem.qty;

            let priceChanged = false;

            if (ulineQty > 0 && finaleQty !== ulineQty) {
                const factor = finaleQty / ulineQty;
                correctPrice = uItem.unitPrice / factor;
                if (Math.abs(item.unitPrice - correctPrice) > 0.001) {
                    console.log(`     ${fId}: $${item.unitPrice.toFixed(4)} → $${correctPrice.toFixed(4)} (ULINE $${uItem.unitPrice} ÷ ${factor} UOM factor)`);

                    // Phase 1: collect change
                    changes.push({
                        type: 'price_change',
                        poId,
                        sku: fId,
                        oldPrice: item.unitPrice,
                        newPrice: correctPrice,
                        invoiceNumber: invNums.join('+'),
                    });

                    if (!poPriceChanges[poId]) poPriceChanges[poId] = [];
                    poPriceChanges[poId].push({ sku: fId, oldPrice: item.unitPrice, newPrice: correctPrice, ulineSku: uItem.ulineSku });

                    // Assert price reasonable
                    try {
                        assertPriceReasonable({
                            sku: fId,
                            oldPrice: item.unitPrice,
                            newPrice: correctPrice,
                            context: { vendor: 'ULINE', invoiceNumber: invNums.join('+') },
                        });
                    } catch (err) {
                        result.errors.push((err as Error).message);
                        console.error(`     ⚠️ Invariant failed: ${(err as Error).message}`);
                    }

                    priceChanged = true;
                    result.priceChanges++;
                }
            } else if (Math.abs(item.unitPrice - correctPrice) > 0.001) {
                console.log(`     ${fId}: $${item.unitPrice} → $${correctPrice}`);

                changes.push({
                    type: 'price_change',
                    poId,
                    sku: fId,
                    oldPrice: item.unitPrice,
                    newPrice: correctPrice,
                    invoiceNumber: invNums.join('+'),
                });

                if (!poPriceChanges[poId]) poPriceChanges[poId] = [];
                poPriceChanges[poId].push({ sku: fId, oldPrice: item.unitPrice, newPrice: correctPrice, ulineSku: uItem.ulineSku });

                try {
                    assertPriceReasonable({
                        sku: fId,
                        oldPrice: item.unitPrice,
                        newPrice: correctPrice,
                        context: { vendor: 'ULINE', invoiceNumber: invNums.join('+') },
                    });
                } catch (err) {
                    result.errors.push((err as Error).message);
                    console.error(`     ⚠️ Invariant failed: ${(err as Error).message}`);
                }

                priceChanged = true;
                result.priceChanges++;
            }

            if (priceChanged && (forceSupplier || dryRun)) {
                try {
                    const productUrl = `/buildasoilorganics/api/product/${fId}`;
                    const prodDetails = await get(productUrl);

                    const vendorPartyUrl = unlocked.originUrl || unlocked.partyUrl;

                    let supplierUpdated = false;
                    if (prodDetails.supplierList && prodDetails.supplierList.length > 0) {
                        for (const sup of prodDetails.supplierList) {
                            if (vendorPartyUrl && sup.supplierPartyUrl === vendorPartyUrl) {
                                sup.price = correctPrice;
                                supplierUpdated = true;
                                break;
                            }
                        }
                        if (!supplierUpdated) {
                            for (const sup of prodDetails.supplierList) {
                                if (sup.supplierPrefOrderId?.includes('MAIN')) {
                                    sup.price = correctPrice;
                                    supplierUpdated = true;
                                    break;
                                }
                            }
                        }
                        if (!supplierUpdated) {
                            prodDetails.supplierList[0].price = correctPrice;
                            supplierUpdated = true;
                        }
                    }

                    if (supplierUpdated && !dryRun) {
                        await post(productUrl, prodDetails);
                        console.log(`       [Global supplier price updated to $${correctPrice.toFixed(4)}]`);
                    }
                } catch (e: any) {
                    console.error(`       [⚠️ Failed to update global supplier price for ${fId}: ${e.message}]`);
                }
            }
        }

        // Phase 1: collect freight
        const existingAdj = unlocked.orderAdjustmentList || [];
        const existingFreight = existingAdj
            .filter((a: any) => a.productPromoUrl === FREIGHT_PROMO)
            .reduce((s: number, a: any) => s + a.amount, 0);

        if (totalFreight > 0 && Math.abs(existingFreight - totalFreight) > 0.01) {
            const label = `Freight - ULINE Inv ${invNums.join('+')}`;
            const alreadyLabeled = existingAdj.some((a: any) => a.description?.includes('ULINE Inv'));
            if (!alreadyLabeled) {
                console.log(`     + Freight: $${totalFreight} (${label})`);

                changes.push({
                    type: 'freight_add',
                    poId,
                    freightCents: Math.round(totalFreight * 100),
                    invoiceNumber: invNums.join('+'),
                });

                if (!poFreightMap[poId]) poFreightMap[poId] = { invNums, totalFreight, totalTax };

                result.freightAdded = totalFreight;
            }
        }
    } catch (err: any) {
        result.errors.push(err.message);
        run?.recordError(`reconcilePO(${poId})`, err instanceof Error ? err : new Error(String(err)));
    }

    return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs();
    let run: ReconciliationRun | null = null;
    const changes: ChangeSet = [];
    const poFreightMap: Record<string, { invNums: string[]; totalFreight: number; totalTax: number }> = {};
    const poPriceChanges: Record<string, { sku: string; oldPrice: number; newPrice: number; ulineSku: string }[]> = {};

    try {
        console.log('╔══════════════════════════════════════════════════╗');
        console.log('║   ULINE → Finale Invoice Reconciliation Tool    ║');
        console.log('╚══════════════════════════════════════════════════╝');

        if (args.dryRun) console.log('   🔍 DRY RUN — no changes will be saved\n');

        run = await ReconciliationRun.start('ULINE', args.live ? 'live' : 'dry-run', {
            scrapeOnly: args.scrapeOnly,
            updateOnly: args.updateOnly,
            singlePO: args.singlePO,
            year: args.year,
        });

        // Phase 1: Get invoice data
        let invoices: UlineInvoice[];

        if (args.updateOnly && fs.existsSync(JSON_PATH)) {
            invoices = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
            console.log(`\n📋 Using cached data: ${invoices.length} invoices from ${JSON_PATH}`);
        } else if (args.updateOnly) {
            console.error('❌ --update-only specified but no cached data found. Run without --update-only first.');
            process.exit(1);
        } else {
            invoices = await scrapeAll(run);
        }

        if (args.scrapeOnly) {
            console.log('\n✅ Scrape complete. Use --update-only to reconcile without re-scraping.');
            await run.complete('ULINE scrape complete.');
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
        const get = (finale as any).get.bind(finale);
        const post = (finale as any).post.bind(finale);
        const results: ReconcileResult[] = [];

        for (let i = 0; i < poIds.length; i++) {
            const poId = poIds[i];
            console.log(`   [${i + 1}/${poIds.length}] PO ${poId}...`);
            const result = await reconcilePO(finale, get, post, poId, byPO[poId], args.dryRun, args.forceSupplier, run, changes, poFreightMap, poPriceChanges);
            results.push(result);

            if (result.priceChanges > 0 || result.freightAdded > 0) {
                run.recordPoUpdated(poId);
            }

            const icon = result.errors.length > 0 ? '❌' : result.priceChanges > 0 || result.freightAdded > 0 ? '✅' : '⏭️';
            console.log(`   ${icon} ${result.priceChanges} prices, $${result.freightAdded} freight | ${result.status}\n`);
        }

        // --- Phase 2: Apply collected changes (live mode only) ---
        try {
            if (run.isLive() && changes.length > 0) {
                console.log(`\n${'='.repeat(60)}`);
                console.log(`PHASE 2: Applying ${changes.length} change(s) to ${Object.keys(poPriceChanges).length} PO(s)`);
                console.log(`${'='.repeat(60)}\n`);

                // Group changes by PO
                const changesByPo: Record<string, ChangeSetItem[]> = {};
                for (const change of changes) {
                    if (!changesByPo[change.poId]) changesByPo[change.poId] = [];
                    changesByPo[change.poId].push(change);
                }

                for (const [poId, poChanges] of Object.entries(changesByPo)) {
                    try {
                        const po = await finale.getOrderDetails(poId);
                        const origStatus = po.statusId;

                        // Unlock if needed
                        if (po.actionUrlEdit && (origStatus === 'ORDER_LOCKED' || origStatus === 'ORDER_COMPLETED')) {
                            await post(po.actionUrlEdit, {});
                        }

                        const unlocked = await finale.getOrderDetails(poId);

                        // Apply price changes
                        for (const change of poChanges) {
                            if (change.type === 'price_change' && change.sku) {
                                const item = unlocked.orderItemList?.find(
                                    (i: any) => i.productUrl?.endsWith(`/${change.sku}`)
                                );
                                if (item) {
                                    item.unitPrice = change.newPrice;
                                    run.recordPriceChange(change.sku, change.oldPrice!, change.newPrice!);
                                    console.log(`   ${change.sku}: $${change.oldPrice} → $${change.newPrice}`);
                                }
                            }
                        }

                        // Apply freight
                        const freightInfo = poFreightMap[poId];
                        if (freightInfo) {
                            const existingAdj = unlocked.orderAdjustmentList || [];
                            existingAdj.push({
                                amount: freightInfo.totalFreight,
                                description: `Freight - ULINE Inv ${freightInfo.invNums.join('+')}`,
                                productPromoUrl: FREIGHT_PROMO,
                            });
                            unlocked.orderAdjustmentList = existingAdj;
                            run.recordFreight(Math.round(freightInfo.totalFreight * 100));
                        }

                        // Save
                        await post(`/buildasoilorganics/api/order/${encodeURIComponent(poId)}`, unlocked);

                        // Re-commit if needed
                        if (origStatus === 'ORDER_LOCKED' || origStatus === 'ORDER_COMPLETED') {
                            const after = await finale.getOrderDetails(poId);
                            if (after.actionUrlComplete) await post(after.actionUrlComplete, {});
                        }

                        run.recordPoUpdated(poId);
                        console.log(`   ✅ PO ${poId}: applied ${poChanges.length} change(s)`);
                    } catch (err: any) {
                        run.recordError(`Phase 2 apply failed for PO ${poId}`, err instanceof Error ? err : new Error(err.message));
                        console.log(`   ❌ PO ${poId} Phase 2 failed: ${err.message}`);
                    }
                }
            }
        } catch (err) {
            if (err instanceof InvariantViolationError) {
                run.recordError('Invariant violation during ULINE reconciliation', err);
                await run.fail('ULINE reconciliation aborted: invariant violation', err);
                await sendReconciliationSummary(run);
                throw err;
            }
            throw err;
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

        await run.complete('ULINE reconciliation complete.');
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (run) {
            await run.fail('ULINE reconciliation failed', error);
        } else {
            console.error('[ULINE] Fatal error before run could be created:', error.message);
        }
        throw err;
    } finally {
        if (run) await sendReconciliationSummary(run);
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
