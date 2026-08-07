/**
 * @file    src/cli/download-billcom-ref.ts
 * @purpose Download the All Bills CSV export from bill.com via Playwright.
 *          Used by the billcom-ref-import cron to keep the billcom_bills_ref
 *          SQLite table current for AP deduplication.
 *
 *          Auth: Tries persistent browser profile first (survives MFA/SSO),
 *          falls back to email+password env vars. If neither works, logs a
 *          warning so the cron can proceed with the last-downloaded CSV.
 *
 *          Output: data/AllBillsPage.csv (overwritten on each run)
 *
 * @author  Hermia
 * @created 2026-07-30
 * @updated 2026-07-30 — Initial implementation; replaces placeholder cron ref.
 * @deps    playwright
 * @env     BILL_COM_EMAIL, BILL_COM_PASSWORD (optional — only if profile auth fails)
 *
 * Usage:
 *   npx tsx src/cli/download-billcom-ref.ts
 *   npx tsx src/cli/download-billcom-ref.ts --headed   (for first-time login)
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import fs from "fs";

const BILL_COM_URL = "https://app.bill.com";
const BILLS_URL = "https://app.bill.com/bills";
const PROFILE_DIR = path.resolve(process.cwd(), "data", "billcom-profile");
const OUTPUT_CSV = path.resolve(process.cwd(), "data", "AllBillsPage.csv");

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Wait for a download to complete and save it to the target path.
 * Playwright's download handling requires a Promise that resolves when done.
 */
async function waitForDownload(
  page: Page,
  timeoutMs: number = 30_000,
): Promise<string | null> {
  try {
    const download = await page.waitForEvent("download", { timeout: timeoutMs });
    const downloadPath = path.resolve(process.cwd(), "data", download.suggestedFilename());
    await download.saveAs(downloadPath);
    return downloadPath;
  } catch {
    return null;
  }
}

// ── Auth Strategies ──────────────────────────────────────────────────────────

/**
 * Attempt credential-based login to bill.com.
 * Returns true if login appears successful (redirected away from login page).
 */
async function tryCredentialLogin(page: Page): Promise<boolean> {
  const email = process.env.BILL_COM_EMAIL;
  const password = process.env.BILL_COM_PASSWORD;

  if (!email || !password) {
    console.log("[billcom-dl] No BILL_COM_EMAIL/BILL_COM_PASSWORD set — skipping credential login");
    return false;
  }

  console.log("[billcom-dl] Attempting credential login...");
  await page.goto("https://app.bill.com/login", { waitUntil: "networkidle", timeout: 30_000 });

  // Fill email
  const emailInput = page.locator('input[type="email"], input[name="email"], input[id="email"]').first();
  if (await emailInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await emailInput.fill(email);
  }

  // Click "Continue" or "Next" if present
  const nextBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), input[type="submit"]').first();
  if (await nextBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await nextBtn.click();
    await page.waitForTimeout(2_000);
  }

  // Fill password (may appear after email step)
  const pwdInput = page.locator('input[type="password"]').first();
  if (await pwdInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await pwdInput.fill(password);
    const submitBtn = page.locator('button:has-text("Sign In"), button:has-text("Log In"), input[type="submit"]').first();
    if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await submitBtn.click();
      await page.waitForTimeout(5_000);
    }
  }

  // Check if we landed on a bills/dashboard page (not login)
  const url = page.url();
  if (url.includes("/login") || url.includes("/signin")) {
    console.warn("[billcom-dl] Still on login page after credential attempt");
    return false;
  }

  console.log("[billcom-dl] Credential login appears successful");
  return true;
}

/**
 * Check if the current page is authenticated (not on a login screen).
 */
async function isAuthenticated(page: Page): Promise<boolean> {
  const url = page.url();
  // Bill.com redirects unauthenticated users to login
  if (url.includes("/login") || url.includes("/signin")) return false;

  // Also check for login-specific page content
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  if (
    bodyText.includes("Log in to Bill.com") ||
    bodyText.includes("Sign in to your account") ||
    bodyText.includes("Welcome back")
  ) {
    return false;
  }

  return true;
}

// ── CSV Export ───────────────────────────────────────────────────────────────

/**
 * Navigate to the Bills page and trigger CSV export.
 * Bill.com's "All Bills" page has an export button that downloads a CSV.
 */
async function exportBillsCSV(page: Page): Promise<boolean> {
  console.log("[billcom-dl] Navigating to Bills page...");
  await page.goto(BILLS_URL, { waitUntil: "networkidle", timeout: 30_000 });

  // Let the React app fully hydrate
  await page.waitForTimeout(3_000);

  // Bill.com's export pattern:
  // 1. Look for an "Export" or "Download" button/link
  // 2. Click it and handle the resulting dropdown/modal
  // 3. Select "CSV" format
  // 4. Wait for the download

  // Try common selectors for the export button
  const exportSelectors = [
    'button:has-text("Export")',
    'a:has-text("Export")',
    '[aria-label="Export"]',
    '[data-testid="export-button"]',
    'button:has-text("Download")',
    'a:has-text("Download CSV")',
    // Bill.com specific patterns
    'button[class*="export"]',
    'span:has-text("Export"):not(:has(span))',
  ];

  let clicked = false;
  for (const selector of exportSelectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 3_000 }).catch(() => false)) {
        console.log(`[billcom-dl] Found export element: ${selector}`);
        await el.click();
        clicked = true;
        await page.waitForTimeout(1_500);
        break;
      }
    } catch {
      // try next
    }
  }

  if (!clicked) {
    // Fallback: try the "..." (more actions) menu
    try {
      const moreBtn = page.locator('[aria-label="More actions"], button:has-text("..."), [data-testid="more-actions"]').first();
      if (await moreBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await moreBtn.click();
        await page.waitForTimeout(1_000);
      }
    } catch {
      // continue
    }
  }

  // After clicking export, look for CSV option in a dropdown/modal
  const csvSelectors = [
    'text="CSV"',
    'button:has-text("CSV")',
    'a:has-text("CSV")',
    'li:has-text("CSV")',
    'div[role="menuitem"]:has-text("CSV")',
    'text="Export as CSV"',
    'text="Download CSV"',
  ];

  let csvClicked = false;
  for (const selector of csvSelectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 3_000 }).catch(() => false)) {
        console.log(`[billcom-dl] Clicking CSV: ${selector}`);
        await el.click();
        csvClicked = true;
        break;
      }
    } catch {
      // try next
    }
  }

  if (!csvClicked) {
    // If no explicit CSV option appeared, the export button itself may have
    // triggered the download directly. Either way, wait for a download event.
    console.log("[billcom-dl] No explicit CSV option found — waiting for any download...");
  }

  // Start listening for download BEFORE clicking anything else
  const downloadPromise = waitForDownload(page, 15_000);

  // If we haven't clicked anything specific for CSV yet, try a final broader click
  if (!csvClicked && !clicked) {
    // Last resort: try to find any export/download in the page
    const anyExport = page.locator('button, a').filter({ hasText: /export|csv|download/i }).first();
    if (await anyExport.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await anyExport.click();
    }
  }

  const downloadedPath = await downloadPromise;

  if (downloadedPath) {
    // Move to canonical location
    ensureDir(path.dirname(OUTPUT_CSV));
    fs.copyFileSync(downloadedPath, OUTPUT_CSV);
    // Clean up the timestamped download
    try { fs.unlinkSync(downloadedPath); } catch { /* ok */ }
    console.log(`[billcom-dl] ✓ CSV saved to ${OUTPUT_CSV}`);
    return true;
  }

  // No download — take a screenshot for debugging
  console.warn("[billcom-dl] No download detected. Saving debug screenshot...");
  await page.screenshot({ path: path.resolve(process.cwd(), "data", "billcom-debug.png") });
  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const headed = process.argv.includes("--headed");

  console.log(`[billcom-dl] Starting Bill.com CSV download${headed ? " (headed mode)" : ""}...`);

  let context: BrowserContext;
  let needsCleanup = false;

  // Strategy 1: Persistent profile (survives MFA/SSO across runs)
  if (fs.existsSync(PROFILE_DIR)) {
    console.log("[billcom-dl] Using persistent browser profile...");
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: !headed,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } else {
    console.log("[billcom-dl] No persistent profile found — creating one.");
    ensureDir(PROFILE_DIR);
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: !headed,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }

  const page = context.pages()[0] || await context.newPage();
  let success = false;

  try {
    // Navigate to bill.com and check auth
    await page.goto(BILL_COM_URL, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(2_000);

    if (!(await isAuthenticated(page))) {
      console.log("[billcom-dl] Not authenticated — attempting login...");

      // Try credential login
      const loggedIn = await tryCredentialLogin(page);
      if (!loggedIn) {
        if (!headed) {
          console.warn(
            "[billcom-dl] Could not log in headlessly. " +
            "Run with --headed once to establish the persistent profile, " +
            "or set BILL_COM_EMAIL + BILL_COM_PASSWORD in .env.local.",
          );
        } else {
          console.log(
            "[billcom-dl] Headed mode — waiting 60s for manual login... " +
            "Log in to bill.com in the browser window, then the script will continue.",
          );
          // In headed mode, give the user time to log in
          await page.waitForTimeout(60_000);

          // Verify auth after manual login window
          if (!(await isAuthenticated(page))) {
            console.error("[billcom-dl] Still not authenticated after 60s. Aborting.");
            await context.close();
            return;
          }
        }
      }
    } else {
      console.log("[billcom-dl] Already authenticated (persistent profile)");
    }

    // Export CSV
    success = await exportBillsCSV(page);

    if (!success) {
      console.warn("[billcom-dl] CSV export may have failed. Check data/billcom-debug.png.");
    }
  } catch (err: any) {
    console.error(`[billcom-dl] Fatal error: ${err?.message || err}`);
    // Take a debug screenshot on error
    try {
      await page.screenshot({ path: path.resolve(process.cwd(), "data", "billcom-error.png") });
    } catch { /* ok */ }
  } finally {
    await context.close();
  }

  if (success) {
    console.log("[billcom-dl] Done.");
  } else {
    // Non-fatal exit — the cron will proceed with existing CSV
    console.warn("[billcom-dl] Download failed. Cron will re-import the last CSV if available.");
  }
}

// CLI entry point
if (require.main === module) {
  main().catch((err) => {
    console.error("[billcom-dl] Unhandled:", err);
    process.exit(1);
  });
}
