/**
 * uline-order-service.ts — ULINE cart fill service for the Friday dashboard flow.
 *
 * Three-layer strategy:
 *   1. CDP + Stagehand AI   — connects to running Chrome, AI-powered interaction (resilient)
 *   2. Cookies + Stagehand  — headless browser with .uline-session.json, AI interaction
 *   3. Cookies + Selectors  — headless browser with manual Playwright selectors (fallback)
 *
 * Auth: cookie-based via .uline-session.json (exported from Chrome DevTools F12).
 * No automated ULINE login — bot detection blocks it.
 */
import path from "path";
import fs from "fs";
import http from "http";

import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

import { FinaleClient } from "@/lib/finale/client";
import { BrowserManager } from "@/lib/scraping/browser-manager";
import { verifyUlineCart } from "@/cli/order-uline-cart";
import {
    diffObservedUlineCartRows,
    scrapeObservedUlineCartRows,
    syncVerifiedUlineCartPricesToDraftPO,
} from "@/lib/purchasing/uline-cart-live";
import { convertFinaleItemToUlineOrder } from "@/lib/purchasing/uline-ordering";

export interface UlineOrderItem {
    productId: string;
    quantity: number;
    unitPrice?: number;
}

export interface UlineOrderResult {
    success: boolean;
    itemsAdded: number;
    message: string;
    priceUpdatesApplied?: number;
    errors?: string[];
    strategy?: string;
}

const ULINE_SESSION_FILE = path.resolve(process.cwd(), ".uline-session.json");
const QUICK_ORDER_URL = "https://www.uline.com/Ordering/QuickOrder";
const CDP_PORT = 9222;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function isCDPAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${CDP_PORT}/json`, { timeout: 1000 }, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
    });
}

function hasSessionFile(): boolean {
    try {
        if (!fs.existsSync(ULINE_SESSION_FILE)) return false;
        const data = JSON.parse(fs.readFileSync(ULINE_SESSION_FILE, "utf-8"));
        return Array.isArray(data) ? data.length > 0 : !!(data.cookies?.length);
    } catch {
        return false;
    }
}

// ── Strategy 1 & 2: Stagehand (AI-powered) ──────────────────────────────────

const UlineCartItemSchema = z.object({
    model: z.string().describe("ULINE model/item number (e.g. S-12345)"),
    quantity: z.number().describe("Quantity in cart"),
    unitPrice: z.number().optional().describe("Unit price if visible"),
});

const UlineCartSchema = z.object({
    items: z.array(UlineCartItemSchema),
    subtotal: z.number().optional(),
});

async function runWithStagehand(
    pasteText: string,
    convertedItems: any[],
    draftPO: string | null | undefined,
    useCDP: boolean,
): Promise<UlineOrderResult> {
    const stagehand = new Stagehand({
        env: "LOCAL",
        model: { model: "anthropic/claude-haiku-4-5-20251001" },
        localBrowserLaunchOptions: useCDP
            ? { cdpUrl: `http://localhost:${CDP_PORT}` }
            : { headless: true },
        verbose: 0,
        disableAPI: true,
        disablePino: true,
    });

    await stagehand.init();
    const strategy = useCDP ? "stagehand+cdp" : "stagehand+cookies";

    try {
        const pages = stagehand.context.pages();
        const page = pages[0];

        // If headless (no CDP), inject cookies before navigating
        if (!useCDP && hasSessionFile()) {
            try {
                const raw = JSON.parse(fs.readFileSync(ULINE_SESSION_FILE, "utf-8"));
                const cookies = Array.isArray(raw) ? raw : raw.cookies || [];
                if (cookies.length > 0) {
                    // Access the underlying CDP to set cookies
                    const cdpSession = await page.context().newCDPSession(page);
                    for (const cookie of cookies) {
                        await cdpSession.send("Network.setCookie", {
                            name: cookie.name,
                            value: cookie.value,
                            domain: cookie.domain || ".uline.com",
                            path: cookie.path || "/",
                            secure: cookie.secure ?? true,
                            httpOnly: cookie.httpOnly ?? false,
                        }).catch(() => {});
                    }
                    console.log(`[uline-order] Injected ${cookies.length} cookies from ${ULINE_SESSION_FILE}`);
                }
            } catch (err: any) {
                console.warn(`[uline-order] Cookie injection failed: ${err.message}`);
            }
        }

        // Navigate to Quick Order
        await page.goto(QUICK_ORDER_URL, { waitUntil: "load", timeout: 30_000 });

        // Check if we hit login page
        const isLogin = await page.waitForSelector("#txtEmail", { timeout: 5_000 }).then(() => true).catch(() => false);
        if (isLogin) {
            throw new Error(
                "ULINE session expired. Refresh .uline-session.json from Chrome DevTools:\n" +
                "  1. Open Chrome → uline.com (make sure you're logged in)\n" +
                "  2. F12 → Application → Cookies → https://www.uline.com\n" +
                "  3. Copy all cookies → Save as .uline-session.json",
            );
        }

        // AI-powered: click through to Paste Items Page
        await stagehand.act("click the 'Paste Items Page' link or tab", { page });
        await page.waitForSelector("#txtPaste", { timeout: 10_000 });

        // Manual scrape for before-state (known selectors, fast)
        const beforeRows = await scrapeObservedUlineCartRows(page);

        // Paste items (direct — known stable selector)
        await page.fill("#txtPaste", pasteText);
        await page.waitForTimeout(500);

        // AI-powered: click Add to Cart (replaces 9-selector fallback chain)
        const addResult = await stagehand.act(
            "click the button to add the pasted items to the shopping cart",
            { page },
        );
        console.log(`[uline-order] Stagehand act result: ${addResult.success ? "success" : "failed"} — ${addResult.message}`);

        await page.waitForTimeout(3_000);

        // Verify cart using existing proven logic
        const observedRows = addResult.success
            ? diffObservedUlineCartRows(beforeRows, await scrapeObservedUlineCartRows(page))
            : [];
        const verification = verifyUlineCart(convertedItems, observedRows);

        const errors: string[] = [];
        const errorText = await page.$eval(
            ".error, .errorMessage, .alert-danger",
            (el: any) => el.textContent?.trim() || "",
        ).catch(() => "");
        if (errorText) errors.push(errorText);

        console.log(`[uline-order] ${strategy} | Act: ${addResult.success} | Verification: ${verification.status} | Rows: ${observedRows.length}`);

        if (!addResult.success) {
            return {
                success: false, itemsAdded: 0, strategy,
                message: `Stagehand could not click Add to Cart: ${addResult.message}`,
                errors,
            };
        }

        if (verification.status !== "verified") {
            return {
                success: false, itemsAdded: 0, strategy,
                message: `Cart verification: ${verification.status}. ${errors[0] || "Review cart manually."}`,
                priceUpdatesApplied: 0,
                errors: errors.length > 0 ? errors : undefined,
            };
        }

        let priceUpdatesApplied = 0;
        if (draftPO) {
            const finale = new FinaleClient();
            priceUpdatesApplied = await syncVerifiedUlineCartPricesToDraftPO(
                finale, draftPO, convertedItems, observedRows, verification,
            );
        }

        const priceMessage = priceUpdatesApplied > 0
            ? ` Applied ${priceUpdatesApplied} price update(s) to draft PO ${draftPO}.`
            : "";

        return {
            success: true,
            itemsAdded: convertedItems.length,
            message: `Added ${convertedItems.length} verified item(s) to ULINE cart.${priceMessage}`.trim(),
            priceUpdatesApplied, strategy,
            errors: errors.length > 0 ? errors : undefined,
        };
    } finally {
        await stagehand.close().catch(() => {});
    }
}

// ── Strategy 3: BrowserManager + manual selectors (fallback) ─────────────────

async function runWithSelectors(
    pasteText: string,
    convertedItems: any[],
    draftPO: string | null | undefined,
): Promise<UlineOrderResult> {
    const manager = BrowserManager.getInstance();
    const page = await manager.launchBrowser({
        headless: true,
        cookiesPath: ULINE_SESSION_FILE,
    });
    const strategy = "selectors+cookies";

    try {
        await page.goto(QUICK_ORDER_URL, { waitUntil: "load", timeout: 30_000 });

        const landed = await Promise.race([
            page.waitForSelector("text=Paste Items Page", { timeout: 15_000 }).then(() => "ready" as const).catch(() => null),
            page.waitForSelector("text=Catalog Quick Order", { timeout: 15_000 }).then(() => "ready" as const).catch(() => null),
            page.waitForSelector("#txtEmail", { timeout: 15_000 }).then(() => "login" as const).catch(() => null),
            page.waitForTimeout(15_000).then(() => "unknown" as const),
        ]);

        if (landed === "login") {
            throw new Error("ULINE session expired. Refresh .uline-session.json from Chrome DevTools.");
        }
        if (landed === "unknown") {
            throw new Error("Could not detect ULINE Quick Order page after 15s");
        }

        const pasteLink = page.locator("text=Paste Items Page").first();
        if (await pasteLink.isVisible().catch(() => false)) {
            await pasteLink.click();
        }
        await page.waitForSelector("#txtPaste", { timeout: 10_000 });

        const beforeRows = await scrapeObservedUlineCartRows(page);
        await page.fill("#txtPaste", pasteText);
        await page.waitForTimeout(500);

        let addClicked = false;
        for (const selector of [
            "#btnAddPastedItemsToCart", "#btnAddToCart",
            "input[type=\"submit\"][value*=\"Add\"]", "input[type=\"button\"][value*=\"Add\"]",
            "button:has-text(\"Add to Cart\")", "input[value*=\"Add to Cart\"]",
            "a:has-text(\"Add to Cart\")", "input[value*=\"Add Items\"]",
            "button:has-text(\"Add Items\")",
        ]) {
            const button = await page.$(selector);
            if (button && await button.isVisible().catch(() => false)) {
                await button.click();
                addClicked = true;
                break;
            }
        }

        if (!addClicked) {
            try {
                const roleButton = page.getByRole("button", { name: /add/i }).first();
                if (await roleButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
                    await roleButton.click();
                    addClicked = true;
                }
            } catch { /* no-op */ }
        }

        await page.waitForTimeout(3_000);

        const errors: string[] = [];
        const observedRows = addClicked
            ? diffObservedUlineCartRows(beforeRows, await scrapeObservedUlineCartRows(page))
            : [];
        const verification = verifyUlineCart(convertedItems, observedRows);
        const errorText = await page.$eval(
            ".error, .errorMessage, .alert-danger",
            (el: any) => el.textContent?.trim() || "",
        ).catch(() => "");
        if (errorText) errors.push(errorText);

        if (!addClicked) {
            return { success: false, itemsAdded: 0, strategy, message: "Add to Cart button not found", errors };
        }

        if (verification.status !== "verified") {
            return {
                success: false, itemsAdded: 0, strategy,
                message: `Cart verification: ${verification.status}. ${errors[0] || "Review cart manually."}`,
                priceUpdatesApplied: 0, errors: errors.length > 0 ? errors : undefined,
            };
        }

        let priceUpdatesApplied = 0;
        if (draftPO) {
            const finale = new FinaleClient();
            priceUpdatesApplied = await syncVerifiedUlineCartPricesToDraftPO(
                finale, draftPO, convertedItems, observedRows, verification,
            );
        }

        const priceMessage = priceUpdatesApplied > 0
            ? ` Applied ${priceUpdatesApplied} price update(s) to draft PO ${draftPO}.`
            : "";

        return {
            success: true,
            itemsAdded: convertedItems.length,
            message: `Added ${convertedItems.length} verified item(s) to ULINE cart.${priceMessage}`.trim(),
            priceUpdatesApplied, strategy,
            errors: errors.length > 0 ? errors : undefined,
        };
    } finally {
        await manager.destroy().catch(() => {});
    }
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function runUlineOrder(params: {
    items: UlineOrderItem[];
    draftPO?: string | null;
}): Promise<UlineOrderResult> {
    const { items, draftPO } = params;

    if (!Array.isArray(items) || items.length === 0) {
        return { success: false, itemsAdded: 0, message: "No items provided" };
    }

    const convertedItems = items.map(item => convertFinaleItemToUlineOrder({
        finaleSku: item.productId,
        finaleEachQuantity: item.quantity,
        finaleUnitPrice: item.unitPrice ?? 0,
        description: item.productId,
    }));

    const blockingWarnings = convertedItems.flatMap(item =>
        item.guardrailWarnings.filter(warning =>
            warning.includes("exceeds the") || warning.includes("BLOCKING GUARDRAIL"),
        ),
    );
    if (blockingWarnings.length > 0) {
        return {
            success: false, itemsAdded: 0,
            message: `ULINE guardrail blocked the order: ${blockingWarnings[0]}`,
            errors: blockingWarnings,
        };
    }

    const pasteText = convertedItems.map(item => `${item.ulineModel}, ${item.quantity}`).join("\n");
    console.log(`[uline-order] Adding ${convertedItems.length} items to ULINE cart...`);
    console.log(`[uline-order] Paste text:\n${pasteText}`);

    const cdpAvailable = await isCDPAvailable();
    const hasCookies = hasSessionFile();

    // Strategy cascade: Stagehand+CDP → Stagehand+cookies → selectors+cookies
    if (cdpAvailable) {
        console.log("[uline-order] Strategy: Stagehand + CDP (running Chrome)");
        try {
            return await runWithStagehand(pasteText, convertedItems, draftPO, true);
        } catch (err: any) {
            console.warn(`[uline-order] Stagehand+CDP failed: ${err.message}. Falling back...`);
        }
    }

    if (hasCookies) {
        console.log("[uline-order] Strategy: Stagehand + cookies (.uline-session.json)");
        try {
            return await runWithStagehand(pasteText, convertedItems, draftPO, false);
        } catch (err: any) {
            console.warn(`[uline-order] Stagehand+cookies failed: ${err.message}. Falling back to selectors...`);
            // Final fallback: manual selectors
            try {
                return await runWithSelectors(pasteText, convertedItems, draftPO);
            } catch (err2: any) {
                return { success: false, itemsAdded: 0, message: `All strategies failed. Last: ${err2.message}` };
            }
        }
    }

    return {
        success: false,
        itemsAdded: 0,
        message: "No ULINE session available. Either:\n" +
            "  1. Start Chrome with --remote-debugging-port=9222 (recommended)\n" +
            "  2. Export cookies to .uline-session.json from Chrome DevTools (F12 → Application → Cookies)",
    };
}
