/**
 * @file    fetch-fedex-csv.ts
 * @purpose Download invoice CSV from FedEx Billing Online into Aria statements.
 *          Uses a dedicated Chrome profile (never the live User Data; never taskkill).
 *          Automates Search/Download → CSV when possible; waits for login if needed.
 * @author  Hermia
 * @created 2026-03-16
 * @updated 2026-08-05 — full auto download path; no Chrome kill
 * @deps    playwright, fedex-acquisition
 * @env     FEDEX_BILLING_USER, FEDEX_BILLING_PASS (optional auto-login);
 *          interactive login still works if env unset or MFA needed
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/cli/fetch-fedex-csv.ts
 *   node --env-file=.env.local --import tsx src/cli/fetch-fedex-csv.ts --probe-only
 *   node --env-file=.env.local --import tsx src/cli/fetch-fedex-csv.ts --json
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { chromium, type Page, type BrowserContext } from "playwright";
import path from "path";
import os from "os";
import fs from "fs";
import { pathToFileURL } from "url";
import {
    ensureFedexStatementDir,
    writeFedexAcquisitionStatus,
    archiveFedexCsvToAria,
} from "@/lib/statements/fedex-acquisition";

// Never taskkill the user's Chrome. Dedicated profile only.
const FBO_URL = "https://www.fedex.com/en-us/billing-online.html";
const CHROME_PROFILE_DIR = path.join(
    os.homedir(),
    "AppData",
    "Local",
    "Aria",
    "chrome-profiles",
    "fedex-billing",
);
const FEDEX_STATEMENT_DIR = ensureFedexStatementDir();
const SANDBOX_DIR = path.join(os.homedir(), "OneDrive", "Desktop", "Sandbox");
const LOGIN_WAIT_MS = Math.max(5_000, Number(process.env.FEDEX_LOGIN_WAIT_SEC || 180) * 1000);
const DOWNLOAD_WAIT_MS = 120_000;

export interface FedexDownloadResult {
    success: boolean;
    mode: "probe" | "playwright_download" | "failed";
    startedAt: string;
    finishedAt: string;
    detectedState?: "logged_in" | "login_required" | "unknown";
    sourcePath?: string | null;
    savedPath?: string | null;
    message: string;
    error?: string | null;
}

async function sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

async function clickFirst(
    page: Page,
    selectors: string[],
    label: string,
): Promise<boolean> {
    for (const sel of selectors) {
        try {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) {
                await loc.click({ timeout: 5000 });
                console.log(`   clicked: ${label} (${sel})`);
                return true;
            }
        } catch {
            /* try next */
        }
    }
    return false;
}

async function isLoggedIn(page: Page): Promise<boolean> {
    const markers = [
        'text=Account Summary',
        'text=Search/Download',
        'text=Search / Download',
        'a:has-text("Search/Download")',
        'text=Invoice',
        '[data-testid*="account"]',
    ];
    for (const m of markers) {
        if (await page.locator(m).first().isVisible({ timeout: 1500 }).catch(() => false)) {
            return true;
        }
    }
    return false;
}

async function needsLogin(page: Page): Promise<boolean> {
    const markers = [
        'a:has-text("Log in")',
        'button:has-text("Log in")',
        'text=Sign In',
        'text=User ID',
        'input[name*="user"]',
        'input[type="password"]',
    ];
    for (const m of markers) {
        if (await page.locator(m).first().isVisible({ timeout: 1200 }).catch(() => false)) {
            return true;
        }
    }
    return false;
}

/**
 * Attempt FBO login with FEDEX_BILLING_USER / FEDEX_BILLING_PASS.
 * Returns true if post-login markers appear. Never logs credentials.
 */
async function tryEnvLogin(page: Page): Promise<boolean> {
    const primaryUser = (process.env.FEDEX_BILLING_USER || "").trim();
    const primaryPass = process.env.FEDEX_BILLING_PASS || "";
    const altUser = (process.env.FEDEX_BILLING_USER_ALT || "").trim();
    const altPass = process.env.FEDEX_BILLING_PASS_ALT || "";

    const attempts: Array<{ user: string; pass: string; label: string }> = [];
    if (primaryUser && primaryPass) attempts.push({ user: primaryUser, pass: primaryPass, label: "primary" });
    if (altUser && altPass) attempts.push({ user: altUser, pass: altPass, label: "alt" });
    if (attempts.length === 0) {
        console.log("No FEDEX_BILLING_USER/PASS in env — skipping auto-login.");
        return false;
    }

    for (const attempt of attempts) {
        console.log(`Attempting auto-login (${attempt.label}) as ${attempt.user}...`);

        // Landing page may only show "Log in" CTA before the form.
        await clickFirst(
            page,
            [
                'button:has-text("Log in")',
                'a:has-text("Log in")',
                'button:has-text("LOG IN")',
                'a:has-text("Sign In")',
                'button:has-text("Sign In")',
            ],
            "login CTA",
        );
        await sleep(1500);

        // Prefer navigating straight to secure-login if still no form
        const passProbe = page.locator('input[type="password"]').first();
        if (!(await passProbe.isVisible({ timeout: 2500 }).catch(() => false))) {
            await page
                .goto("https://www.fedex.com/secure-login/en-us/#/login?redirectUrl=https://www.fedex.com/online/billing/", {
                    waitUntil: "domcontentloaded",
                    timeout: 45_000,
                })
                .catch(() => undefined);
            await sleep(2000);
            await clickFirst(
                page,
                [
                    'button:has-text("Accept")',
                    'button:has-text("Accept All")',
                    '#onetrust-accept-btn-handler',
                ],
                "cookies",
            );
        }

        const userBox = page
            .locator(
                'input[name*="user" i], input[id*="user" i], input[autocomplete="username"], input[type="email"], input[aria-label*="User" i]',
            )
            .first();
        const passBox = page.locator('input[type="password"]').first();

        const userVisible = await userBox.isVisible({ timeout: 8000 }).catch(() => false);
        const passVisible = await passBox.isVisible({ timeout: 3000 }).catch(() => false);
        if (!userVisible || !passVisible) {
            console.log("Login form not found for auto-fill.");
            continue;
        }

        await userBox.click({ timeout: 5000 });
        await userBox.fill("");
        await userBox.fill(attempt.user);
        await passBox.click({ timeout: 5000 });
        await passBox.fill("");
        await passBox.fill(attempt.pass);

        const submitted = await clickFirst(
            page,
            [
                'button:has-text("LOG IN")',
                'button:has-text("Log in")',
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Sign In")',
            ],
            "submit login",
        );
        if (!submitted) {
            await passBox.press("Enter").catch(() => undefined);
        }

        for (let i = 0; i < 18; i++) {
            await sleep(1500);
            if (await isLoggedIn(page)) {
                console.log(`Auto-login succeeded (${attempt.label}).`);
                return true;
            }
            // Redirected into FBO account summary sometimes without exact markers yet
            const url = page.url();
            if (/online\/billing/i.test(url) && !/login|secure-login/i.test(url)) {
                console.log(`Landed on billing URL after ${attempt.label} login.`);
                if (await isLoggedIn(page)) return true;
            }
            const body = ((await page.locator("body").innerText().catch(() => "")) || "").toLowerCase();
            if (
                body.includes("verification code") ||
                body.includes("two-step") ||
                body.includes("two step") ||
                body.includes("one-time pass") ||
                body.includes("enter the code")
            ) {
                console.log("MFA / verification challenge detected — need code from email/phone.");
                return false;
            }
            if (
                body.includes("incorrect") ||
                body.includes("invalid user") ||
                body.includes("invalid password") ||
                body.includes("didn't match") ||
                body.includes("do not match")
            ) {
                console.log(`Auto-login rejected for ${attempt.label}.`);
                break;
            }
            if (body.includes("trouble establishing a connection")) {
                console.log("FedEx connection error page — retry navigation.");
                await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
            }
        }
    }
    return await isLoggedIn(page);
}

/**
 * Drive FedEx Billing Online to export CSV.
 * After login, tries automatic Search/Download → CSV clicks, then waits for download event.
 */
export async function runFedexCsvDownload(options?: {
    probeOnly?: boolean;
}): Promise<FedexDownloadResult> {
    const startedAt = new Date().toISOString();
    const probeOnly = options?.probeOnly ?? false;
    let detectedState: FedexDownloadResult["detectedState"] = "unknown";

    console.log("\n===============================================");
    console.log(" FedEx Billing Online CSV Downloader");
    console.log("===============================================\n");
    console.log(`Statements: ${FEDEX_STATEMENT_DIR}`);
    console.log(`Profile:    ${CHROME_PROFILE_DIR} (dedicated — your Chrome stays open)\n`);

    fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });

    let context: BrowserContext | null = null;
    try {
        context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
            headless: false,
            channel: "chrome",
            acceptDownloads: true,
            viewport: { width: 1400, height: 900 },
            ignoreDefaultArgs: ["--enable-automation"],
            args: [
                "--disable-blink-features=AutomationControlled",
                "--start-maximized",
            ],
        });

        const page = context.pages()[0] ?? (await context.newPage());

        console.log("Opening FedEx Billing Online...");
        await page.goto(FBO_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await sleep(2000);

        // Dismiss cookie banners if present
        await clickFirst(
            page,
            [
                'button:has-text("Accept")',
                'button:has-text("Accept All")',
                'button:has-text("I Accept")',
                '#onetrust-accept-btn-handler',
            ],
            "cookies",
        );

        if (await isLoggedIn(page)) {
            detectedState = "logged_in";
            console.log("Already logged in.");
        } else if (await needsLogin(page)) {
            detectedState = "login_required";
            const autoOk = await tryEnvLogin(page);
            if (autoOk || (await isLoggedIn(page))) {
                detectedState = "logged_in";
                console.log("Login detected.");
            } else {
                console.log("FedEx login still required in the dedicated window.");
                console.log(
                    `Complete login there (1Password OK). Waiting up to ${LOGIN_WAIT_MS / 1000}s...\n`,
                );
                const deadline = Date.now() + LOGIN_WAIT_MS;
                while (Date.now() < deadline) {
                    if (await isLoggedIn(page)) break;
                    await sleep(2000);
                }
                if (!(await isLoggedIn(page))) {
                    throw new Error("Timed out waiting for FedEx login in dedicated profile");
                }
                detectedState = "logged_in";
                console.log("Login detected.");
            }
        } else {
            // Ambiguous — still try to proceed
            detectedState = "unknown";
            console.log("Login state unclear; continuing...");
        }

        if (probeOnly) {
            const result: FedexDownloadResult = {
                success: true,
                mode: "probe",
                startedAt,
                finishedAt: new Date().toISOString(),
                detectedState,
                message: "Probe OK — FedEx page reachable.",
            };
            writeFedexAcquisitionStatus(result);
            return result;
        }

        console.log("Navigating Search/Download...");
        await clickFirst(
            page,
            [
                'a:has-text("Search/Download")',
                'a:has-text("Search / Download")',
                'button:has-text("Search/Download")',
                'text=Search/Download',
                '[href*="search"]',
            ],
            "Search/Download",
        );
        await sleep(2500);

        // Prefer a date range that covers recent invoices if controls exist
        await clickFirst(
            page,
            [
                'button:has-text("Search")',
                'input[type="submit"][value*="Search"]',
                'button:has-text("Go")',
            ],
            "Search",
        );
        await sleep(2000);

        // Select all / first invoice if checkboxes exist
        const selectAll = page.locator('input[type="checkbox"]').first();
        if (await selectAll.isVisible({ timeout: 2000 }).catch(() => false)) {
            try {
                await selectAll.check({ force: true });
                console.log("   checked first/select-all checkbox");
            } catch {
                /* optional */
            }
        }

        // Arm download waiter before clicking Download
        const downloadPromise = page.waitForEvent("download", { timeout: DOWNLOAD_WAIT_MS });

        console.log("Triggering Download → CSV...");
        const openedDownload = await clickFirst(
            page,
            [
                'button:has-text("Download")',
                'a:has-text("Download")',
                'text=Download',
                '[aria-label*="Download"]',
            ],
            "Download",
        );

        if (openedDownload) {
            await sleep(800);
            // CSV option in menu
            await clickFirst(
                page,
                [
                    'text=CSV',
                    'button:has-text("CSV")',
                    'a:has-text("CSV")',
                    'li:has-text("CSV")',
                    '[data-value="csv"]',
                    'text=Comma',
                ],
                "CSV format",
            );
        }

        let download;
        try {
            download = await downloadPromise;
        } catch {
            // Fallback: user may click CSV manually in the dedicated window
            console.log("Auto-download not detected — click Download → CSV in the dedicated window.");
            download = await page.waitForEvent("download", { timeout: DOWNLOAD_WAIT_MS });
        }

        const suggestedName = download.suggestedFilename() || `FEDEX_${Date.now()}.csv`;
        const safeName = /^FEDEX/i.test(suggestedName)
            ? suggestedName.endsWith(".csv")
                ? suggestedName
                : `${suggestedName}.csv`
            : `FEDEX_${suggestedName.endsWith(".csv") ? suggestedName : `${suggestedName}.csv`}`;
        const finalPath = path.join(FEDEX_STATEMENT_DIR, safeName);
        await download.saveAs(finalPath);

        // Mirror to Sandbox for ops habit
        try {
            if (fs.existsSync(SANDBOX_DIR)) {
                fs.copyFileSync(finalPath, path.join(SANDBOX_DIR, path.basename(finalPath)));
            }
            archiveFedexCsvToAria(finalPath);
        } catch {
            /* non-fatal */
        }

        const result: FedexDownloadResult = {
            success: true,
            mode: "playwright_download",
            startedAt,
            finishedAt: new Date().toISOString(),
            detectedState,
            savedPath: finalPath,
            message: "FedEx CSV downloaded.",
        };
        writeFedexAcquisitionStatus(result);
        console.log(`\n✅ Saved: ${finalPath}`);
        return result;
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        const result: FedexDownloadResult = {
            success: false,
            mode: "failed",
            startedAt,
            finishedAt: new Date().toISOString(),
            detectedState,
            message: "FedEx CSV acquisition failed.",
            error: msg,
        };
        writeFedexAcquisitionStatus(result);
        console.error(`FedEx downloader error: ${msg}`);
        return result;
    } finally {
        if (context) {
            await context.close().catch(() => undefined);
            console.log("Dedicated FedEx Chrome closed (your main Chrome untouched).");
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const probeOnly = args.includes("--probe-only");
    const json = args.includes("--json");
    const result = await runFedexCsvDownload({ probeOnly });
    if (json) console.log(JSON.stringify(result));
    if (!result.success) process.exit(1);
}

const isEntrypoint = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;

if (isEntrypoint) {
    main().catch((error: Error) => {
        writeFedexAcquisitionStatus({
            success: false,
            mode: "failed",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            detectedState: "unknown",
            message: "FedEx CSV acquisition crashed.",
            error: error.message,
        });
        console.error(error);
        process.exit(1);
    });
}
