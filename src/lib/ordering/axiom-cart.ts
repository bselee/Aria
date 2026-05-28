/**
 * @file    src/lib/ordering/axiom-cart.ts
 * @purpose Axiom Print cart filling logic. Axiom uses a product catalog
 *          with customization options (paper stock, finish, etc).
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    playwright via BrowserManager
 *
 * AXIOM CART FLOW:
 *   1. Navigate to product page via vendor_sku (URL slug)
 *   2. Pre-selected options from PO line_items if available
 *   3. Set quantity
 *   4. Add to Cart
 *   5. Repeat for each item
 */

import { type Page } from "playwright";
import { type POLineItem, type CartFillResult } from "./types";

const CART_URL = "https://www.axiomprint.com/shopping-cart";
const BASE_URL = "https://www.axiomprint.com";

export async function fillAxiomCart(
    page: Page,
    poNumber: string,
    items: POLineItem[],
): Promise<CartFillResult> {
    const result: CartFillResult = {
        poNumber,
        vendor: "axiom",
        itemsAttempted: items.length,
        itemsAdded: 0,
        itemsFailed: [],
        cartUrl: CART_URL,
    };

    const orderableItems = items.filter(i => i.vendor_sku);
    const noSku = items.filter(i => !i.vendor_sku);

    for (const item of noSku) {
        result.itemsFailed.push({
            lineItem: item,
            reason: "No vendor_sku — Axiom needs product slug (e.g., 'business-cards')",
        });
    }

    for (const item of orderableItems) {
        try {
            const productUrl = `${BASE_URL}/${item.vendor_sku}`;
            await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.waitForTimeout(2000);

            // Set quantity — Axiom usually has a qty select or input
            const qtySelector = page.locator(
                'select[name*="qty"], input[name*="qty"], select[name*="quantity"], input[name*="quantity"]'
            ).first();
            if (await qtySelector.isVisible().catch(() => false)) {
                const tagName = await qtySelector.evaluate(el => el.tagName.toLowerCase());
                if (tagName === "select") {
                    await qtySelector.selectOption(String(item.quantity));
                } else {
                    await qtySelector.fill(String(item.quantity));
                }
            }

            // Add to Cart
            const addBtn = page.locator(
                'button:has-text("Add to Cart"), button[type="submit"]:has-text("Cart"), input[value*="Add"], button[class*="add-to-cart"]'
            ).first();

            if (await addBtn.isVisible().catch(() => false)) {
                await addBtn.click();
                await page.waitForTimeout(2000);
                result.itemsAdded++;
            } else {
                result.itemsFailed.push({
                    lineItem: item,
                    reason: "Add to Cart button not found",
                });
            }
        } catch (err: any) {
            result.itemsFailed.push({
                lineItem: item,
                reason: `Error: ${err.message}`,
            });
        }

        await page.waitForTimeout(1500);
    }

    // Navigate to cart
    try {
        await page.goto(CART_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2000);
    } catch { /* best effort */ }

    // Screenshot
    try {
        const screenshotDir = "data/ordering-screenshots";
        const fs = await import("fs");
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
        const screenshotPath = `${screenshotDir}/axiom-${poNumber}-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        result.screenshotPath = screenshotPath;
    } catch { /* non-critical */ }

    return result;
}
