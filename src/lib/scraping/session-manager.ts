/**
 * @file    session-manager.ts
 * @purpose Manages Playwright browser lifecycle with persistent session and anti-detection.
 *          Provides session validation and graceful cleanup.
 * @author  Aria / Will
 * @created 2026-04-07
 */

import { chromium, BrowserContext } from 'playwright';

class SessionManager {
  private context: BrowserContext | null = null;
  private sessionPath: string;
  private userDataDir: string;

  constructor() {
    this.sessionPath = process.env.PLAYWRIGHT_SESSION_PATH ?? '.basauto-session.json';
    this.userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR ?? './chrome-profile';
  }

  /**
   * Ensure browser context is initialized with persistent session
   */
  async ensureContext(): Promise<BrowserContext> {
    if (!this.context) {
      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        headless: true,
        channel: 'chrome',
        acceptDownloads: false,
        viewport: { width: 1920, height: 1080 },
        ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--start-maximized'
        ],
        ignoreHTTPSErrors: true,
        bypassCSP: true,
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      // Anti-detection: hide webdriver flag
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // Additional anti-bot measures
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5] // fake plugin list
        });
        // @ts-ignore - adding chrome property for anti-detection
        window.chrome = { runtime: {} };
        // Spoof languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });
      });
    }

    return this.context;
  }

   /**
    * Check if the session cookie is still valid by visiting dashboard.
    * Returns false if redirected to /auth/signin (expired session).
    * Sends Telegram reminder if session has expired.
    */
   async checkSessionValidity(): Promise<boolean> {
     const context = await this.ensureContext();
     const page = await context.newPage();

     try {
       // Navigate to Finale dashboard
       const response = await page.goto('https://app.finaleinventory.com/purchasing', {
         waitUntil: 'domcontentloaded',
         timeout: 30000
       });

       // Check if we got redirected to sign-in page
       const url = page.url();
       if (url.includes('/auth/signin') || response?.status() === 302) {
         console.warn('[SessionManager] Session expired: redirected to sign-in');
         await this.sendCookieExpiryReminder();
         return false;
       }

       // Also check if response is OK
       return response?.ok() || false;
     } catch (error) {
       console.error('[SessionManager] Session validation failed:', error);
       return false;
     } finally {
       await page.close();
     }
   }

   /**
    * Send Telegram reminder about cookie expiry 2026-05-07
    */
   private async sendCookieExpiryReminder(): Promise<void> {
     const botToken = process.env.TELEGRAM_BOT_TOKEN;
     const chatId = process.env.TELEGRAM_CHAT_ID;

     if (!botToken || !chatId) {
       console.warn('[SessionManager] Missing Telegram credentials for expiry reminder');
       return;
     }

     try {
       const { Telegraf } = await import('telegraf');
       const bot = new Telegraf(botToken);
       const message = `⚠️ <b>Cookie Expiry Reminder</b>\n\n` +
         `Finale dashboard session has expired or is invalid.\n` +
         `Cookies were scheduled to expire: 2026-05-07\n\n` +
         `Please refresh your session and update the cookie storage.`;

       await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
       console.log('[SessionManager] Cookie expiry reminder sent to Telegram');
     } catch (error) {
       console.error('[SessionManager] Failed to send cookie expiry reminder:', error);
     }
   }

  /**
   * Close browser and cleanup
   */
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }
}

export const sessionManager = new SessionManager();
export type { SessionManager, BrowserContext };
