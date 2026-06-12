/**
 * @file    uline-cart-manager.ts
 * @purpose Playwright-based manager for interacting with the Uline shopping cart.
 *          Supports cookie reuse from .uline-session.json, add-to-cart,
 *          cart extraction, and emptiness checks.
 *
 * @author  Aria
 * @created 2026-06-12
 */

import { BrowserManager, BrowserOptions } from '../scraping/browser-manager';
import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { ConvertedUlineOrderItem } from '../purchasing/uline-ordering';

const ULNINE_SESSION_PATH = path.join(process.cwd(), '.uline-session.json');

export class UlineCartManager {
    private browserManager = BrowserManager.getInstance();
    private page: Page | null = null;

    private async ensurePage(): Promise<Page> {
        if (this.page) return this.page;

        const options: BrowserOptions = {
            headless: false,
            cookiesPath: ULNINE_SESSION_PATH,
            saveCookiesOnClose: true,
            useBrowserbase: false,
        };

        const context = await this.browserManager.getContext(options);
        this.page = await context.newPage();
        return this.page;
    }

    /**
     * Check if the Uline cart is empty.
     */
    async isCartEmpty(): Promise<boolean> {
        const page = await this.ensurePage();
        await page.goto('https://www.uline.com/Product/ViewCart', { waitUntil: 'domcontentloaded' });

        const emptyText = await page.locator('text=Your cart is currently empty').count();
        return emptyText > 0;
    }

    /**
     * Add multiple items to the Uline cart.
     * Navigates to each product detail page and adds the converted quantity.
     */
    async addItemsToCart(items: ConvertedUlineOrderItem[]): Promise<void> {
        const page = await this.ensurePage();

        for (const item of items) {
            const model = item.ulineModel || item.finaleSku;
            const qty = item.quantity;

            // Uline product detail URL pattern
            const productUrl = `https://www.uline.com/Product/Detail/${model}`;

            try {
                await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

                // Look for quantity input near the ADD button
                const qtyInput = page.locator('input[type="text"]').first();
                await qtyInput.fill(String(qty));

                // Click the ADD button (usually a link or button with text "ADD")
                const addButton = page.locator('a:has-text("ADD"), button:has-text("ADD")').first();
                await addButton.click();

                // Small delay to allow cart update
                await page.waitForTimeout(800);
                console.log(`[UlineCartManager] Added ${qty} × ${model}`);
            } catch (err: any) {
                console.warn(`[UlineCartManager] Failed to add ${model}: ${err.message}`);
            }
        }
    }

    /**
     * Extract current cart contents (simplified).
     * For full extraction, use the existing uline-cart.ts logic.
     */
    async getCurrentCart(): Promise<any[]> {
        // For now, return empty. Full implementation would parse the cart table.
        // This can delegate to existing cart extraction code later.
        return [];
    }

    async close(): Promise<void> {
        if (this.page) {
            await this.page.close();
            this.page = null;
        }
    }
}
