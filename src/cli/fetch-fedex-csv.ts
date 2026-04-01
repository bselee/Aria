/**
 * @file    fetch-fedex-csv.ts
 * @purpose Automates downloading the latest invoice CSV from FedEx Billing Online.
 *          Uses a persistent Chrome profile so the existing FedEx session can be reused.
 *          Saves results into a stable Aria-owned FedEx folder and writes a status file
 *          for dashboard/manual visibility.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { chromium } from "playwright";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { pathToFileURL } from "url";
import {
    ensureFedexStatementDir,
    writeFedexAcquisitionStatus,
} from "@/lib/statements/fedex-acquisition";

const FBO_URL = "https://www.fedex.com/en-us/billing-online.html";
const CHROME_PROFILE_DIR = path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data");
const FEDEX_STATEMENT_DIR = ensureFedexStatementDir();

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

export async function runFedexCsvDownload(options?: { probeOnly?: boolean }): Promise<FedexDownloadResult> {
    const startedAt = new Date().toISOString();
    const probeOnly = options?.probeOnly ?? false;
    let detectedState: FedexDownloadResult["detectedState"] = "unknown";

    console.log("\n===============================================");
    console.log(" FedEx Billing Online CSV Downloader");
    console.log("===============================================\n");
    console.log(`FedEx statement folder: ${FEDEX_STATEMENT_DIR}`);
    console.log("Phase 1: Launching Chrome with the persistent profile.");
    console.log("Please ensure no other Chrome windows are open before we start.\n");

    try {
        execSync("taskkill /F /IM chrome.exe /T", { stdio: "ignore" });
        await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch {
        // ignore
    }

    const context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
        headless: false,
        channel: "chrome",
        acceptDownloads: true,
        viewport: null,
        ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
        args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
        console.log("Opening FedEx Billing Online...");
        await page.goto(FBO_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

        const loggedIn = await Promise.race([
            page.waitForSelector('text="Account Summary"', { timeout: 7000 }).then(() => true),
            page.waitForSelector('text="Search/Download"', { timeout: 7000 }).then(() => true),
            page.waitForSelector('a:has-text("Log in")', { timeout: 7000 }).then(async (el) => {
                await el?.click();
                return false;
            }).catch(() => false),
        ]);

        if (!loggedIn) {
            detectedState = "login_required";
            console.log("FedEx needs login. Use the existing browser session or 1Password to complete it.");
            await page.waitForSelector('text="Search/Download"', { timeout: 120_000 });
            console.log("Login succeeded and FedEx search/download is visible.");
        } else {
            detectedState = "logged_in";
            console.log("FedEx dashboard/search view is already available.");
        }

        if (probeOnly) {
            const result: FedexDownloadResult = {
                success: true,
                mode: "probe",
                startedAt,
                finishedAt: new Date().toISOString(),
                detectedState,
                message: detectedState === "logged_in"
                    ? "FedEx probe succeeded and dashboard/search elements were visible."
                    : "FedEx probe reached login flow and then found dashboard/search after login.",
            };
            writeFedexAcquisitionStatus(result);
            return result;
        }

        console.log("Phase 2: Navigating to FedEx Search/Download...");
        await page.waitForTimeout(3000);

        try {
            const searchTab = await page.$('a:has-text("Search/Download")');
            if (searchTab) {
                await searchTab.click();
                await page.waitForTimeout(3000);
            }
        } catch (error: any) {
            console.log(`Could not click Search/Download automatically: ${error.message}`);
        }

        console.log("Phase 3: Waiting for the CSV download.");
        console.log("Manually choose the desired invoice and click Download -> CSV.");

        const download = await page.waitForEvent("download", { timeout: 300_000 });
        const suggestedName = download.suggestedFilename();
        const safeName = suggestedName.endsWith(".csv") ? suggestedName : `FEDEX_${suggestedName}.csv`;
        const finalPath = path.join(FEDEX_STATEMENT_DIR, safeName);

        await download.saveAs(finalPath);

        const result: FedexDownloadResult = {
            success: true,
            mode: "playwright_download",
            startedAt,
            finishedAt: new Date().toISOString(),
            detectedState,
            savedPath: finalPath,
            message: "FedEx CSV downloaded successfully via Playwright.",
        };
        writeFedexAcquisitionStatus(result);
        console.log(`Saved: ${finalPath}`);
        return result;
    } catch (error: any) {
        const profileLocked = String(error.message || "").includes("ProcessSingleton")
            || String(error.message || "").includes("profile directory");
        const result: FedexDownloadResult = {
            success: false,
            mode: "failed",
            startedAt,
            finishedAt: new Date().toISOString(),
            detectedState,
            message: profileLocked
                ? "FedEx acquisition failed because the Chrome profile is still locked by another Chrome process."
                : "FedEx CSV acquisition failed.",
            error: error.message,
        };
        writeFedexAcquisitionStatus(result);
        console.error(`FedEx downloader error: ${error.message}`);
        return result;
    } finally {
        await context.close();
        console.log("Chrome closed.");
    }
}

async function main() {
    const args = process.argv.slice(2);
    const probeOnly = args.includes("--probe-only");
    const json = args.includes("--json");
    const result = await runFedexCsvDownload({ probeOnly });
    if (json) {
        console.log(JSON.stringify(result));
    }
    if (!result.success) {
        process.exit(1);
    }
}

const isEntrypoint = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;

if (isEntrypoint) {
    main().catch((error) => {
        const result: FedexDownloadResult = {
            success: false,
            mode: "failed",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            detectedState: "unknown",
            message: "FedEx CSV acquisition crashed before completion.",
            error: error.message,
        };
        writeFedexAcquisitionStatus(result);
        if (process.argv.slice(2).includes("--json")) {
            console.log(JSON.stringify(result));
        }
        console.error(error);
        process.exit(1);
    });
}
