import { chromium, type BrowserContext, type Page } from "playwright";
import os from "os";
import path from "path";

const SUSTAINABLE_VILLAGE_LOGIN_URL = "https://account.sustainablevillage.com/orders?locale=en&region_country=US";
const SUSTAINABLE_VILLAGE_STOREFRONT_URL = "https://sustainablevillage.com";
const CHROME_PROFILE = path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data");

export interface SustainableVillageSession {
    context: BrowserContext;
    close: () => Promise<void>;
}

export interface LaunchSustainableVillageSessionOptions {
    headless: boolean;
}

export async function launchSustainableVillageSession(
    options: LaunchSustainableVillageSessionOptions = { headless: true },
): Promise<SustainableVillageSession> {
    const email = process.env.SUSTAINABLE_VILLAGE_EMAIL;
    const password = process.env.SUSTAINABLE_VILLAGE_PASSWORD;

    if (email && password) {
        const browser = await chromium.launch({
            headless: options.headless,
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

    try {
        const context = await chromium.launchPersistentContext(
            path.join(CHROME_PROFILE, "Default"),
            {
                headless: options.headless,
                channel: "chrome",
                acceptDownloads: true,
                viewport: { width: 1280, height: 900 },
                args: ["--disable-blink-features=AutomationControlled"],
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
            headless: options.headless,
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

export async function openSustainableVillageAccount(page: Page): Promise<void> {
    await page.goto(SUSTAINABLE_VILLAGE_LOGIN_URL, { waitUntil: "load", timeout: 30_000 });
}

export async function openSustainableVillageStorefrontCart(page: Page): Promise<void> {
    await page.goto(`${SUSTAINABLE_VILLAGE_STOREFRONT_URL}/cart`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
    });
}
