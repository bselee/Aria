import { chromium, type BrowserContext, type Page } from "playwright";
import os from "os";
import path from "path";

const QUICK_ORDER_URL = "https://www.uline.com/Ordering/QuickOrder";
const CHROME_PROFILE = path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data");

export interface UlineSession {
    context: BrowserContext;
    close: () => Promise<void>;
}

export interface LaunchUlineSessionOptions {
    headless: boolean;
}

export async function launchUlineSession(opts: LaunchUlineSessionOptions): Promise<UlineSession> {
    try {
        const context = await chromium.launchPersistentContext(
            CHROME_PROFILE,
            {
                headless: opts.headless,
                channel: "chrome",
                acceptDownloads: true,
                viewport: { width: 1280, height: 900 },
                args: ["--profile-directory=Default", "--disable-blink-features=AutomationControlled"],
            },
        );
        return {
            context,
            close: async () => {
                await context.close();
            },
        };
    } catch {
        const browser = await chromium.launch({
            headless: opts.headless,
            channel: "chrome",
            args: ["--disable-blink-features=AutomationControlled"],
        });
        const context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
        });
        return {
            context,
            close: async () => {
                await context.close();
                await browser.close();
            },
        };
    }
}

export async function openUlineQuickOrder(page: Page): Promise<"ready" | "login"> {
    await page.goto(QUICK_ORDER_URL, { waitUntil: "load", timeout: 30_000 });

    const landed = await Promise.race([
        page.waitForSelector("text=Paste Items Page", { timeout: 15_000 }).then(() => "ready" as const).catch(() => null),
        page.waitForSelector("text=Catalog Quick Order", { timeout: 15_000 }).then(() => "ready" as const).catch(() => null),
        page.waitForSelector("#txtEmail", { timeout: 15_000 }).then(() => "login" as const).catch(() => null),
        page.waitForTimeout(15_000).then(() => "unknown" as const),
    ]);

    if (landed === "unknown") {
        throw new Error("Could not detect ULINE Quick Order page");
    }

    if (landed === "login") {
        const email = process.env.ULINE_EMAIL;
        const password = process.env.ULINE_PASSWORD;
        if (!email || !password) {
            throw new Error("ULINE login required but credentials are not configured");
        }

        await page.fill("#txtEmail", email);
        await page.fill("#txtPassword", password);
        await page.click("#btnSignIn");
        await page.waitForSelector("text=Paste Items Page", { timeout: 120_000 });
    }

    return landed;
}

export async function openUlinePasteItemsPage(page: Page): Promise<void> {
    await openUlineQuickOrder(page);
    await page.click("text=Paste Items Page");
    await page.waitForSelector("#txtPaste", { timeout: 10_000 });
}

export async function emailUlineCart(page: Page, email: string): Promise<string | null> {
    const CART_URL = "https://www.uline.com/Ordering/ViewCart";
    await page.goto(CART_URL, { waitUntil: "load", timeout: 30_000 });
    await page.waitForSelector("text=Shopping Cart", { timeout: 15_000 }).catch(() => {});

    const shareBtn = page.locator("button:has-text('Share'), a:has-text('Share'), [aria-label*='Share'], [title*='Share']").first();
    if (!(await shareBtn.isVisible().catch(() => false))) {
        console.log("   ⚠️ Share button not found on cart page");
        return null;
    }
    await shareBtn.click();
    await page.waitForTimeout(1_500);

    const emailBtn = page.locator("text=Email Cart, text=Email Shopping Cart, button:has-text('Email')").first();
    if (!(await emailBtn.isVisible().catch(() => false))) {
        console.log("   ⚠️ Email Cart option not visible after clicking Share");
        return null;
    }
    await emailBtn.click();
    await page.waitForTimeout(1_500);

    const emailInput = page.locator("input[type='email'], input#email, input[name*='email'], input[placeholder*='email']").first();
    if (!(await emailInput.isVisible().catch(() => false))) {
        console.log("   ⚠️ Email input not found in share modal");
        return null;
    }
    await emailInput.fill(email);

    const submitBtn = page.locator("button:has-text('Send'), button:has-text('Submit'), input[type='submit']").first();
    if (!(await submitBtn.isVisible().catch(() => false))) {
        console.log("   ⚠️ Send/Submit button not found in share modal");
        return null;
    }
    await submitBtn.click();
    await page.waitForTimeout(3_000);

    const cartLink = await page.locator("[href*='LoadCart'], [href*='cart'], .cart-link, .share-url, input[readonly]").evaluateAll(els =>
        els.map(el => el instanceof HTMLInputElement ? el.value : el.getAttribute('href')).filter(Boolean)
    ).catch(() => []);

    const url = (cartLink?.[0] as string | null) ?? null;
    console.log(`   ✅ Cart emailed to ${email}${url ? ` | Link: ${url}` : ''}`);
    return url;
}

export interface UlineOrderHistoryEntry {
    orderDate: string;
    quantity: number;
    total: number | null;
}

export async function checkUlineOrderHistory(
    page: Page,
    model: string,
): Promise<UlineOrderHistoryEntry[] | null> {
    const HISTORY_URL = `https://www.uline.com/Orders/OrderHistory?SearchTerm=${encodeURIComponent(model)}`;
    try {
        await page.goto(HISTORY_URL, { waitUntil: "load", timeout: 30_000 });
        await page.waitForSelector("table, .order-table, .order-list, text=Order History", { timeout: 15_000 }).catch(() => {});

        const rows = await page.locator("table tr, .order-row, .order-item, tr[class*='order']").evaluateAll((elements) => {
            return elements.map(el => ({
                text: (el.textContent || "").replace(/\s+/g, " ").trim(),
                qtyMatch: (el.textContent || "").match(/\b(\d[\d,]*)\s*(?:units?|qty|each|item)/i),
            }));
        });

        const entries: UlineOrderHistoryEntry[] = [];
        for (const row of rows) {
            const modelMatch = row.text.includes(model);
            const qtyMatch = row.qtyMatch ? Number(row.qtyMatch[1].replace(/,/g, "")) : null;
            if (modelMatch && qtyMatch) {
                const dateMatch = row.text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);
                const totalMatch = row.text.match(/\$?([\d,]+\.\d{2})/);
                entries.push({
                    orderDate: dateMatch ? dateMatch[0] : "unknown",
                    quantity: qtyMatch,
                    total: totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : null,
                });
            }
        }

        if (entries.length === 0) return null;
        return entries;
    } catch {
        return null;
    }
}

export async function validateLargeQuantityAgainstHistory(
    page: Page,
    items: Array<{ ulineModel: string; quantity: number }>,
    threshold: number = 2000,
): Promise<Map<string, { requested: number; history: UlineOrderHistoryEntry[]; isAbnormal: boolean }>> {
    const results = new Map<string, { requested: number; history: UlineOrderHistoryEntry[]; isAbnormal: boolean }>();

    for (const item of items) {
        if (item.quantity < threshold) continue;
        const history = await checkUlineOrderHistory(page, item.ulineModel);
        if (!history || history.length === 0) {
            results.set(item.ulineModel, { requested: item.quantity, history: [], isAbnormal: true });
            continue;
        }
        const avgQty = history.reduce((s, h) => s + h.quantity, 0) / history.length;
        const isAbnormal = item.quantity > avgQty * 3;
        results.set(item.ulineModel, { requested: item.quantity, history, isAbnormal });
    }

    return results;
}

export interface UlinePendingOrder {
    orderNumber: string;
    poNumber: string | null;
    orderDate: string;
    status: string;
    itemCount: number;
    total: number | null;
    shipDate: string | null;
    items: Array<{
        model: string;
        description: string;
        qty: number;
        unitPrice: number;
        extendedPrice: number;
    }>;
}

function extractTextFromHtml(html: string): string {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

export async function scrapeUlinePendingOrders(page: Page): Promise<UlinePendingOrder[]> {
    const ORDER_STATUS_URL = 'https://www.uline.com/Orders/OrderStatus';
    try {
        await page.goto(ORDER_STATUS_URL, { waitUntil: 'load', timeout: 30000 });
        await page.waitForSelector('table, .order-table, text=Order Status, text=Pending', { timeout: 15000 }).catch(() => {});

        const orders: UlinePendingOrder[] = [];

        const rows = await page.locator('table tr, .order-row, .order-item, tr[class*="order"], tr[class*="pending"]').evaluateAll((elements) => {
            return elements.map(el => ({
                text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
                html: el.innerHTML,
            }));
        });

        let currentOrder: Partial<UlinePendingOrder> | null = null;
        for (const row of rows) {
            const text = row.text;
            
            const orderMatch = text.match(/(?:ORDER\s*#|Order\s*Number)[:\s]*(\d+)/i);
            const poMatch = text.match(/PO\s*#?\s*(\d+)/i);
            const statusMatch = text.match(/(?:STATUS|Status)[:\s]*([\w\s]+?)(?:\s{2,}|$)/i);
            const totalMatch = text.match(/\$\s*([\d,]+\.\d{2})/g);
            const dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
            const itemMatch = text.match(/^(\d+)\s+(?:EA|RL|CT)\s+([A-Z]\-\d+[A-Z]?)\s+(.+?)\s+[\d\.]+\s+[\d\.]+$/);

            if (orderMatch && !statusMatch) {
                if (currentOrder?.orderNumber) orders.push(currentOrder as UlinePendingOrder);
                currentOrder = {
                    orderNumber: orderMatch[1],
                    poNumber: poMatch?.[1] || null,
                    orderDate: dateMatch?.[1] || '',
                    status: 'pending',
                    itemCount: 0,
                    total: totalMatch ? Number(totalMatch[totalMatch.length - 1].replace(/[^\d.]/g, '')) : null,
                    shipDate: null,
                    items: [],
                };
            } else if (currentOrder && itemMatch) {
                const qty = Number(itemMatch[1]);
                const model = itemMatch[2];
                const desc = itemMatch[3].trim();
                const extPrice = totalMatch && totalMatch.length > 0
                    ? Number(totalMatch[totalMatch.length - 1].replace(/[^\d.]/g, ''))
                    : null;
                currentOrder.items.push({
                    model,
                    description: desc,
                    qty,
                    unitPrice: extPrice && qty ? extPrice / qty : 0,
                    extendedPrice: extPrice || 0,
                });
                currentOrder.itemCount = (currentOrder.itemCount || 0) + qty;
            } else if (text.toLowerCase().includes('ship') && dateMatch && currentOrder) {
                currentOrder.shipDate = dateMatch[1];
            }
        }
        if (currentOrder?.orderNumber) orders.push(currentOrder as UlinePendingOrder);
        return orders;
    } catch (err) {
        console.log('scrapeUlinePendingOrders error:', (err as Error).message);
        return [];
    }
}

export async function getUlineSessionForScraping(headless: boolean = true) {
    let session: UlineSession;
    let browser: any;
    try {
        session = await launchUlineSession({ headless });
    } catch {
        browser = await chromium.launch({
            headless,
            channel: 'chrome',
            args: ['--disable-blink-features=AutomationControlled'],
        });
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        session = { context: ctx, close: async () => { await ctx.close(); await browser.close(); } };
    }
    return session;
}
