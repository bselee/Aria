// src/lib/scraping/browser-manager.test.ts
import { BrowserManager } from './browser-manager';
import { expect, test } from 'vitest';

test('can launch browser and load page', async () => {
  const manager = BrowserManager.getInstance();
  const page = await manager.launchBrowser({ headless: true });
  await page.goto('https://example.com');
  expect(await page.title()).toBe('Example Domain');
  await manager.close();
}, 15000);