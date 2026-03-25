/**
 * @file    route.ts
 * @purpose Headless ULINE ordering — adds items to ULINE cart via Playwright.
 *          Called from the Purchasing Panel's "Order on ULINE" button.
 *          Uses the Paste Items method on uline.com/Ordering/QuickOrder.
 * @author  Will / Antigravity
 * @created 2026-03-23
 * @updated 2026-03-23
 * @deps    playwright, finale/client
 * @env     ULINE_EMAIL, ULINE_PASSWORD
 */

import { NextRequest, NextResponse } from 'next/server';
import { chromium } from 'playwright';
import path from 'path';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────
const QUICK_ORDER_URL = 'https://www.uline.com/Ordering/QuickOrder';
const CHROME_PROFILE = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');

// DECISION(2026-03-16): Bidirectional SKU mapping.
// ULINE_TO_FINALE is the source of truth (from reconcile-uline.ts).
// FINALE_TO_ULINE is the reverse for ordering. Items not in this map
// use their Finale SKU directly (most match 1:1 with ULINE model numbers).
const ULINE_TO_FINALE: Record<string, string> = {
    'S-15837B': 'FJG101',
    'S-13505B': 'FJG102',
    'S-13506B': 'FJG103',
    'S-10748B': 'FJG104',
    'S-12229': '10113',
    'S-4551': 'ULS455',
    'H-1621': 'Ho-1621',
};
const FINALE_TO_ULINE: Record<string, string> = {};
for (const [uline, finale] of Object.entries(ULINE_TO_FINALE)) {
    FINALE_TO_ULINE[finale] = uline;
}

function toUlineModel(finaleId: string): string {
    return FINALE_TO_ULINE[finaleId] || finaleId;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface UlineOrderItem {
    productId: string;
    quantity: number;
}

interface UlineOrderResult {
    success: boolean;
    itemsAdded: number;
    message: string;
    errors?: string[];
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse<UlineOrderResult>> {
    try {
        const { items } = await req.json() as { items: UlineOrderItem[] };

        if (!Array.isArray(items) || items.length === 0) {
            return NextResponse.json(
                { success: false, itemsAdded: 0, message: 'No items provided' },
                { status: 400 }
            );
        }

        // Map Finale SKUs to ULINE model numbers
        const pasteLines = items.map(i => `${toUlineModel(i.productId)}, ${i.quantity}`);
        const pasteText = pasteLines.join('\n');

        console.log(`[uline-order] Adding ${items.length} items to ULINE cart (headless)...`);
        console.log(`[uline-order] Paste text:\n${pasteText}`);

        // DECISION(2026-03-23): Run headless with persistent Chrome profile so we
        // inherit ULINE login cookies. If login is required, auto-fill creds.
        // This needs Chrome to be CLOSED or use a separate profile directory.
        // Fallback: if persistent context fails (Chrome is open), try regular headless.
        let context;
        let usedPersistent = false;

        try {
            context = await chromium.launchPersistentContext(
                path.join(CHROME_PROFILE, 'Default'),
                {
                    headless: true,
                    channel: 'chrome',
                    acceptDownloads: true,
                    viewport: { width: 1280, height: 900 },
                    args: ['--disable-blink-features=AutomationControlled'],
                }
            );
            usedPersistent = true;
        } catch (persistErr) {
            // Chrome is likely open — try launching headless without persistent profile
            console.log(`[uline-order] Persistent context failed (Chrome open?), launching headless...`);
            const browser = await chromium.launch({
                headless: true,
                channel: 'chrome',
                args: ['--disable-blink-features=AutomationControlled'],
            });
            context = await browser.newContext({
                viewport: { width: 1280, height: 900 },
            });
        }

        const page = context.pages()[0] || await context.newPage();

        try {
            // Navigate to Quick Order
            await page.goto(QUICK_ORDER_URL, { waitUntil: 'load', timeout: 30_000 });

            // Detect page state: ready or login needed
            const landed = await Promise.race([
                page.waitForSelector('text=Paste Items Page', { timeout: 15_000 }).then(() => 'ready' as const),
                page.waitForSelector('#txtEmail', { timeout: 15_000 }).then(() => 'login' as const),
            ]).catch(() => 'unknown' as const);

            if (landed === 'login') {
                const email = process.env.ULINE_EMAIL;
                const password = process.env.ULINE_PASSWORD;
                if (!email || !password) {
                    await context.close();
                    return NextResponse.json(
                        { success: false, itemsAdded: 0, message: 'ULINE login required but ULINE_EMAIL/ULINE_PASSWORD not set in .env' },
                        { status: 500 }
                    );
                }
                console.log('[uline-order] Login required — filling credentials...');
                await page.fill('#txtEmail', email);
                await page.fill('#txtPassword', password);
                await page.click('#btnSignIn');
                await page.waitForSelector('text=Paste Items Page', { timeout: 30_000 });
            }

            if (landed === 'unknown') {
                await context.close();
                return NextResponse.json(
                    { success: false, itemsAdded: 0, message: 'Could not detect ULINE Quick Order page' },
                    { status: 500 }
                );
            }

            // Click "Paste Items Page" link
            await page.click('text=Paste Items Page');
            await page.waitForSelector('#txtPaste', { timeout: 10_000 });

            // Fill the textarea with items
            await page.fill('#txtPaste', pasteText);
            await page.waitForTimeout(500);

            // Click "Add to Cart" — try multiple selectors
            let addClicked = false;
            const selectors = [
                '#btnAddPastedItemsToCart',
                '#btnAddToCart',
                'input[type="submit"][value*="Add"]',
                'input[type="button"][value*="Add"]',
                'button:has-text("Add to Cart")',
                'input[value*="Add to Cart"]',
                'a:has-text("Add to Cart")',
                'input[value*="Add Items"]',
                'button:has-text("Add Items")',
            ];

            for (const sel of selectors) {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible().catch(() => false)) {
                    await btn.click();
                    addClicked = true;
                    break;
                }
            }

            // Fallback: role-based search
            if (!addClicked) {
                try {
                    const roleBtn = page.getByRole('button', { name: /add/i }).first();
                    if (await roleBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
                        await roleBtn.click();
                        addClicked = true;
                    }
                } catch { /* not found */ }
            }

            // Wait for cart to update
            await page.waitForTimeout(3_000);

            // Check for errors on the page
            const errors: string[] = [];
            const errorText = await page.$eval(
                '.error, .errorMessage, .alert-danger',
                el => el.textContent?.trim() || ''
            ).catch(() => '');
            if (errorText) errors.push(errorText);

            await context.close();

            if (addClicked) {
                console.log(`[uline-order] ✅ Added ${items.length} items to ULINE cart`);
                return NextResponse.json({
                    success: true,
                    itemsAdded: items.length,
                    message: `Added ${items.length} items to ULINE cart`,
                    errors: errors.length > 0 ? errors : undefined,
                });
            } else {
                return NextResponse.json({
                    success: false,
                    itemsAdded: 0,
                    message: 'Items were pasted but "Add to Cart" button was not found',
                    errors,
                });
            }
        } catch (err) {
            try { await context.close(); } catch { /* best effort */ }
            throw err;
        }
    } catch (err: any) {
        console.error('[uline-order] Error:', err.message);
        return NextResponse.json(
            { success: false, itemsAdded: 0, message: `ULINE order failed: ${err.message}` },
            { status: 500 }
        );
    }
}
