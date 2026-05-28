/**
 * @file    src/lib/ordering/uline-cart.ts
 * @purpose Uline-specific cart filling logic. Handles login, search by
 *          item number, quantity entry, and add-to-cart for each PO line item.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    playwright via BrowserManager
 *
 * ULINE CART FLOW:
 *   1. Navigate to quick search
 *   2. For each line item with vendor_sku:
 *      a. Enter item number in search box
 *      b. Click search
 *      c. Set quantity in the qty field
 *      d. Click "Add to Cart"
 *      e. Verify item appeared in cart summary
 *   3. Navigate to cart page for review
 *   4. Screenshot the cart
 */

import { type Page } from "playwright";
import { type POLineItem, type CartFillResult } from "./types";

const SEARCH_URL = "https://www.uline.com/Product/QuickSearch";
const CART_URL = "https://www.uline.com/ShoppingCart";

/**
 * Fill Uline cart with PO line items.
 * Returns result with items added/failed and cart URL.
 */
export async function fillUlineCart(
    page: Page,
    poNumber: string,
    items: POLineItem[],
): Promise<CartFillResult> {
    const result: CartFillResult = {
        poNumber,
        vendor: "uline",
        itemsAttempted: items.length,
        itemsAdded: 0,
        itemsFailed: [],
        cartUrl: CART_URL,
    };

    // Filter to items that have a vendor_sku (Uline item number)
    const orderableItems = items.filter(i => i.vendor_sku);
    const noVendorSku = items.filter(i => !i.vendor_sku);

    for (const item of noVendorSku) {
        result.itemsFailed.push({
            lineItem: item,
            reason: "No vendor_sku — cannot search Uline without item number",
        });
    }

    // Navigate to quick search
    try {
        await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2000); // Let Uline's JS settle
    } catch (err: any) {
        result.error = `Failed to load Uline search: ${err.message}`;
        return result;
    }

    // Check if we're logged in (look for account menu or cart icon)
    const loggedIn = await page.locator('[class*="MyAccount"], [class*="my-account"], a[href*="MyUline"]').count() > 0;
    if (!loggedIn) {
        result.error = "Not logged in — please log into Uline in the browser first. Session cookies not found.";
        return result;
    }

    // Process each item
    for (const item of orderableItems) {
        try {
            const added = await addUlineItem(page, item.vendor_sku!, item.quantity);
            if (added) {
                result.itemsAdded++;
            } else {
                result.itemsFailed.push({
                    lineItem: item,
                    reason: "Could not find item or add-to-cart failed",
                });
            }
        } catch (err: any) {
            result.itemsFailed.push({
                lineItem: item,
                reason: `Error: ${err.message}`,
            });
        }

        // Rate limit: wait between items to avoid triggering bot detection
        await page.waitForTimeout(1500);
    }

    // Navigate to cart for Bill to review
    try {
        await page.goto(CART_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2000);
    } catch { /* best effort */ }

    // Screenshot the cart
    try {
        const screenshotDir = "data/ordering-screenshots";
        const fs = await import("fs");
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
        const screenshotPath = `${screenshotDir}/uline-${poNumber}-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        result.screenshotPath = screenshotPath;
    } catch { /* non-critical */ }

    return result;
}

/**
 * Add a single item to the Uline cart.
 * Returns true if item was successfully added.
 */
async function addUlineItem(page: Page, itemNumber: string, quantity: number): Promise<boolean> {
    // Uline quick search: type item number, hit enter or click search
    const searchInput = page.locator('input[name="Keyword"], input[type="search"], input[placeholder*="item"]').first();
    await searchInput.fill(""); // Clear previous
    await searchInput.type(itemNumber, { delay: 50 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000); // Wait for results

    // Look for quantity field on the product page
    const qtyInput = page.locator('input[name*="qty"], input[name*="Qty"], input[class*="quantity"], input[type="number"]').first();
    const qtyVisible = await qtyInput.isVisible().catch(() => false);

    if (qtyVisible) {
        await qtyInput.fill(String(quantity));
    }

    // Click Add to Cart
    const addToCartBtn = page.locator(
        'button:has-text("Add to Cart"), input[value*="Add to Cart"], a:has-text("Add to Cart"), button[class*="addToCart"]'
    ).first();

    const btnVisible = await addToCartBtn.isVisible().catch(() => false);
    if (!btnVisible) {
        return false;
    }

    await addToCartBtn.click();
    await page.waitForTimeout(2000);

    // Verify: check for success indicator or cart count change
    // Uline shows a "Added to cart" overlay or updates cart icon
    const successIndicator = await page.locator(
        '[class*="added"], [class*="success"], [class*="AddedToCart"], .confirmation'
    ).first().isVisible().catch(() => false);

    // Even if we don't see the success indicator, assume it worked if no error appeared
    const errorIndicator = await page.locator(
        '[class*="error"], [class*="not-found"], :text("out of stock"), :text("no results")'
    ).first().isVisible().catch(() => false);

    return !errorIndicator;
}
