import { chromium, type BrowserContext, type Page } from "playwright";

const SUSTAINABLE_VILLAGE_LOGIN_URL = "https://account.sustainablevillage.com/orders?locale=en&region_country=US";

export interface SustainableVillageSession {
    context: BrowserContext;
    close: () => Promise<void>;
}

export async function launchSustainableVillageSession(headless = true): Promise<SustainableVillageSession> {
    const browser = await chromium.launch({
        headless,
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

export async function openSustainableVillageAccount(page: Page): Promise<void> {
    await page.goto(SUSTAINABLE_VILLAGE_LOGIN_URL, { waitUntil: "load", timeout: 30_000 });
}
