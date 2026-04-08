// src/lib/scraping/browser-manager.test.ts
import { BrowserManager } from './browser-manager';
import { expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

test('can launch browser and load page', async () => {
  const manager = BrowserManager.getInstance();
  const page = await manager.launchBrowser({ headless: true });
  await page.goto('https://example.com');
  expect(await page.title()).toBe('Example Domain');
  await manager.close();
}, 15000);

test('creates empty cookie file if missing', async () => {
  const manager = BrowserManager.getInstance();
  const tempCookiesPath = path.join(os.tmpdir(), 'test-cookies.json');

  // Ensure file does not exist
  if (fs.existsSync(tempCookiesPath)) {
    fs.unlinkSync(tempCookiesPath);
  }

  const page = await manager.launchBrowser({ headless: true, cookiesPath: tempCookiesPath });

  // Should have created empty file
  expect(fs.existsSync(tempCookiesPath)).toBe(true);
  const content = fs.readFileSync(tempCookiesPath, 'utf-8');
  expect(content).toBe('[]');

  await manager.close();
  fs.unlinkSync(tempCookiesPath);
}, 15000);