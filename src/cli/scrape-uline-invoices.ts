/**
 * @file    scrape-uline-invoices.ts
 * @purpose Automated Uline invoice portal scraper — uses session cookies from
 *          the user's real Chrome browser to skip login (no CAPTCHA issues),
 *          triggers the native CSV export, and deposits the file in the Sandbox.
 * @author  Will / Antigravity
 * @created 2026-03-13
 * @updated 2026-03-13
 * @deps    playwright, dotenv, fs, path, os
 * @env     ULINE_EMAIL, ULINE_PASSWORD
 *
 * Usage:
 *   node --import tsx src/cli/scrape-uline-invoices.ts
 *   node --import tsx src/cli/scrape-uline-invoices.ts --headful   (watch it run)
 *
 * HOW IT WORKS:
 *   1. Copies cookies from the user's real Chrome profile (already authenticated)
 *   2. Injects them into a fresh Playwright browser context
 *   3. Navigates directly to Invoices page — no login, no CAPTCHA
 *   4. Triggers the CSV export, saves to Sandbox
 *
 * DECISION(2026-03-13): Uline uses aggressive server-side bot detection that
 * triggers reCAPTCHA on any Playwright login attempt, regardless of stealth
 * patches. Bypassing by using real session cookies from the user's Chrome
 * profile eliminates the need to log in via automation entirely.
 *
 * PREREQ: The user must have logged into uline.com at least once in their
 * regular Chrome browser. If cookies expire, just log in again normally.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { chromium, type Page, type Cookie } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const ULINE_EMAIL = process.env.ULINE_EMAIL;
const ULINE_PASSWORD = process.env.ULINE_PASSWORD;
const INVOICES_URL = 'https://www.uline.com/MyAccount/Invoices';

const SANDBOX_DIR = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');
const COOKIE_CACHE = path.join(os.homedir(), '.uline-cookies.json');
const HEADFUL = process.argv.includes('--headful');

// ── Helpers ───────────────────────────────────────────────────────────────────

function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Finds the user's Chrome Default profile cookie database path.
 */
function getChromeProfileDir(): string {
    return path.join(
        os.homedir(),
        'AppData', 'Local', 'Google', 'Chrome', 'User Data'
    );
}

/**
 * Load cached cookies from our JSON file, if they exist and aren't too old.
 */
function loadCachedCookies(): Cookie[] | null {
    if (!fs.existsSync(COOKIE_CACHE)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(COOKIE_CACHE, 'utf8'));
        // Cookies older than 24 hours? Refresh.
        if (data.timestamp && Date.now() - data.timestamp > 24 * 60 * 60 * 1000) {
            console.log('[uline-scraper] Cached cookies are stale (>24h), will re-extract');
            return null;
        }
        return data.cookies;
    } catch {
        return null;
    }
}

/**
 * Save cookies to our cache file after a successful session.
 */
function saveCookies(cookies: Cookie[]): void {
    fs.writeFileSync(COOKIE_CACHE, JSON.stringify({
        timestamp: Date.now(),
        cookies: cookies.filter(c => c.domain.includes('uline.com')),
    }, null, 2));
}

/**
 * Launch a headful browser for manual login, extract cookies, and return them.
 * This is the fallback when we have no cached cookies.
 */
async function loginManuallyAndExtractCookies(): Promise<Cookie[]> {
    if (!ULINE_EMAIL || !ULINE_PASSWORD) {
        throw new Error('Missing ULINE_EMAIL or ULINE_PASSWORD in .env.local');
    }

    console.log('[uline-scraper] No valid cookies found — launching headed Chrome for login...');
    console.log('[uline-scraper] ℹ️  If a CAPTCHA appears, solve it in the browser window.');

    // Use the real Chrome profile so user's cookies/extensions/state are available
    const profileDir = getChromeProfileDir();
    const context = await chromium.launchPersistentContext(
        path.join(profileDir, 'Default'),
        {
            headless: false,       // Must be headed for manual CAPTCHA solve
            channel: 'chrome',
            acceptDownloads: true,
            viewport: { width: 1280, height: 800 },
            args: ['--disable-blink-features=AutomationControlled'],
        }
    );

    const page = context.pages()[0] || await context.newPage();

    // Navigate to invoices
    await page.goto(INVOICES_URL, { waitUntil: 'load', timeout: 60_000 });

    // If we end up on login, fill creds and wait for user to solve CAPTCHA if needed
    const landed = await Promise.race([
        page.waitForSelector('#txtEmail', { timeout: 5_000 }).then(() => 'login' as const),
        page.waitForSelector('.k-grid', { timeout: 5_000 }).then(() => 'grid' as const),
    ]).catch(() => 'unknown' as const);

    if (landed === 'login') {
        await page.fill('#txtEmail', ULINE_EMAIL);
        await page.fill('#txtPassword', ULINE_PASSWORD);
        await page.click('#btnSignIn');

        // Wait for successful login (user may need to solve CAPTCHA)
        console.log('[uline-scraper] 🔐 Waiting for login to complete (up to 120s for CAPTCHA)...');
        await page.waitForSelector('.k-grid', { timeout: 120_000 });
        console.log('[uline-scraper] ✔️ Login successful');
    }

    // Extract cookies
    const cookies = await context.cookies();
    await context.close();
    return cookies;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
    ensureDir(SANDBOX_DIR);

    // ── Step 1: Get cookies (cached or manual login) ─────────────────────────
    let cookies = loadCachedCookies();

    if (!cookies) {
        cookies = await loginManuallyAndExtractCookies();
        saveCookies(cookies);
        console.log(`[uline-scraper] Saved ${cookies.length} cookies to cache`);
    } else {
        console.log(`[uline-scraper] Using ${cookies.length} cached cookies`);
    }

    // ── Step 2: Launch clean browser with injected cookies ────────────────────
    console.log(`[uline-scraper] Launching Chrome (${HEADFUL ? 'headful' : 'headless'})...`);
    const browser = await chromium.launch({
        headless: !HEADFUL,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    // Inject the cookies before navigating
    await context.addCookies(cookies);

    const page = await context.newPage();

    try {
        // ── Step 3: Navigate directly to invoices ─────────────────────────────
        console.log('[uline-scraper] Navigating to invoices page...');
        await page.goto(INVOICES_URL, { waitUntil: 'load', timeout: 30_000 });

        // Check if cookies worked
        const landed = await Promise.race([
            page.waitForSelector('.k-grid', { timeout: 15_000 }).then(() => 'grid' as const),
            page.waitForSelector('#txtEmail', { timeout: 15_000 }).then(() => 'login' as const),
        ]).catch(() => 'unknown' as const);

        if (landed !== 'grid') {
            // Cookies expired — clear cache and retry with manual login
            console.log('[uline-scraper] Cookies expired — clearing cache and re-authenticating...');
            fs.unlinkSync(COOKIE_CACHE);
            await browser.close();

            // Recursive retry with fresh login
            return run();
        }

        console.log('[uline-scraper] ✔️ Authenticated via cookies');

        // ── Step 4: Wait for grid data ────────────────────────────────────────
        console.log('[uline-scraper] Waiting for invoice data...');
        await page.waitForSelector('.k-grid-content tr', { timeout: 20_000 });
        await page.waitForTimeout(2_000);

        const rowCount = await page.locator('.k-grid-content tr').count();
        console.log(`[uline-scraper] Grid loaded: ${rowCount} invoices`);

        // ── Step 5: Trigger CSV export ────────────────────────────────────────
        console.log('[uline-scraper] Exporting CSV...');
        const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
        await page.evaluate(() => { (window as any).Export('csv'); });

        const download = await downloadPromise;
        const outputName = `ULINE_INVOICES_${timestamp()}.csv`;
        const outputPath = path.join(SANDBOX_DIR, outputName);
        await download.saveAs(outputPath);
        console.log(`[uline-scraper] ✔️ Saved: ${outputPath}`);

        // ── Step 6: Refresh cookie cache (extend session) ─────────────────────
        const freshCookies = await context.cookies();
        saveCookies(freshCookies);

        // ── Step 7: Summary ───────────────────────────────────────────────────
        const csvContent = fs.readFileSync(outputPath, 'utf8');
        const lines = csvContent.trim().split('\n');
        const dataRows = lines.length - 1;

        console.log(`\n[uline-scraper] === EXPORT SUMMARY ===`);
        console.log(`  File:    ${outputName}`);
        console.log(`  Rows:    ${dataRows}`);
        console.log(`  Headers: ${lines[0]}`);

        if (dataRows > 0) {
            console.log(`\n  Preview (first ${Math.min(3, dataRows)} rows):`);
            for (let i = 1; i <= Math.min(3, dataRows); i++) {
                console.log(`    ${lines[i]}`);
            }
        }

        console.log(`\n[uline-scraper] ✅ Done — ${dataRows} invoices exported to Sandbox`);

    } catch (err: any) {
        console.error(`[uline-scraper] ❌ Error: ${err.message}`);
        const screenshotPath = path.join(SANDBOX_DIR, `uline-error-${timestamp()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        console.error(`[uline-scraper] Debug screenshot: ${screenshotPath}`);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

run().catch((err) => {
    console.error('[uline-scraper] Fatal error:', err);
    process.exit(1);
});
