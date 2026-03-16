/**
 * @file    scrape-uline-details.ts
 * @purpose Scrape ULINE invoice detail pages to extract line-item data
 *          (SKUs, quantities, prices) for PO reconciliation with Finale.
 *          Uses REAL Chrome profile (persistent context) to avoid bot detection.
 * @author  Will / Antigravity
 * @created 2026-03-13
 * @updated 2026-03-13
 * @deps    playwright, dotenv, fs, path, os
 *
 * Usage:
 *   node --import tsx src/cli/scrape-uline-details.ts
 *
 * DECISION(2026-03-13): ULINE's injected-cookie approach authenticates but the
 * Kendo grid doesn't render (JS bot detection). Using persistent Chrome context
 * with the real user profile bypasses this entirely since it's the actual browser.
 *
 * IMPORTANT: Close your real Chrome browser before running this, since Playwright
 * needs exclusive access to the profile.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { chromium, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const INVOICES_URL = 'https://www.uline.com/MyAccount/Invoices';
const SANDBOX_DIR = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');
const OUTPUT_FILE = path.join(SANDBOX_DIR, 'uline-invoice-details.json');
const CHROME_PROFILE = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');

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

interface InvoiceDetail {
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

// ── Scrape Functions ──────────────────────────────────────────────────────────

/**
 * Scrape the current InvoiceDetail page for line items and header info.
 */
async function scrapeInvoiceDetail(page: Page): Promise<InvoiceDetail | null> {
    try {
        // Wait for the detail page content
        await page.waitForSelector('text=INVOICE DETAIL', { timeout: 15_000 });
        await page.waitForTimeout(1_000);

        const detail = await page.evaluate(() => {
            // Find invoice number from heading
            let invoiceNumber = '';
            document.querySelectorAll('td, th, h2, h3, span, div, b').forEach(el => {
                const t = el.textContent?.trim() || '';
                const m = t.match(/INVOICE\s*#\s*(\d+)/i);
                if (m && !invoiceNumber) invoiceNumber = m[1];
            });

            // Parse the order info row — find the row with 7-digit customer number
            const headerCells: string[] = [];
            document.querySelectorAll('table tr').forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 7) {
                    const firstCell = cells[0]?.textContent?.trim() || '';
                    if (/^\d{7}$/.test(firstCell) && headerCells.length === 0) {
                        cells.forEach(c => headerCells.push(c.textContent?.trim() || ''));
                    }
                }
            });

            // Format: [CustNum, OrderNum, PO#, ShipVia, DueDate, DateShipped, Terms, InvDate, AmtDue, PastDue]
            const orderNumber = headerCells[1] || '';
            const poNumber = headerCells[2] || '';
            const shipVia = headerCells[3] || '';
            const dueDate = headerCells[4] || '';
            const dateShipped = headerCells[5] || '';
            const terms = headerCells[6] || '';
            const invoiceDate = headerCells[7] || '';
            const amountDueStr = headerCells[8] || '0';
            const pastDue = headerCells[9] || '';

            // Parse summary values
            let subtotal = 0, tax = 0, shipping = 0, total = 0;
            document.querySelectorAll('td').forEach(td => {
                const t = td.textContent?.trim() || '';
                const nextTd = td.nextElementSibling;
                const next = nextTd?.textContent?.trim() || '';
                if (t === 'Subtotal:') subtotal = parseFloat(next.replace(/[$,]/g, '')) || 0;
                if (t === 'Tax:') tax = parseFloat(next.replace(/[$,]/g, '')) || 0;
                if (/Shipping|Handling/i.test(t) && next.startsWith('$')) shipping = parseFloat(next.replace(/[$,]/g, '')) || 0;
                if (t === 'Total:') total = parseFloat(next.replace(/[$,]/g, '')) || 0;
            });

            // Parse line items table — look for header with "Item #"
            const items: Array<{
                itemNumber: string; description: string; qtyOrdered: number;
                unitMeasure: string; unitPrice: number; extendedPrice: number;
                qtyShipped: number; qtyBackOrdered: number;
            }> = [];

            let itemTable: HTMLTableElement | null = null;
            document.querySelectorAll('table').forEach(table => {
                const ths = table.querySelectorAll('th, td.dRTitle');
                ths.forEach(th => {
                    if (/Item\s*#/i.test(th.textContent || '') && !itemTable) {
                        itemTable = table as HTMLTableElement;
                    }
                });
            });

            if (itemTable) {
                (itemTable as HTMLTableElement).querySelectorAll('tr').forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 6) {
                        const itemNum = cells[0]?.textContent?.trim() || '';
                        // Skip headers, empty rows
                        if (!itemNum || /Item\s*#/i.test(itemNum) || /^\s*$/.test(itemNum)) return;
                        // Skip if it looks like a non-item row (no alpha chars in item#)
                        if (!/[A-Z0-9]/i.test(itemNum)) return;

                        items.push({
                            itemNumber: itemNum,
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
                invoiceNumber, orderNumber, poNumber, invoiceDate,
                dueDate, dateShipped, shipVia, terms,
                subtotal, tax, shipping, total,
                amountDue: parseFloat(amountDueStr.replace(/[$,]/g, '')) || 0,
                pastDue, items,
            };
        });

        if (!detail?.invoiceNumber) return null;
        return detail;
    } catch (err: any) {
        console.log(`  ⚠️ Error scraping detail: ${err.message}`);
        return null;
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
    if (!fs.existsSync(SANDBOX_DIR)) fs.mkdirSync(SANDBOX_DIR, { recursive: true });

    console.log('[uline-detail] ⚠️  CLOSE Chrome before running! Playwright needs exclusive profile access.');
    console.log('[uline-detail] Launching with real Chrome profile...');

    // Use persistent context with real Chrome profile
    const context = await chromium.launchPersistentContext(
        path.join(CHROME_PROFILE, 'Default'),
        {
            headless: false,
            channel: 'chrome',
            acceptDownloads: true,
            viewport: { width: 1280, height: 900 },
            args: ['--disable-blink-features=AutomationControlled'],
        }
    );

    const page = context.pages()[0] || await context.newPage();

    try {
        // Navigate to invoices
        console.log('[uline-detail] Navigating to invoices...');
        await page.goto(INVOICES_URL, { waitUntil: 'load', timeout: 30_000 });

        // Check if we land on the invoice table or login
        const landed = await Promise.race([
            page.waitForSelector('a[href*="InvoiceDetail"]', { timeout: 30_000 }).then(() => 'grid' as const),
            page.waitForSelector('#txtEmail', { timeout: 30_000 }).then(() => 'login' as const),
        ]).catch(() => 'unknown' as const);

        if (landed === 'login') {
            console.log('[uline-detail] Need to login — filling credentials...');
            await page.fill('#txtEmail', process.env.ULINE_EMAIL || '');
            await page.fill('#txtPassword', process.env.ULINE_PASSWORD || '');
            await page.click('#btnSignIn');
            console.log('[uline-detail] 🔐 Waiting for login (solve CAPTCHA if needed)...');
            await page.waitForSelector('a[href*="InvoiceDetail"]', { timeout: 120_000 });
        }

        if (landed === 'unknown') {
            throw new Error('Could not detect invoice table or login page');
        }

        console.log('[uline-detail] ✔️ Invoice grid loaded');
        await page.waitForTimeout(2_000);

        // Collect invoice links from the table
        const invoiceLinks = await page.evaluate(() => {
            const links: Array<{ href: string; text: string }> = [];
            document.querySelectorAll('a[href*="InvoiceDetail"]').forEach(a => {
                const el = a as HTMLAnchorElement;
                links.push({ href: el.href, text: el.textContent?.trim() || '' });
            });
            return links;
        });

        console.log(`[uline-detail] Found ${invoiceLinks.length} invoices`);

        const allInvoices: InvoiceDetail[] = [];

        for (let i = 0; i < invoiceLinks.length; i++) {
            const link = invoiceLinks[i];
            console.log(`\n[${i + 1}/${invoiceLinks.length}] Invoice ${link.text}...`);

            await page.goto(link.href, { waitUntil: 'load', timeout: 30_000 });
            await page.waitForTimeout(1_500);

            const detail = await scrapeInvoiceDetail(page);
            if (detail) {
                allInvoices.push(detail);
                console.log(`  PO# ${detail.poNumber} | ${detail.items.length} items | $${detail.total}`);
                for (const item of detail.items) {
                    console.log(`    ${item.itemNumber}: ${item.qtyOrdered}x $${item.unitPrice} = $${item.extendedPrice}`);
                }
            } else {
                console.log(`  ⚠️ Failed to parse`);
            }

            // Polite delay
            await page.waitForTimeout(800);
        }

        // Save
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allInvoices, null, 2));
        console.log(`\n[uline-detail] ✅ Saved ${allInvoices.length} invoices → ${OUTPUT_FILE}`);

        // Summary
        const totalItems = allInvoices.reduce((s, inv) => s + inv.items.length, 0);
        const uniquePOs = [...new Set(allInvoices.map(i => i.poNumber))];
        console.log(`\n=== SUMMARY ===`);
        console.log(`Invoices: ${allInvoices.length}`);
        console.log(`Line items: ${totalItems}`);
        console.log(`POs: ${uniquePOs.join(', ')}`);

    } catch (err: any) {
        console.error(`[uline-detail] ❌ Error: ${err.message}`);
        const sp = path.join(SANDBOX_DIR, 'uline-detail-error.png');
        await page.screenshot({ path: sp, fullPage: true }).catch(() => {});
        console.error(`[uline-detail] Screenshot: ${sp}`);
    } finally {
        await context.close();
    }
}

run().catch(err => {
    console.error('[uline-detail] Fatal:', err);
    process.exit(1);
});
