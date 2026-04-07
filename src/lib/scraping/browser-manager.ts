// src/lib/scraping/browser-manager.ts
import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';

export interface BrowserOptions {
  headless?: boolean;
  cookiesPath?: string;
  userAgent?: string;
}

export class BrowserManager {
  private static instance: BrowserManager;
  private browser: any;
  private context: BrowserContext | null = null;

  private constructor() {}

  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  async launchBrowser(options: BrowserOptions = {}): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: options.headless ?? true,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
      });
    }
    this.context = await this.browser.newContext();
    if (options.cookiesPath && fs.existsSync(options.cookiesPath)) {
      const cookies = JSON.parse(fs.readFileSync(options.cookiesPath, 'utf-8'));
      await this.context!.addCookies(cookies);
    }
    const page = await this.context!.newPage();
    return page;
  }

  async close(): Promise<void> {
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    this.context = null;
    this.browser = null;
  }

  async checkSession(testUrl: string): Promise<boolean> {
    try {
      const page = await this.launchBrowser({ headless: true });
      await page.goto(testUrl);
      const url = page.url();
      await this.close();
      return !url.includes('/auth/signin');
    } catch {
      return false;
    }
  }
}