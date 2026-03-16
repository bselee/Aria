/**
 * @file    fetch-fedex-csv.ts
 * @purpose Automates downloading the latest invoice CSV from FedEx Billing Online.
 *          Launches Chrome wrapped by Playwright but with all your extensions 
 *          (like 1Password) intact, navigates to FBO, and saves the resulting CSV
 *          to the Sandbox directory.
 * @author  Will / Antigravity
 * @created 2026-03-16
 * @updated 2026-03-16
 * @deps    playwright, dotenv
 *
 * Usage:
 *   node --import tsx src/cli/fetch-fedex-csv.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { chromium } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';

const FBO_URL = 'https://www.fedex.com/en-us/billing-online.html';
const CHROME_PROFILE_DIR = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const SANDBOX_DIR = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');

async function main() {
    console.log(`\n╔═══════════════════════════════════════════════╗`);
    console.log(`║      FedEx Billing Online CSV Downloader      ║`);
    console.log(`╚═══════════════════════════════════════════════╝\n`);

    if (!fs.existsSync(SANDBOX_DIR)) {
        fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    }

    console.log('🚀 Phase 1: Launching Chrome with your persistent profile AND extensions...');
    console.log('   ⚠️  Please ensure no other Chrome windows are open before we start.\n');

    try {
        // Kill any invisible chrome.exe background processes hanging around
        require('child_process').execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
        // Give the OS a moment to release the profile and DB locks
        await new Promise(r => setTimeout(r, 2000));
    } catch {
        // ignore
    }

    // By default, Playwright disables all extensions. To use 1Password, we MUST
    // use a persistent context, point to your user data dir, and ignore the disable args.
    const context = await chromium.launchPersistentContext(
        CHROME_PROFILE_DIR, 
        {
            headless: false,
            channel: 'chrome',
            acceptDownloads: true,
            viewport: null, // Let the window maximize naturally
            ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
            args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
        }
    );

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
        // --- Step 1: Navigate & Authenticate ---
        console.log('🌐 Bringing FedEx Billing Online into view...');
        await page.goto(FBO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait to see if we are logged in or if we need to click "Log In"
        const loggedIn = await Promise.race([
            page.waitForSelector('text="Account Summary"', { timeout: 7000 }).then(() => true),
            page.waitForSelector('text="Search/Download"', { timeout: 7000 }).then(() => true),
            page.waitForSelector('a:has-text("Log in")', { timeout: 7000 }).then(async (el) => {
                console.log('🔐 Found Login button, navigating to login screen...');
                await el?.click();
                return false;
            }).catch(() => false)
        ]);

        if (!loggedIn) {
            console.log('\n======================================================');
            console.log('👤 ACTION REQUIRED: Not logged into FedEx yet.');
            console.log('👉 Since we enabled extensions, your 1Password is available!');
            console.log('👉 Please use it to log in as normal.');
            console.log('👉 DO NOT click anywhere else after logging in, just wait.');
            console.log('======================================================\n');
            
            // Wait for FBO dashboard elements indicating successful login
            await page.waitForSelector('text="Search/Download"', { timeout: 120_000 });
            console.log('🔓 Login successful, proceeding to Billing dashboard!');
        } else {
            console.log('🔓 Auto-login confirmed!');
        }

        // --- Step 2: Navigate to Download Section ---
        console.log('\n📄 Phase 2: Finding invoices...');
        await page.waitForTimeout(3000);

        try {
            const searchTab = await page.$('a:has-text("Search/Download")');
            if (searchTab) {
                console.log('👉 Clicking "Search/Download" tab...');
                await searchTab.click();
                await page.waitForTimeout(3000);
            }
        } catch (e: any) {
            console.log('⚠️ Could not click Search/Download automatically:', e.message);
        }

        // --- Step 3: Wait for Download ---
        console.log('\n======================================================');
        console.log('📥 Phase 3: Waiting for CSV Download.');
        console.log('👉 Please manually select your desired invoice on screen.');
        console.log('👉 Click "Download -> CSV".');
        console.log('👉 Sit back, the bot is listening and will pull and rename it instantly.');
        console.log('======================================================\n');

        const downloadPromise = page.waitForEvent('download', { timeout: 300_000 }); // 5 min
        const download = await downloadPromise;
        
        const suggestedName = download.suggestedFilename();
        console.log(`\n📦 Intercepted download: ${suggestedName}`);
        
        const safeName = suggestedName.endsWith('.csv') ? suggestedName : `FEDEX_${suggestedName}.csv`;
        const finalPath = path.join(SANDBOX_DIR, safeName);
        
        await download.saveAs(finalPath);
        
        console.log(`\n✅ SAVED: ${finalPath}`);
        console.log(`\n🎉 You can now run: node --import tsx src/cli/reconcile-fedex.ts`);

    } catch (err: any) {
        console.error('\n❌ Script encountered an error:', err.message);
    } finally {
        await context.close();
        console.log('🏁 Bot disconnected. Chrome closed.');
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
