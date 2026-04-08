// src/lib/scraping/browser-manager.ts
import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';

export interface BrowserOptions {
  headless?: boolean;
  cookiesPath?: string;
  userAgent?: string;
  saveCookiesOnClose?: boolean;
}

export class BrowserManager {
  private static instance: BrowserManager;
  private browser: any;
  private context: BrowserContext | null = null;
  private launching = false;
  private currentCookiesPath: string | null = null;

  private constructor() {}

  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  async launchBrowser(options: BrowserOptions = {}): Promise<Page> {
    if (this.launching) {
      throw new Error('Browser launch already in progress');
    }
    this.launching = true;
    try {
      if (!this.browser) {
        this.browser = await chromium.launch({
          headless: options.headless ?? true,
          args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
      }
      if (this.context) {
        await this.context.close();
        this.context = null;
      }
      this.context = await this.browser.newContext();
      this.currentCookiesPath = options.cookiesPath || null;
      if (this.currentCookiesPath) {
        if (!fs.existsSync(this.currentCookiesPath)) {
          try {
            fs.writeFileSync(this.currentCookiesPath, '[]');
            console.warn(`Created empty cookie file ${this.currentCookiesPath}. Fill with cookies manually after login.`);
          } catch (error) {
            console.warn(`Failed to create cookie file ${this.currentCookiesPath}: ${error}`);
          }
        }
        if (fs.existsSync(this.currentCookiesPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(this.currentCookiesPath, 'utf-8'));
            let cookies;
            if (Array.isArray(data)) {
              cookies = data;
            } else if (data.cookies && Array.isArray(data.cookies)) {
              cookies = data.cookies;
            } else {
              throw new Error('Cookie file does not contain an array or object with cookies property');
            }
            await this.context!.addCookies(cookies);
          } catch (error) {
            console.warn(`Failed to load cookies from ${this.currentCookiesPath}: ${error}`);
          }
        }
      }
      const page = await this.context!.newPage();
      return page;
    } finally {
      this.launching = false;
    }
  }

  async saveCookies(): Promise<void> {
    if (!this.context || !this.currentCookiesPath) {
      return;
    }
    try {
      const cookies = await this.context.cookies();
      fs.writeFileSync(this.currentCookiesPath, JSON.stringify(cookies, null, 2));
      console.warn(`Saved ${cookies.length} cookies to ${this.currentCookiesPath}`);
    } catch (error) {
      console.warn(`Failed to save cookies to ${this.currentCookiesPath}: ${error}`);
    }
  }

  async close(): Promise<void> {
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    this.context = null;
    this.browser = null;
    this.currentCookiesPath = null;
  }

  async checkSession(testUrl: string, cookiesPath?: string): Promise<boolean> {
    try {
      const page = await this.launchBrowser({ headless: true, cookiesPath });
      await page.goto(testUrl);
      const url = page.url();
      await this.close();
      return !url.includes('/auth/signin');
    } catch {
      return false;
    }
  }
}