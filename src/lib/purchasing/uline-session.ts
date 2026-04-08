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
