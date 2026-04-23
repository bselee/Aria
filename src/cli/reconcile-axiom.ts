/**
 * @file    reconcile-axiom.ts
 * @purpose Single-command Axiom Print invoice reconciliation pipeline.
 *          Uses the Axiom REST API at newapi.axiomprint.com to fetch orders,
 *          maps product names to Finale SKUs, updates pricing & freight on Finale POs.
 * @author  Will / Antigravity
 * @created 2026-03-17
 * @updated 2026-03-17
 * @deps    playwright, dotenv, finale/client, storage/vendor-invoices
 *
 * Usage:
 *   node --import tsx src/cli/reconcile-axiom.ts                # Full pipeline (API fetch + reconcile)
 *   node --import tsx src/cli/reconcile-axiom.ts --scrape-only  # Just fetch API data, don't update Finale
 *   node --import tsx src/cli/reconcile-axiom.ts --update-only  # Use existing JSON, skip API fetch
 *   node --import tsx src/cli/reconcile-axiom.ts --discover     # Screenshot + DOM dump for initial mapping
 *   node --import tsx src/cli/reconcile-axiom.ts --po 124500    # Single PO
 *   node --import tsx src/cli/reconcile-axiom.ts --live        # Live update (dry-run is default)
 *
 * PREREQ: Close Chrome before running (Playwright needs exclusive profile access).
 *
 * DECISION(2026-03-17): Modeled after reconcile-uline.ts but adapted for Axiom Print.
 * DECISION(2026-03-17): Discovery run revealed Axiom uses a REST API at
 *   newapi.axiomprint.com/v1/project — returns structured JSON with full invoice data.
 *   We use Playwright ONLY for login/cookie acquisition, then hit the API directly.
 *   This is far more reliable than DOM scraping of the React SPA.
 *
 * Key API Endpoints:
 *   GET /v1/project?projectclientid=32511&page={n}&page_size=10
 *     → estimate_invoiceid, estimate_name, estimate_price, estimate_productid
 *   GET /v1/customer/32511 → customer profile
 *
 * Customer ID: 32511 (BuildASoil / Bill Selee)
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { chromium, type Page, type BrowserContext } from 'playwright';
import { FinaleClient } from '../lib/finale/client';
import { upsertVendorInvoice, lookupVendorInvoices } from '../lib/storage/vendor-invoices';
import { ReconciliationRun } from '../lib/reconciliation/run-tracker';
import { sendReconciliationSummary } from '../lib/reconciliation/notifier';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const ORDER_HISTORY_URL = 'https://axiomprint.com/account/order-history';
const API_BASE = 'https://newapi.axiomprint.com/v1';
const CUSTOMER_ID = 32511;     // BuildASoil / Bill Selee
const SANDBOX_DIR = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');
const PROCESSED_DIR = path.join(SANDBOX_DIR, 'processed');
const JSON_PATH = path.join(PROCESSED_DIR, 'axiom-order-details.json');
const DISCOVER_DIR = path.join(SANDBOX_DIR, 'axiom-discovery');
const CHROME_PROFILE = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const FREIGHT_PROMO = '/buildasoilorganics/api/productpromo/10007';

// ── SKU Mapping ───────────────────────────────────────────────────────────────

// DECISION(2026-03-17): Axiom Print sells stickers & labels. Job names
// on their site use short codes (e.g., "GNS11_12", "OAG207FRBK", "BBL101")
// that map to Finale inventory label SKUs.
//
// Key patterns confirmed by user:
//   - GNS11_12 = front (GNS11) + back (GNS21) of GnarBar-Whole 2lb
//   - FRBK suffix = Front + Back → LABELFR + LABELBK in Finale
//   - Single labels map 1:1 to Finale SKUs
//
// Structure: Each Axiom job name maps to an array of Finale SKUs.
// For front+back pairs, the quantity is split equally between the two.

interface SkuMapping {
    /** Finale product ID(s) */
    skus: string[];
    /** Fraction of total qty each SKU gets (e.g., 0.5 for front/back split) */
    qtyFraction: number;
    /** Human description for logging */
    description?: string;
}

const AXIOM_TO_FINALE: Record<string, SkuMapping> = {
    // ── GNS: GnarBar Labels (front=GNS1x, back=GNS2x) ──────────────
    // GnarBar-Whole 2lb: Front=GNS11, Back=GNS21
    'GNS11_12':          { skus: ['GNS11', 'GNS21'], qtyFraction: 0.5, description: 'GnarBar-Whole 2lb F+B' },
    'GNAR BAR 2lbs':     { skus: ['GNS11', 'GNS21'], qtyFraction: 0.5, description: 'GnarBar-Whole 2lb F+B' },

    // GnarBar-Whole 6lb: Front=GNS12, Back=GNS22
    'GNAR BAR 6 lbs':    { skus: ['GNS12', 'GNS22'], qtyFraction: 0.5, description: 'GnarBar-Whole 6lb F+B' },

    // GnarBar-Milled 2lb: Front=GNS16, Back=GNS06
    'GnarBar062lbs':     { skus: ['GNS16', 'GNS06'], qtyFraction: 0.5, description: 'GnarBar-Milled 2lb F+B' },

    // GnarBar-Milled 6lb: Front=GNS17, Back=GNS07
    'GnarBar07Milled':   { skus: ['GNS17', 'GNS07'], qtyFraction: 0.5, description: 'GnarBar-Milled 6lb F+B' },

    // ── OAG: Organics Alive Labels (LABELFR + LABELBK) ──────────────
    'OAG104FRBK':        { skus: ['OAG104LABELFR', 'OAG104LABELBK'], qtyFraction: 0.5, description: 'FCB Castor Bean 1gal F+B' },
    'OAG207FRBK':        { skus: ['OAG207LABELFR', 'OAG207LABELBK'], qtyFraction: 0.5, description: 'V-N 10-2-2 Veg 25lb F+B' },
    'OAG211FRBK':        { skus: ['OAG211LABELFR', 'OAG211LABELBK'], qtyFraction: 0.5, description: 'V-TR 4-5-5 Trans 25lb F+B' },

    // ── VCal: Organics Alive VCal Labels ─────────────────────────────
    'VCal OA Gallon Labels': { skus: ['OAG110LABELFR', 'OAG110LABELBK'], qtyFraction: 0.5, description: 'VCal 1gal F+B' },
    'VCal OA Pint Label':    { skus: ['OAG109LABELFR', 'OAG109LABELBK'], qtyFraction: 0.5, description: 'VCal 1pint F+B' },

    // ── Single Labels (1:1 mapping) ──────────────────────────────────
    // Note: Some SKUs may need a LABEL suffix or different naming. Run with --dry-run first.
    'BBL101':            { skus: ['BBL101'], qtyFraction: 1.0, description: 'BuildASoil Big Label' },
    'BBL101 124469':     { skus: ['BBL101'], qtyFraction: 1.0, description: 'BuildASoil Big Label (reorder)' },
    'BABL101':           { skus: ['BABL101'], qtyFraction: 1.0, description: 'BuildASoil Big-ish Label' },
    'DOM101':            { skus: ['DOM101'], qtyFraction: 1.0, description: 'Domain product label' },
    'GBB08':             { skus: ['GBB08'], qtyFraction: 1.0, description: 'Gnar Bud Butter v8' },
    'GBB07':             { skus: ['GBB07'], qtyFraction: 1.0, description: 'Gnar Bud Butter v7' },
    'BAF00LABEL':        { skus: ['BAF00LABEL'], qtyFraction: 1.0, description: 'BAF00 product label' },
    'BAF1G':             { skus: ['BAF1G'], qtyFraction: 1.0, description: 'BAF 1gal label' },
    'KGD104':            { skus: ['KGD104'], qtyFraction: 1.0, description: 'KGD product label' },
    'GA105':             { skus: ['GA105'], qtyFraction: 1.0, description: 'GA product label' },
    'PU105L':            { skus: ['PU105L'], qtyFraction: 1.0, description: 'PU product label' },
    'AG111':             { skus: ['AG111'], qtyFraction: 1.0, description: 'AG product label' },
    'FCB1G':             { skus: ['FCB1G'], qtyFraction: 1.0, description: 'FCB 1gal label' },
    'CWP DRINK SOME':    { skus: ['CWP DRINK SOME'], qtyFraction: 1.0, description: 'CWP sticker' },
};

/**
 * Resolve an Axiom job name to one or more Finale SKU mappings.
 * Returns null if no mapping is found.
 */
function toFinaleIds(axiomJobName: string): SkuMapping | null {
    // Try direct match first
    if (AXIOM_TO_FINALE[axiomJobName]) return AXIOM_TO_FINALE[axiomJobName];

    // Try case-insensitive match
    const lower = axiomJobName.toLowerCase().trim();
    for (const [key, val] of Object.entries(AXIOM_TO_FINALE)) {
        if (key.toLowerCase() === lower) return val;
    }

    // Try partial match — e.g., "BBL101 124469" should match "BBL101"
    for (const [key, val] of Object.entries(AXIOM_TO_FINALE)) {
        if (lower.startsWith(key.toLowerCase()) || key.toLowerCase().startsWith(lower)) {
            return val;
        }
    }

    return null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AxiomEstimate {
    estimateId: number;        // e.g. 1160055
    invoiceId: number;         // e.g. 122191 → INV122191
    jobName: string;           // e.g. "GNS11_12"
    productId: number;         // e.g. 335 (Roll Labels)
    productType: string;       // e.g. "Roll Labels"
    price: number;             // e.g. 276.57
    quantity: number;          // e.g. 1000
    size: string;              // e.g. "5.00 x 6.00"
    material: string;          // e.g. "White Matte BOPP"
    turnaround: string;        // e.g. "5 Business Days"
    createdDate: string;       // e.g. "2026-03-16 12:37:15"
    projectName: string;       // e.g. "Bill - 03/16/2026"
    eCode: string;             // e.g. "E1160055"
}

interface AxiomInvoice {
    invoiceNumber: string;     // e.g. "INV122191"
    estimates: AxiomEstimate[];
    subtotal: number;
    shipping: number;
    tax: number;
    total: number;
    orderDate: string;
    status: string;            // PAID, etc.
}

// ── Parse CLI Args ────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    return {
        discover: args.includes('--discover'),
        scrapeOnly: args.includes('--scrape-only'),
        updateOnly: args.includes('--update-only'),
        dryRun: !args.includes('--live'),
        live: args.includes('--live'),
        singlePO: args.includes('--po') ? args[args.indexOf('--po') + 1] : null,
    };
}

// ── Browser Helpers ───────────────────────────────────────────────────────────

/**
 * Launch Playwright with the user's Chrome profile.
 * The persistent context shares cookies/session from their regular Chrome.
 */
async function launchBrowser(): Promise<BrowserContext> {
    console.log('   🚀 Launching browser with Chrome profile...');
    return chromium.launchPersistentContext(
        path.join(CHROME_PROFILE, 'Default'),
        {
            headless: false,
            channel: 'chrome',
            acceptDownloads: true,
            viewport: { width: 1280, height: 900 },
            args: ['--disable-blink-features=AutomationControlled'],
        }
    );
}

/**
 * Handle Axiom Print login.
 * The site is a Next.js SPA where the sidebar/layout renders for any visitor
 * to /account/* pages, but API data (orders, account info) only loads after
 * authentication.
 *
 * DECISION(2026-03-17): The Chrome profile sidebar (Order history, My products
 * links) appears even without auth — it's static page structure. True auth is
 * verified by checking if the order history page actually shows order cards with
 * invoice numbers, or if the "My Orders" header link replaces "Sign in".
 * If the profile is already authenticated from regular Chrome usage, we skip login.
 */
async function ensureLoggedIn(page: Page): Promise<void> {
    await page.goto(ORDER_HISTORY_URL, { waitUntil: 'load', timeout: 45_000 });
    await page.waitForTimeout(5_000);

    if (!fs.existsSync(SANDBOX_DIR)) fs.mkdirSync(SANDBOX_DIR, { recursive: true });

    // Check if we are actually authenticated:
    // When logged in, the header shows "My Orders" instead of "Sign in"
    // AND the order history page shows cards with "INVOICE:" text
    const hasOrders = await page.evaluate(() => {
        const text = document.body.innerText;
        return text.includes('INVOICE:') || text.includes('INV');
    });

    const hasMyOrders = await page.$('text=My Orders');

    if (hasOrders || hasMyOrders) {
        console.log('   ✅ Already logged in via Chrome session');
        return;
    }

    // Not authenticated — perform login
    console.log('   🔐 Not authenticated — attempting login via credentials...');

    const email = process.env.AXIOM_EMAIL;
    const password = process.env.AXIOM_PASSWORD;

    if (!email || !password) {
        throw new Error(
            'Axiom Print login required but AXIOM_EMAIL / AXIOM_PASSWORD not set in .env.local.'
        );
    }

    // Click "Sign in" in the header to trigger the login modal
    try {
        const signInLink = page.locator('text=Sign in').first();
        await signInLink.click({ timeout: 5_000 });
        await page.waitForTimeout(2_000);
    } catch {
        console.log('   ⚠️  Could not click Sign in — trying form directly...');
    }

    // Fill the login form using React-compatible nativeInputValueSetter
    try {
        await page.evaluate(({ email, password }: { email: string; password: string }) => {
            const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
            const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;

            if (!emailInput || !passwordInput) throw new Error('Login inputs not found in DOM');

            const nativeSet = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            )?.set;

            nativeSet?.call(emailInput, email);
            emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            emailInput.dispatchEvent(new Event('change', { bubbles: true }));

            nativeSet?.call(passwordInput, password);
            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
            passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
        }, { email, password });

        await page.waitForTimeout(1_000);

        const submitBtn = page.locator('button:has-text("Sign in")').first();
        await submitBtn.click({ timeout: 5_000 });

        console.log('   ⏳ Waiting for login to complete...');
        await page.waitForTimeout(5_000);

        // Navigate to order history to verify
        await page.goto(ORDER_HISTORY_URL, { waitUntil: 'load', timeout: 30_000 });
        await page.waitForTimeout(5_000);

        // Verify login succeeded
        const loginSuccess = await page.evaluate(() => {
            return document.body.innerText.includes('INVOICE:') || document.body.innerText.includes('INV');
        });

        if (loginSuccess) {
            console.log('   ✅ Login successful — orders visible');
        } else {
            await page.screenshot({ path: path.join(SANDBOX_DIR, 'axiom-login-failed.png') });
            console.log('   ⚠️  Login completed but no orders visible. Screenshot saved.');
        }
    } catch (err: any) {
        await page.screenshot({ path: path.join(SANDBOX_DIR, 'axiom-login-failed.png') });
        throw new Error(`Login failed: ${err.message}. Check axiom-login-failed.png`);
    }
}

/**
 * Extract session cookies from the browser context for use with direct API calls.
 * After login, we grab the cookies and use them in fetch() requests to the API.
 *
 * DECISION(2026-03-17): Instead of scraping DOM elements, we use the REST API
 * at newapi.axiomprint.com. Playwright is only needed for authentication.
 */
async function extractCookies(context: BrowserContext): Promise<string> {
    const cookies = await context.cookies('https://axiomprint.com');
    // Also get cookies from the API domain
    const apiCookies = await context.cookies('https://newapi.axiomprint.com');
    const allCookies = [...cookies, ...apiCookies];

    // Build cookie header string
    const cookieStr = allCookies
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

    console.log(`   🍪 Extracted ${allCookies.length} cookies for API requests`);
    return cookieStr;
}

// ── Phase 0: Discovery (unchanged — for initial structure mapping) ────────────

/**
 * Discovery mode: log in, capture the order history cards, intercept API calls.
 * This mode revealed the REST API endpoints we now use in Phase 1.
 */
async function discover(): Promise<void> {
    console.log('\n🔍 DISCOVERY MODE — Capturing Axiom Print account structure\n');

    if (!fs.existsSync(DISCOVER_DIR)) fs.mkdirSync(DISCOVER_DIR, { recursive: true });

    const context = await launchBrowser();
    const page = context.pages()[0] || await context.newPage();

    // Intercept API requests to find data endpoints
    const apiCalls: Array<{ url: string; method: string; status: number; body: string }> = [];

    page.on('response', async (response) => {
        const url = response.url();
        if ((url.includes('newapi.axiomprint.com') || url.includes('workroomapp.com/api')) &&
            !url.includes('.svg') && !url.includes('.jpg') && !url.includes('.png')) {
            try {
                const body = await response.text();
                apiCalls.push({
                    url,
                    method: response.request().method(),
                    status: response.status(),
                    body: body.slice(0, 10_000),
                });
            } catch { /* ignore binary responses */ }
        }
    });

    try {
        await ensureLoggedIn(page);

        // 1. Order History Page
        console.log('   📋 1/4: Order History page (card list)...');
        try {
            await page.goto(ORDER_HISTORY_URL, { waitUntil: 'load', timeout: 30_000 });
            await page.waitForTimeout(5_000);

            await page.screenshot({ path: path.join(DISCOVER_DIR, '01-order-history.png'), fullPage: true });

            const orderText = await page.evaluate(() => document.body.innerText);
            fs.writeFileSync(path.join(DISCOVER_DIR, '01-order-history-text.txt'), orderText);

            const orderHTML = await page.evaluate(() => document.body.innerHTML);
            fs.writeFileSync(path.join(DISCOVER_DIR, '01-order-history-dom.html'), orderHTML);

            // Parse order cards from the page
            const orderCards = await page.evaluate(() => {
                const r: string[] = [];
                const text = document.body.innerText;

                const invoiceMatches = text.match(/INVOICE:\s*INV\d+/g);
                r.push(`=== INVOICES FOUND (${invoiceMatches?.length || 0}) ===`);
                invoiceMatches?.forEach(inv => r.push(`  ${inv}`));

                const actionLinks = document.querySelectorAll('a, span, button');
                r.push(`\n=== ACTION BUTTONS ===`);
                actionLinks.forEach(el => {
                    const t = el.textContent?.trim() || '';
                    if (/VIEW INVOICE|PRINT|DOWNLOAD|Reorder/i.test(t)) {
                        const tag = el.tagName;
                        const href = (el as HTMLAnchorElement).href || '';
                        const cls = el.className || '';
                        r.push(`  <${tag}> "${t}" href="${href}" class="${cls}"`);
                    }
                });

                r.push(`\n=== PRODUCT INFO ELEMENTS ===`);
                const eCodes = text.match(/E\d{7}/g);
                r.push(`E-codes found: ${eCodes?.join(', ') || 'none'}`);

                const priceMatches = text.match(/TOTAL:\s*\$[\d,.]+/g);
                r.push(`Totals: ${priceMatches?.join(', ') || 'none'}`);

                const inputs = document.querySelectorAll('input, select, .ant-select');
                r.push(`\n=== INPUTS AND SELECTS (${inputs.length}) ===`);
                inputs.forEach(inp => {
                    const ii = inp as HTMLInputElement;
                    r.push(`  <${inp.tagName}> type="${ii.type || ''}" placeholder="${ii.placeholder || ''}" value="${ii.value || ''}" class="${inp.className}"`);
                });

                return r;
            });
            fs.writeFileSync(path.join(DISCOVER_DIR, '02-order-card-analysis.txt'), orderCards.join('\n'));
            console.log('   📄 Order card analysis saved');

        } catch (err: any) {
            console.log(`   ⚠️  Order history analysis failed: ${err.message}`);
        }

        // 2. Click "VIEW INVOICE" on first order
        console.log('   🧾 2/4: Clicking VIEW INVOICE on first order...');
        try {
            const viewInvoiceLink = page.locator('text=VIEW INVOICE').first();
            const count = await viewInvoiceLink.count();
            console.log(`   Found ${count} VIEW INVOICE button(s)`);

            if (count > 0) {
                await viewInvoiceLink.click({ timeout: 10_000 });
                await page.waitForTimeout(5_000);

                await page.screenshot({ path: path.join(DISCOVER_DIR, '06-view-invoice.png'), fullPage: true });

                const invoiceText = await page.evaluate(() => document.body.innerText);
                fs.writeFileSync(path.join(DISCOVER_DIR, '06-view-invoice-text.txt'), invoiceText);

                const invoiceHTML = await page.evaluate(() => document.body.innerHTML);
                fs.writeFileSync(path.join(DISCOVER_DIR, '06-view-invoice-dom.html'), invoiceHTML);

                // Parse invoice detail
                const invoiceAnalysis = await page.evaluate(() => {
                    const r: string[] = [];
                    const text = document.body.innerText;

                    r.push(`=== FULL TEXT (first 3000 chars) ===`);
                    r.push(text.slice(0, 3000));

                    r.push(`\n=== ALL TABLES ===`);
                    const tables = document.querySelectorAll('table');
                    tables.forEach((t, i) => {
                        const rows = t.querySelectorAll('tr');
                        r.push(`Table ${i}: ${rows.length} rows`);
                        rows.forEach((row, ri) => {
                            const cells = Array.from(row.querySelectorAll('th, td'))
                                .map(c => c.textContent?.trim())
                                .join(' | ');
                            r.push(`  Row ${ri}: ${cells}`);
                        });
                    });

                    r.push(`\n=== PRICE ELEMENTS ===`);
                    const prices = text.match(/\$[\d,.]+/g);
                    prices?.forEach(p => r.push(`  ${p}`));

                    return r;
                });
                fs.writeFileSync(path.join(DISCOVER_DIR, '07-invoice-detail-analysis.txt'), invoiceAnalysis.join('\n'));
                console.log('   📄 Invoice detail analysis saved');

                await page.goBack();
                await page.waitForTimeout(3_000);
            }
        } catch (err: any) {
            console.log(`   ⚠️  VIEW INVOICE click failed: ${err.message}`);
        }

        // 3. Try DOWNLOAD on first order
        console.log('   📥 3/4: Trying DOWNLOAD on first order...');
        try {
            await page.goto(ORDER_HISTORY_URL, { waitUntil: 'load', timeout: 30_000 });
            await page.waitForTimeout(5_000);

            const downloadLink = page.locator('text=DOWNLOAD').first();
            const count = await downloadLink.count();
            if (count > 0) {
                const [download] = await Promise.all([
                    page.waitForEvent('download', { timeout: 15_000 }).catch(() => null),
                    downloadLink.click({ timeout: 5_000 }),
                ]);
                if (download) {
                    const savePath = path.join(DISCOVER_DIR, download.suggestedFilename());
                    await download.saveAs(savePath);
                    console.log(`   📄 Downloaded: ${savePath}`);
                } else {
                    await page.waitForTimeout(3_000);
                    const pages = context.pages();
                    if (pages.length > 1) {
                        const newPage = pages[pages.length - 1];
                        await newPage.waitForTimeout(3_000);
                        await newPage.screenshot({ path: path.join(DISCOVER_DIR, '08-download-page.png'), fullPage: true });
                        const dlText = await newPage.evaluate(() => document.body.innerText);
                        fs.writeFileSync(path.join(DISCOVER_DIR, '08-download-text.txt'), dlText);
                        console.log('   📄 Download opened in new tab — captured');
                    }
                }
            }
        } catch (err: any) {
            console.log(`   ⚠️  DOWNLOAD failed: ${err.message}`);
        }

        // 4. Scroll for pagination
        console.log('   📜 4/4: Checking for pagination / more orders...');
        try {
            await page.goto(ORDER_HISTORY_URL, { waitUntil: 'load', timeout: 30_000 });
            await page.waitForTimeout(5_000);

            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(3_000);

            const orderCount = await page.evaluate(() => {
                const text = document.body.innerText;
                const invoices = text.match(/INVOICE:\s*INV\d+/g);
                return invoices?.length || 0;
            });
            console.log(`   📊 Total orders visible: ${orderCount}`);

            const pagination = await page.evaluate(() => {
                const pag = document.querySelectorAll('[class*="pagination"], [class*="Pagination"], .ant-pagination');
                return pag.length;
            });
            console.log(`   📊 Pagination elements: ${pagination}`);

            await page.screenshot({ path: path.join(DISCOVER_DIR, '09-full-scroll.png'), fullPage: true });
        } catch (err: any) {
            console.log(`   ⚠️  Pagination check failed: ${err.message}`);
        }

        // Save API calls log
        fs.writeFileSync(path.join(DISCOVER_DIR, '10-api-calls.json'), JSON.stringify(apiCalls, null, 2));
        console.log(`\n   🌐 ${apiCalls.length} API calls captured`);

        console.log(`\n   ✅ Discovery complete!`);
        console.log(`   📁 Files saved to: ${DISCOVER_DIR}`);
        console.log(`\n   Key files to review:`);
        console.log(`   - 01-order-history.png             (order card list)`);
        console.log(`   - 02-order-card-analysis.txt       (parsed order cards)`);
        console.log(`   - 06-view-invoice.png              (⭐ invoice detail page)`);
        console.log(`   - 07-invoice-detail-analysis.txt   (⭐ invoice data structure)`);
        console.log(`   - 10-api-calls.json                (API endpoints found)\n`);
    } finally {
        await context.close();
    }
}

// ── Phase 1: Fetch via API ────────────────────────────────────────────────────

/**
 * Fetch all order/estimate data from the Axiom REST API.
 * The API returns paginated project data with full estimate details
 * including invoice IDs, prices, product specs, and quantities.
 *
 * DECISION(2026-03-17): The API endpoint was discovered during the --discover
 * run by intercepting network requests. It returns far richer, more reliable
 * data than DOM scraping. We use Playwright only for login, then fetch() with
 * the session cookies.
 */
async function fetchViaAPI(context: BrowserContext): Promise<AxiomInvoice[]> {
    console.log('   🌐 Fetching order data via Axiom REST API...');

    // DECISION(2026-03-17): Use Playwright's context.request (Node-side HTTP)
    // instead of page.evaluate(fetch) which hits CORS restrictions.
    // context.request inherits all cookies from the browser session, so
    // authentication carries over automatically. No CORS issues because
    // this runs in Node.js, not the browser sandbox.

    const allEstimates: AxiomEstimate[] = [];
    let pageNum = 0;
    let hasMore = true;
    const pageSize = 10;

    while (hasMore) {
        console.log(`   📄 Fetching page ${pageNum + 1}...`);

        const url = `${API_BASE}/project?expand=prjestimate,estimateStage,estimateHandle,estimatePrepressOptions&projectclientid=${CUSTOMER_ID}&visibleForClient=true&page=${pageNum}&page_size=${pageSize}&sortEstID=`;

        try {
            const resp = await context.request.get(url, {
                headers: { 'Accept': 'application/json' },
            });

            if (!resp.ok()) {
                console.log(`   ⚠️  API error: ${resp.status()} ${resp.statusText()}`);
                hasMore = false;
                continue;
            }

            // any: raw API response shape from Axiom — deeply nested, untyped
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const json = await resp.json() as any;
            const projects = json.data || [];

            // any: Axiom API project response uses untyped nested objects
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const project of projects as any[]) {
                // any: prjestimate is a dynamically shaped array from the API
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                for (const est of (project.prjestimate || []) as any[]) {
                    // Extract specs from estimateoptions
                    let size = '';
                    let material = '';
                    let turnaround = '';
                    let totalQty = 0;

                    // any: estimateoptions is an untyped API response array
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    for (const opt of (est.estimateoptions || []) as any[]) {
                        if (opt.estimate_option_name === 'Size') {
                            size = opt.selected || '';
                        } else if (opt.estimate_option_name === 'Material') {
                            material = opt.selected || '';
                        } else if (opt.estimate_option_name === 'Turnaround') {
                            turnaround = opt.selected || '';
                        } else if (opt.estimate_option_name === 'Quantity') {
                            const qStr = opt.estimate_option_custom_value || opt.selected || '0';
                            totalQty = parseInt(String(qStr).replace(/,/g, ''), 10) || 0;
                        }
                    }

                    allEstimates.push({
                        estimateId: est.id,
                        invoiceId: est.estimate_invoiceid,
                        jobName: est.estimate_name || '',
                        productId: est.estimate_productid,
                        productType: est.productname?.title || '',
                        price: parseFloat(est.estimate_price) || 0,
                        quantity: totalQty,
                        size,
                        material,
                        turnaround,
                        createdDate: est.created || project.created_at || '',
                        projectName: project.projectname || '',
                        eCode: `E${est.id}`,
                    });
                }
            }

            console.log(`   📊 Page ${pageNum + 1}: ${projects.length} projects`);
            hasMore = projects.length === pageSize;
            pageNum++;
        } catch (err: any) {
            console.log(`   ⚠️  API fetch error: ${err.message}`);
            hasMore = false;
        }

        // Safety valve — don't fetch more than 20 pages
        if (pageNum >= 20) {
            console.log('   ⚠️  Reached page limit (20). Some orders may be missing.');
            break;
        }
    }

    console.log(`   📊 Total estimates fetched: ${allEstimates.length}`);

    // ── Group estimates by invoice ────────────────────────────────────────
    const byInvoice: Record<number, AxiomEstimate[]> = {};
    for (const est of allEstimates) {
        if (!est.invoiceId) continue;
        if (!byInvoice[est.invoiceId]) byInvoice[est.invoiceId] = [];
        byInvoice[est.invoiceId].push(est);
    }

    // ── Build invoice objects ─────────────────────────────────────────────
    const invoices: AxiomInvoice[] = [];
    for (const [invId, estimates] of Object.entries(byInvoice)) {
        const subtotal = estimates.reduce((s, e) => s + e.price, 0);

        invoices.push({
            invoiceNumber: `INV${invId}`,
            estimates,
            subtotal,
            shipping: 0,  // Shipping not available in the project API — need invoice detail
            tax: 0,        // Tax info not in project API
            total: subtotal, // Will be updated if we get shipping data
            orderDate: estimates[0]?.createdDate || '',
            status: 'PAID', // API only shows visible orders, which are completed/paid
        });
    }

    // Sort by date descending
    invoices.sort((a, b) => b.orderDate.localeCompare(a.orderDate));

    console.log(`   📊 ${invoices.length} unique invoices`);
    return invoices;
}

/**
 * Enrich invoices with shipping/handling and tracking data by parsing the
 * order history page text. The order cards already show:
 *   - TOTAL: $xxx.xx (which includes shipping+tax)
 *   - Tracking number (e.g., 1Z241Y710320177642) when shipped
 *   - Carrier (e.g., "Ground")
 *
 * DECISION(2026-03-17): Instead of clicking VIEW INVOICE for each order
 * (slow, CORS issues, buggy), we scrape the full order history page text.
 * Shipping = card_total - API_subtotal. User confirmed all orders are
 * shipped (never pickup), so every invoice should have shipping charges.
 */
async function enrichWithShipping(page: Page, invoices: AxiomInvoice[]): Promise<void> {
    console.log(`   🚚 Enriching ${invoices.length} invoices with shipping & tracking...`);

    // We need to scroll through ALL pages of order history to get every card.
    // Each page shows ~10 orders. We'll scroll and collect text from each page.

    // Navigate to order history
    await page.goto(ORDER_HISTORY_URL, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(5_000);

    // Grab the full text from the page
    // Axiom uses numbered page buttons (1, 2, 3...) at the bottom.
    // We'll click each page to collect all text.
    let fullText = await page.evaluate(() => document.body.innerText);

    // Find pagination buttons and click through all pages
    // The page numbers are plain text links: 1, 2, 3...
    for (let pageNum = 2; pageNum <= 10; pageNum++) {
        try {
            // Look for the page number as a clickable element
            // Axiom renders them as bare number buttons/links
            const pageBtn = page.locator(`a:text-is("${pageNum}"), button:text-is("${pageNum}")`);
            const btnCount = await pageBtn.count();

            if (btnCount === 0) {
                // Also try with locator matching last-of-type pagination patterns
                const altBtn = page.locator(`.pagination >> text="${pageNum}"`);
                if (await altBtn.count() === 0) break;
                await altBtn.first().click({ timeout: 5_000 });
            } else {
                await pageBtn.first().click({ timeout: 5_000 });
            }

            await page.waitForTimeout(3_000);
            const pageText = await page.evaluate(() => document.body.innerText);
            fullText += '\n---PAGE_BREAK---\n' + pageText;
            console.log(`     📄 Loaded order history page ${pageNum}`);
        } catch {
            // No more pages
            break;
        }
    }

    // ── Parse the order history text for invoice cards ──────────────────────
    // Pattern per card:
    //   INVOICE: INV122191\n\nTOTAL: $298.96\n\nPAID
    //   ...spec details...
    //   Shipping\n\n1Z241Y710320177642\n\nGround    (when shipped)
    //   Shipping\n\nNot Ready                            (when not yet shipped)

    // Extract all invoice blocks with their totals
    const invoicePattern = /INVOICE:\s*(INV\d+)\s*\n\s*\nTOTAL:\s*\$([\d,.]+)\s*\n\s*\n(PAID|UNPAID|PARTIALLY PAID)/g;
    let match: RegExpExecArray | null;
    const cardTotals: Record<string, number> = {};
    const cardStatuses: Record<string, string> = {};

    while ((match = invoicePattern.exec(fullText)) !== null) {
        const invNum = match[1];
        const total = parseFloat(match[2].replace(/,/g, ''));
        cardTotals[invNum] = total;
        cardStatuses[invNum] = match[3];
    }

    // Extract tracking numbers — pattern: "Shipping\n\n{tracking}\n\n{carrier}"
    // UPS: 1Z..., FedEx: \d{12,22}, USPS: 9...(20+ digits)
    const trackingPattern = /Shipping\s*\n\s*\n((?:1Z[A-Z0-9]+|\d{12,22}|9\d{15,30}))\s*\n\s*\n([A-Za-z\s]+?)(?:\n|Buildasoil)/g;
    const trackingBySection: Array<{ tracking: string; carrier: string; position: number }> = [];

    let tMatch: RegExpExecArray | null;
    while ((tMatch = trackingPattern.exec(fullText)) !== null) {
        trackingBySection.push({
            tracking: tMatch[1].trim(),
            carrier: tMatch[2].trim(),
            position: tMatch.index,
        });
    }

    // Now match tracking numbers to invoices by text position proximity
    // Each invoice card in the text is followed by its details including shipping/tracking
    const invoicePositions: Array<{ invNum: string; position: number }> = [];
    const invPosPattern = /INVOICE:\s*(INV\d+)/g;
    let ipMatch: RegExpExecArray | null;
    while ((ipMatch = invPosPattern.exec(fullText)) !== null) {
        invoicePositions.push({ invNum: ipMatch[1], position: ipMatch.index });
    }

    // ── Apply enrichment to our invoice objects ────────────────────────────
    let enriched = 0;
    let trackingFound = 0;

    for (const inv of invoices) {
        const cardTotal = cardTotals[inv.invoiceNumber];
        if (cardTotal !== undefined) {
            // shipping = grand_total_on_card - subtotal_from_API
            inv.shipping = Math.max(0, Math.round((cardTotal - inv.subtotal) * 100) / 100);
            inv.total = cardTotal;
            inv.status = cardStatuses[inv.invoiceNumber] || inv.status;
            enriched++;

            // Find associated tracking number
            // The tracking appears AFTER the invoice card and BEFORE the next invoice card
            const invPos = invoicePositions.find(ip => ip.invNum === inv.invoiceNumber);
            if (invPos) {
                const nextInvPos = invoicePositions.find(ip => ip.position > invPos.position);
                const endPos = nextInvPos ? nextInvPos.position : fullText.length;

                const trackingForInv = trackingBySection.find(
                    t => t.position > invPos.position && t.position < endPos
                );

                if (trackingForInv) {
                    // Store tracking info on the invoice
                    (inv as any).trackingNumber = trackingForInv.tracking;
                    (inv as any).carrier = trackingForInv.carrier;
                    trackingFound++;
                }
            }

            const trackInfo = (inv as any).trackingNumber
                ? ` | tracking: ${(inv as any).trackingNumber} (${(inv as any).carrier})`
                : ' | no tracking yet';
            console.log(`     ${inv.invoiceNumber}: shipping=$${inv.shipping}, total=$${inv.total}${trackInfo}`);
        } else {
            console.log(`     ${inv.invoiceNumber}: ⚠️  not found on order history page`);
        }
    }

    console.log(`   📊 Enriched ${enriched}/${invoices.length} invoices, ${trackingFound} with tracking`);
}

/**
 * Full data fetch pipeline: login, hit API, optionally enrich with shipping.
 */
async function fetchAll(): Promise<AxiomInvoice[]> {
    console.log('\n📋 Phase 1: Fetching Axiom Print Order Data via API');
    console.log('   ⚠️  Chrome must be closed for this step\n');

    if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR, { recursive: true });

    const context = await launchBrowser();
    const page = context.pages()[0] || await context.newPage();
    let invoices: AxiomInvoice[] = [];

    try {
        await ensureLoggedIn(page);

        // Fetch structured data via REST API (uses context.request, not page.evaluate)
        invoices = await fetchViaAPI(context);

        // Enrich first page of invoices with shipping data from VIEW INVOICE
        if (invoices.length > 0) {
            await enrichWithShipping(page, invoices);
        }

        // Save fetched data
        fs.writeFileSync(JSON_PATH, JSON.stringify(invoices, null, 2));
        console.log(`\n   💾 Saved ${invoices.length} invoices to ${JSON_PATH}`);

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
    status: string;
    errors: string[];
}

async function reconcilePO(
    finale: FinaleClient,
    get: Function,
    post: Function,
    poId: string,
    invoices: AxiomInvoice[],
    dryRun: boolean,
    run: ReconciliationRun,
): Promise<ReconcileResult> {
    const result: ReconcileResult = { po: poId, priceChanges: 0, freightAdded: 0, status: '', errors: [] };

    // Merge Axiom items across all invoices for this PO
    // DECISION(2026-03-17): For front/back label pairs, the total price
    // from Axiom covers both labels. We split qty equally but keep
    // the same per-label unit price: unitPrice = est.price / est.quantity.
    const axiomItemMap: Record<string, { unitPrice: number; qty: number; jobName: string }> = {};
    let totalFreight = 0;
    const invNums: string[] = [];

    for (const inv of invoices) {
        invNums.push(inv.invoiceNumber);
        totalFreight += inv.shipping;

        for (const est of inv.estimates) {
            if (est.price <= 0) continue;
            const mapping = toFinaleIds(est.jobName);
            if (!mapping) {
                result.errors.push(`Unmapped SKU: "${est.jobName}" (${est.eCode}) — add to AXIOM_TO_FINALE map`);
                continue;
            }

            const perLabelPrice = est.quantity > 0 ? est.price / est.quantity : est.price;

            for (const sku of mapping.skus) {
                const skuQty = Math.round(est.quantity * mapping.qtyFraction);
                if (axiomItemMap[sku]) {
                    axiomItemMap[sku].qty += skuQty;
                } else {
                    axiomItemMap[sku] = {
                        unitPrice: perLabelPrice,
                        jobName: est.jobName,
                        qty: skuQty,
                    };
                }
            }
        }
    }

    try {
        const po = await finale.getOrderDetails(poId);
        const origStatus = po.statusId;
        result.status = origStatus;

        // Unlock PO for editing if needed
        if (!dryRun && po.actionUrlEdit && (origStatus === 'ORDER_LOCKED' || origStatus === 'ORDER_COMPLETED')) {
            await post(po.actionUrlEdit, {});
        }

        const unlocked = dryRun ? po : await finale.getOrderDetails(poId);

        // Update prices — stickers/labels typically don't need UOM conversion
        for (const item of unlocked.orderItemList || []) {
            const fId = item.productUrl?.split('/').pop() || '';
            const aItem = axiomItemMap[fId];
            if (!aItem) continue;

            const correctPrice = aItem.unitPrice;

            if (Math.abs(item.unitPrice - correctPrice) > 0.001) {
                console.log(`     ${fId}: $${item.unitPrice.toFixed(4)} → $${correctPrice.toFixed(4)}`);
                if (!dryRun) item.unitPrice = correctPrice;
                result.priceChanges++;
                run.recordPriceChange(fId, item.unitPrice, correctPrice);
            }
        }

        // Check freight — avoid duplicates
        const existingAdj = unlocked.orderAdjustmentList || [];
        // any: Finale API adjustment objects have variable shape
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existingFreight = existingAdj
            .filter((a: any) => a.productPromoUrl === FREIGHT_PROMO)
            .reduce((s: number, a: any) => s + a.amount, 0);

        if (totalFreight > 0 && Math.abs(existingFreight - totalFreight) > 0.01) {
            const label = `Freight - Axiom Print ${invNums.join('+')}`;
            // any: Finale API adjustment objects have variable shape
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const alreadyLabeled = existingAdj.some((a: any) => a.description?.includes('Axiom Print'));
            if (!alreadyLabeled) {
                console.log(`     + Freight: $${totalFreight} (${label})`);
                if (!dryRun) {
                    existingAdj.push({ amount: totalFreight, description: label, productPromoUrl: FREIGHT_PROMO });
                }
                result.freightAdded = totalFreight;
                run.recordFreight(totalFreight * 100);
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
        run.recordError(`reconcilePO(${poId})`, err instanceof Error ? err : new Error(String(err.message)));
    }

    return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs();
    let run: ReconciliationRun | null = null;
    try {
        run = await ReconciliationRun.start('Axiom', args.dryRun ? 'dry-run' : 'live', {
            discover: args.discover,
            scrapeOnly: args.scrapeOnly,
            updateOnly: args.updateOnly,
            singlePO: args.singlePO,
        });
        console.log('╔══════════════════════════════════════════════════╗');
        console.log('║  Axiom Print → Finale Invoice Reconciliation    ║');
        console.log('║  (API-first approach)                           ║');
        console.log('╚══════════════════════════════════════════════════╝');

        // Discovery mode — explore the page structure before writing scraper
        if (args.discover) {
            await discover();
            await run.complete('Axiom discovery complete.');
            return;
        }

        if (args.dryRun) console.log('   🔍 DRY RUN — no changes will be saved\n');

        // Phase 1: Get order data
        let invoices: AxiomInvoice[];

        if (args.updateOnly && fs.existsSync(JSON_PATH)) {
            invoices = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
            console.log(`\n📋 Using cached data: ${invoices.length} invoices from ${JSON_PATH}`);
        } else if (args.updateOnly) {
            console.error('❌ --update-only specified but no cached data found. Run without --update-only first.');
            process.exit(1);
        } else {
            invoices = await fetchAll();
        }

        if (args.scrapeOnly) {
            console.log('\n✅ Fetch complete. Use --update-only to reconcile without re-fetching.');

        // Print a summary of what we found
        console.log('\n📊 Invoice Summary:');
        console.log('─'.repeat(90));
        console.log(`${'Invoice'.padEnd(14)} ${'Date'.padEnd(14)} ${'Job Name'.padEnd(20)} ${'Product'.padEnd(16)} ${'Qty'.padEnd(8)} ${'Price'.padEnd(10)} ${'Ship'.padEnd(8)}`);
        console.log('─'.repeat(90));

        for (const inv of invoices) {
            for (const est of inv.estimates) {
                console.log(
                    `${inv.invoiceNumber.padEnd(14)} ` +
                    `${est.createdDate.slice(0, 10).padEnd(14)} ` +
                    `${est.jobName.slice(0, 18).padEnd(20)} ` +
                    `${est.productType.slice(0, 14).padEnd(16)} ` +
                    `${String(est.quantity).padEnd(8)} ` +
                    `$${est.price.toFixed(2).padEnd(9)} ` +
                    `$${inv.shipping.toFixed(2)}`
                );
            }
        }
        console.log('─'.repeat(90));

        const totalValue = invoices.reduce((s, inv) => s + inv.subtotal, 0);
        const totalShipping = invoices.reduce((s, inv) => s + inv.shipping, 0);
        console.log(`\nTotal: ${invoices.length} invoices, $${totalValue.toFixed(2)} products + $${totalShipping.toFixed(2)} shipping`);

        // List unmapped and mapped SKUs
        const unmapped = new Set<string>();
        const mapped = new Set<string>();
        for (const inv of invoices) {
            for (const est of inv.estimates) {
                const mapping = toFinaleIds(est.jobName);
                if (mapping) {
                    mapped.add(`${est.jobName} → ${mapping.skus.join(' + ')} (${mapping.description || ''})`);
                } else if (est.jobName) {
                    unmapped.add(`${est.jobName} (${est.eCode})`);
                }
            }
        }
        if (mapped.size > 0) {
            console.log(`\n✅ ${mapped.size} mapped SKUs:`);
            for (const s of Array.from(mapped)) console.log(`   ✓ ${s}`);
        }
        if (unmapped.size > 0) {
            console.log(`\n⚠️  ${unmapped.size} unmapped SKUs (add to AXIOM_TO_FINALE map):`);
            for (const s of Array.from(unmapped)) console.log(`   - ${s}`);
        }

        await run.complete('Axiom scrape complete.');
        return;
    }

    if (invoices.length === 0) {
        console.log('\n⚠️  No invoices to reconcile. Run --scrape-only first to inspect the data.');
        return;
    }

    // Phase 2: Fetch Axiom POs from Finale and reconcile
    console.log('\n💰 Phase 2: Reconciling Prices & Freight\n');

    const finale = new FinaleClient();
    const get = (finale as any).get.bind(finale);
    const post = (finale as any).post.bind(finale);

    // 2a. Fetch all POs and filter for Axiom vendor
    // DECISION(2026-03-17): Finale API hard caps at first:1000. Over 540 days the
    // total PO count across all vendors exceeds 1000, so older Axiom POs get cut off.
    // Solution: two paginated calls (recent 270d + older 270-540d), then deduplicate.
    console.log('   Fetching POs (page 1: recent 270 days)...');
    const recentPOs = await finale.getRecentPurchaseOrders(270, 1000);
    console.log(`   → ${recentPOs.length} POs`);
    console.log('   Fetching POs (page 2: 270-540 days ago)...');
    const olderPOs = await finale.getRecentPurchaseOrders(540, 1000);
    console.log(`   → ${olderPOs.length} POs`);

    // Deduplicate by orderId (overlap at boundary)
    const seenIds = new Set<string>();
    const allPOs: typeof recentPOs = [];
    for (const po of [...recentPOs, ...olderPOs]) {
        if (!seenIds.has(po.orderId)) {
            seenIds.add(po.orderId);
            allPOs.push(po);
        }
    }
    console.log(`   → ${allPOs.length} unique POs total`);

    const axiomPOs = allPOs.filter((po: any) =>
        (po.vendorName?.toLowerCase().includes('axiom'))
        && !po.status?.toLowerCase().includes('cancel')
    );

    console.log(`   Found ${axiomPOs.length} Axiom POs in Finale (last 540 days)`);
    for (const po of axiomPOs) {
        console.log(`   - PO ${po.orderId} from ${po.orderDate?.substring(0, 10)} (${po.vendorName || 'unknown vendor'})`);
    }

    if (axiomPOs.length === 0 && !args.dryRun) {
        console.log('\n   ⚠️  No Axiom POs found. Will create draft POs for all invoices.');
    }

    // 2b. Two-pass matching: newest invoices get priority
    //   Pass 1: Strict — date proximity + SKU overlap
    //   Pass 2: Date-only — for remaining invoices near a PO but with different line items
    const matchedPairs: Array<{ invoice: AxiomInvoice; po: any; matchType: 'sku' | 'date' }> = [];
    const unmatchedInvoices: AxiomInvoice[] = [];
    const usedPOs = new Set<string>();

    // Sort invoices newest-first so recent orders get first pick at matching POs
    const sortedInvoices = [...invoices].sort(
        (a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime()
    );

    // Cache PO details to avoid redundant API calls
    const poDetailsCache = new Map<string, any>();
    const getPoDetails = async (poId: string) => {
        if (!poDetailsCache.has(poId)) {
            poDetailsCache.set(poId, await finale.getOrderDetails(poId));
        }
        return poDetailsCache.get(poId);
    };

    // --- Pass 1: Strict matching (date + SKU overlap) ---
    const pass1Unmatched: AxiomInvoice[] = [];
    for (const invoice of sortedInvoices) {
        const existing = await lookupVendorInvoices({ vendor: 'Axiom Print', invoice_number: invoice.invoiceNumber });
        if (existing.length > 0 && existing[0].status !== 'void') {
            run.recordWarning(`Invoice ${invoice.invoiceNumber} already reconciled, skipping`, { invoiceNumber: invoice.invoiceNumber });
            continue;
        }
        const invDate = new Date(invoice.orderDate).getTime();
        let bestMatch: any = null;
        let minDiff = 99999;

        // Resolve SKUs from this invoice
        const invoiceSkus = new Set<string>();
        for (const est of invoice.estimates) {
            const mapping = toFinaleIds(est.jobName);
            if (mapping) {
                for (const sku of mapping.skus) invoiceSkus.add(sku);
            }
        }

        for (const po of axiomPOs) {
            if (usedPOs.has(po.orderId)) continue;
            const poDate = new Date(po.orderDate).getTime();
            const diffDays = (invDate - poDate) / (1000 * 60 * 60 * 24);

            if (diffDays >= -7 && diffDays <= 30) {
                const poDetails = await getPoDetails(po.orderId);
                let hasSkuMatch = false;
                for (const fItem of poDetails.orderItemList || []) {
                    const fSku = fItem.productUrl?.split('/').pop() || '';
                    if (invoiceSkus.has(fSku)) { hasSkuMatch = true; break; }
                }
                if (hasSkuMatch && Math.abs(diffDays) < minDiff) {
                    bestMatch = po;
                    minDiff = Math.abs(diffDays);
                }
            }
        }

        if (bestMatch) {
            matchedPairs.push({ invoice, po: bestMatch, matchType: 'sku' });
            usedPOs.add(bestMatch.orderId);
            run.recordInvoiceFound();
        } else {
            pass1Unmatched.push(invoice);
        }
    }

    // --- Pass 2: Date-only fallback for remaining invoices ---
    // If an invoice is near an unused PO but had no SKU overlap, match by date alone.
    // This handles cases where the PO has different product IDs or missing line items.
    for (const invoice of pass1Unmatched) {
        const existing = await lookupVendorInvoices({ vendor: 'Axiom Print', invoice_number: invoice.invoiceNumber });
        if (existing.length > 0 && existing[0].status !== 'void') {
            run.recordWarning(`Invoice ${invoice.invoiceNumber} already reconciled, skipping`, { invoiceNumber: invoice.invoiceNumber });
            continue;
        }
        const invDate = new Date(invoice.orderDate).getTime();
        let bestMatch: any = null;
        let minDiff = 99999;

        for (const po of axiomPOs) {
            if (usedPOs.has(po.orderId)) continue;
            const poDate = new Date(po.orderDate).getTime();
            const diffDays = (invDate - poDate) / (1000 * 60 * 60 * 24);

            // Tighter window for date-only matches: [-5, +14] days
            if (diffDays >= -5 && diffDays <= 14 && Math.abs(diffDays) < minDiff) {
                bestMatch = po;
                minDiff = Math.abs(diffDays);
            }
        }

        if (bestMatch) {
            matchedPairs.push({ invoice, po: bestMatch, matchType: 'date' });
            usedPOs.add(bestMatch.orderId);
            run.recordInvoiceFound();
        } else {
            unmatchedInvoices.push(invoice);
        }
    }

    // Sort matched pairs by date for display (newest first)
    matchedPairs.sort((a, b) => new Date(b.invoice.orderDate).getTime() - new Date(a.invoice.orderDate).getTime());

    const skuMatches = matchedPairs.filter(m => m.matchType === 'sku').length;
    const dateMatches = matchedPairs.filter(m => m.matchType === 'date').length;
    console.log(`\n   📊 Matching: ${skuMatches} strict (SKU+date), ${dateMatches} date-only, ${unmatchedInvoices.length} unmatched\n`);

    // 2c. Reconcile matched POs
    const results: ReconcileResult[] = [];
    for (const { invoice, po, matchType } of matchedPairs) {
        const mtLabel = matchType === 'sku' ? '🔗 SKU' : '📅 date';
        console.log(`\n   ── PO ${po.orderId} ↔ ${invoice.invoiceNumber} (${mtLabel}) ──`);
        const result = await reconcilePO(finale, get, post, po.orderId, [invoice], args.dryRun, run);
        results.push(result);

        if (result.priceChanges > 0 || result.freightAdded > 0) {
            run.recordPoUpdated(po.orderId);
        }

        const icon = result.errors.length > 0 ? '❌' : result.priceChanges > 0 || result.freightAdded > 0 ? '✅' : '⏭️';
        console.log(`   ${icon} ${result.priceChanges} price updates, $${result.freightAdded.toFixed(2)} freight | ${result.status}`);

        if (result.errors.length > 0) {
            for (const err of result.errors) console.log(`      ⚠️  ${err}`);
        }

        // Archive to vendor_invoices
        if (!args.dryRun) {
            try {
                await upsertVendorInvoice({
                    vendor_name: 'Axiom Print',
                    invoice_number: invoice.invoiceNumber,
                    invoice_date: invoice.orderDate?.substring(0, 10) ?? null,
                    po_number: po.orderId,
                    subtotal: invoice.subtotal,
                    freight: invoice.shipping,
                    tax: invoice.tax,
                    total: invoice.total,
                    status: 'reconciled',
                    source: 'portal_scrape',
                    source_ref: `reconcile-axiom-${new Date().toISOString().split('T')[0]}`,
                    line_items: invoice.estimates.map((est: any) => {
                        const mapping = toFinaleIds(est.jobName);
                        return {
                            sku: mapping?.skus.join(', ') ?? est.jobName,
                            description: est.jobName,
                            qty: est.quantity,
                            unit_price: est.quantity > 0 ? est.price / est.quantity : est.price,
                            ext_price: est.price,
                        };
                    }),
                    raw_data: invoice as unknown as Record<string, unknown>,
                });
            } catch { /* dedup collision or non-critical */ }
        }
    }

    // 2d. Create draft POs for unmatched invoices
    if (unmatchedInvoices.length > 0) {
        console.log(`\n   📝 Creating draft POs for ${unmatchedInvoices.length} unmatched invoice(s)...\n`);

        // Look up Axiom vendor party
        let vendorPartyId: string | null = null;
        try {
            vendorPartyId = await finale.findVendorPartyByName('Axiom Print');
            if (!vendorPartyId) vendorPartyId = await finale.findVendorPartyByName('Axiom');
        } catch { /* fallback below */ }

        if (!vendorPartyId) {
            console.log('   ⚠️  Could not find Axiom Print vendor party ID in Finale.');
            console.log('   Unmatched invoices need manual PO creation:');
            for (const inv of unmatchedInvoices) {
                console.log(`      - ${inv.invoiceNumber} ($${inv.subtotal.toFixed(2)}) from ${inv.orderDate.substring(0, 10)}`);
            }
        } else {
            // DECISION(2026-03-25): Import supabase for dedup checks before draft creation.
            // Without this, every nightly run creates NEW draft POs for all historical
            // invoices that don't match an existing committed PO by date/SKU proximity.
            const { createClient: createSb } = await import('../lib/supabase');
            const sbClient = createSb();

            for (const inv of unmatchedInvoices) {
                // ── DEDUP GUARD ──────────────────────────────────────────────
                // DECISION(2026-03-25): Check vendor_invoices table BEFORE creating
                // a draft PO. If a previous run already created a PO for this
                // invoice number, skip it. This prevents the nightly cron from
                // producing duplicate draft POs every single run.
                try {
                    const { data: existingVI } = await sbClient
                        .from('vendor_invoices')
                        .select('id, po_number')
                        .eq('vendor_name', 'Axiom Print')
                        .eq('invoice_number', inv.invoiceNumber)
                        .maybeSingle();

                    if (existingVI?.po_number) {
                        console.log(`      ⏭️  ${inv.invoiceNumber}: Already has PO #${existingVI.po_number} — skipping draft creation`);
                        continue;
                    }
                } catch { /* table may not exist — proceed with creation */ }

                // Build line items from invoice estimates using SKU mapping
                const items: Array<{ productId: string; quantity: number; unitPrice: number }> = [];
                for (const est of inv.estimates) {
                    const mapping = toFinaleIds(est.jobName);
                    if (!mapping) {
                        console.log(`      ⚠️  Skipping unmapped SKU: "${est.jobName}" (${est.eCode})`);
                        continue;
                    }
                    const perLabelPrice = est.quantity > 0 ? est.price / est.quantity : est.price;
                    for (const sku of mapping.skus) {
                        items.push({
                            productId: sku,
                            quantity: Math.round(est.quantity * mapping.qtyFraction),
                            unitPrice: perLabelPrice,
                        });
                    }
                }

                if (items.length === 0) {
                    console.log(`      ⚠️  ${inv.invoiceNumber}: No mappable SKUs — skipping draft PO`);
                    continue;
                }

                const memo = `Auto-created from Axiom ${inv.invoiceNumber} by reconcile-axiom`;
                console.log(`   ${inv.invoiceNumber}: ${items.length} line items, $${inv.subtotal.toFixed(2)} + $${inv.shipping.toFixed(2)} freight`);

                if (args.dryRun) {
                    console.log(`      🔍 [DRY RUN] Would create draft PO with:`);
                    for (const item of items) {
                        console.log(`         → ${item.productId}: ${item.quantity} × $${item.unitPrice.toFixed(4)}`);
                    }
                } else {
                    try {
                        const result = await finale.createDraftPurchaseOrder(
                            vendorPartyId,
                            items,
                            memo,
                        );
                        console.log(`      ✅ Created draft PO #${result.orderId}`);
                        console.log(`      🔗 ${result.finaleUrl}`);

                        // Add freight adjustment if shipping > 0
                        if (inv.shipping > 0) {
                            try {
                                const poDetail = await finale.getOrderDetails(result.orderId);
                                const adjs = poDetail.orderAdjustmentList || [];
                                adjs.push({
                                    amount: inv.shipping,
                                    description: `Freight - Axiom Print ${inv.invoiceNumber}`,
                                    productPromoUrl: FREIGHT_PROMO,
                                });
                                await post(`/buildasoilorganics/api/order/${encodeURIComponent(result.orderId)}`, poDetail);
                                console.log(`      + Freight: $${inv.shipping.toFixed(2)}`);
                            } catch (freightErr: any) {
                                console.log(`      ⚠️  Freight add failed: ${freightErr.message}`);
                            }
                        }

                        if (result.duplicateWarnings.length > 0) {
                            for (const w of result.duplicateWarnings) console.log(`      ${w}`);
                        }

                        // Archive to vendor_invoices
                        try {
                            await upsertVendorInvoice({
                                vendor_name: 'Axiom Print',
                                invoice_number: inv.invoiceNumber,
                                invoice_date: inv.orderDate?.substring(0, 10) ?? null,
                                po_number: result.orderId,
                                subtotal: inv.subtotal,
                                freight: inv.shipping,
                                tax: inv.tax,
                                total: inv.total,
                                status: 'received',
                                source: 'portal_scrape',
                                source_ref: `reconcile-axiom-draft-${new Date().toISOString().split('T')[0]}`,
                                line_items: items.map(i => ({
                                    sku: i.productId,
                                    description: i.productId,
                                    qty: i.quantity,
                                    unit_price: i.unitPrice,
                                    ext_price: i.quantity * i.unitPrice,
                                })),
                                raw_data: inv as unknown as Record<string, unknown>,
                            });
                        } catch { /* dedup collision or non-critical */ }
                    } catch (err: any) {
                        console.log(`      ❌ Draft PO creation failed: ${err.message}`);
                    }
                }
            }
        }
    }

    // 2e. Summary
    const totalPriceChanges = results.reduce((s, r) => s + r.priceChanges, 0);
    const totalFreightAdded = results.reduce((s, r) => s + r.freightAdded, 0);
    const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   RECONCILIATION COMPLETE                       ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║   Invoices:     ${String(invoices.length).padEnd(4)}                           ║`);
    console.log(`║   Matched POs:  ${String(matchedPairs.length).padEnd(4)}                           ║`);
    console.log(`║   Unmatched:    ${String(unmatchedInvoices.length).padEnd(4)}                           ║`);
    console.log(`║   Price updates:${String(totalPriceChanges).padEnd(4)}                           ║`);
    console.log(`║   Freight:      $${totalFreightAdded.toFixed(2).padEnd(10)}                    ║`);
    if (totalErrors > 0) {
    console.log(`║   Errors:       ${String(totalErrors).padEnd(4)}                           ║`);
    }
    console.log('╚══════════════════════════════════════════════════╝');

        await run.complete('Axiom reconciliation complete.');
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (run) {
            await run.fail('Axiom reconciliation failed', error);
        } else {
            console.error('[Axiom] Fatal error before run could be created:', error.message);
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
