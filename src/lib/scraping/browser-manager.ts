// src/lib/scraping/browser-manager.ts
import { chromium, type Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import https from 'https';
import http from 'http';

export interface BrowserOptions {
  headless?: boolean;
  cookiesPath?: string;
  userAgent?: string;
  saveCookiesOnClose?: boolean;
  useRunningBrowser?: boolean;
  connectToChrome?: boolean;
  debuggingPort?: number;
}

const DEFAULT_CDP_PORT = 9222;
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;

const RESOURCE_SAVING_FLAGS = [
  '--disable-extensions',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-crash-reporter',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--memory-pressure-off',
  '--mute-audio',
];

export class BrowserManager {
  private static instance: BrowserManager;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launching = false;
  private currentCookiesPath: string | null = null;
  private sessionValidUntil: number | null = null;
  private lastCheckedUrl: string | null = null;
  private headlessMode: boolean = true;
  private usingCDP: boolean = false;

  private constructor() {}

  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  async isCDPAvailable(port: number = DEFAULT_CDP_PORT): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/json`, { timeout: 1000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private async getCDPEndpoint(port: number = DEFAULT_CDP_PORT): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/json`, { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const targets = JSON.parse(data);
            const firstTarget = targets[0];
            if (firstTarget && firstTarget.webSocketDebuggerUrl) {
              resolve(firstTarget.webSocketDebuggerUrl);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  async connectToChrome(debuggingPort: number = DEFAULT_CDP_PORT): Promise<Page> {
    if (this.launching) {
      throw new Error('Browser launch already in progress');
    }
    this.launching = true;
    try {
      const endpoint = await this.getCDPEndpoint(debuggingPort);
      if (!endpoint) {
        throw new Error(`No Chrome DevTools endpoint found on port ${debuggingPort}. Is Chrome running with --remote-debugging-port=${debuggingPort}?`);
      }
      console.log(`Connecting to Chrome via CDP at ${endpoint}...`);
      this.browser = await chromium.connectOverCDP(endpoint);
      this.usingCDP = true;
      this.headlessMode = false;
      const contexts = this.browser.contexts();
      if (contexts.length > 0) {
        this.context = contexts[0];
      } else {
        this.context = await this.browser.newContext();
      }
      const page = await this.context.newPage();
      return page;
    } finally {
      this.launching = false;
    }
  }

  async useRunningBrowser(): Promise<Page> {
    if (await this.isCDPAvailable(DEFAULT_CDP_PORT)) {
      return this.connectToChrome(DEFAULT_CDP_PORT);
    }
    console.log('No running Chrome found on port 9222, falling back to new browser launch');
    return this.launchBrowser({});
  }

  private async connectToRunningChrome(port: number = DEFAULT_CDP_PORT): Promise<Browser | null> {
    const endpoint = `http://localhost:${port}/json/version`;
    try {
      // Check if Chrome is running and has CDP endpoint
      const response = await new Promise((resolve) => {
        const req = https.get(endpoint, { timeout: 1000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
      });

      if (!response || typeof response !== 'string') return null;

      const versionData = JSON.parse(response);
      if (!versionData.webSocketDebuggerUrl) return null;

      const cdpUrl = versionData.webSocketDebuggerUrl;
      console.log(`Connecting to running Chrome via CDP at ${cdpUrl}`);
      const browser = await chromium.connect({ endpointURL: cdpUrl });
      this.usingCDP = true;
      return browser;
    } catch (error) {
      console.log(`Failed to connect to Chrome via CDP at port ${port}: ${error}`);
      return null;
    }
  }

  async launchBrowser(options: BrowserOptions = {}): Promise<Page> {
    if (this.launching) {
      throw new Error('Browser launch already in progress');
    }
    this.launching = true;
    try {
      if (options.useRunningBrowser || options.connectToChrome) {
        const port = options.debuggingPort ?? DEFAULT_CDP_PORT;
        if (await this.isCDPAvailable(port)) {
          return this.connectToChrome(port);
        }
        if (options.useRunningBrowser || options.connectToChrome) {
          console.log(`No Chrome running on port ${port}, falling back to new browser launch`);
        }
      }
      const requestedHeadless = options.headless ?? true;
      if (this.browser && this.headlessMode !== requestedHeadless) {
        await this.destroy();
      }
      if (!this.browser) {
        const args = [...RESOURCE_SAVING_FLAGS];
        if (!requestedHeadless) {
          args.push('--start-maximized');
        }
        this.browser = await chromium.launch({
          headless: requestedHeadless,
          args,
        });
        this.headlessMode = requestedHeadless;
        this.usingCDP = false;
      }
      if (!this.context) {
        this.context = await this.browser.newContext();
      }
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
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }

  async destroy(): Promise<void> {
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    this.context = null;
    this.browser = null;
    this.currentCookiesPath = null;
    this.sessionValidUntil = null;
    this.lastCheckedUrl = null;
    this.headlessMode = true;
    this.usingCDP = false;
  }

  isHeadless(): boolean {
    return this.headlessMode;
  }

  isUsingCDP(): boolean {
    return this.usingCDP;
  }

  async checkSession(testUrl: string, cookiesPath?: string): Promise<boolean> {
    const now = Date.now();
    if (
      this.sessionValidUntil !== null &&
      this.lastCheckedUrl === testUrl &&
      now < this.sessionValidUntil
    ) {
      return true;
    }

    try {
      const page = await this.launchBrowser({ headless: true, cookiesPath });
      await page.goto(testUrl);
      const url = page.url();
      await this.destroy();
      const isValid = !url.includes('/auth/signin');
      if (isValid) {
        this.sessionValidUntil = now + SESSION_CACHE_TTL_MS;
        this.lastCheckedUrl = testUrl;
      }
      return isValid;
    } catch {
      return false;
    }
  }
}