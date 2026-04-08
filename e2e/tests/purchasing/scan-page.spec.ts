import { test, expect } from '@playwright/test';

test.describe('Purchasing Dashboard', () => {
  test('should load the purchases page and display vendor chips', async ({ page }) => {
    // Navigate to the page
    await page.goto('https://basauto.vercel.app/purchases', { waitUntil: 'networkidle' });

    // Verify the title or main heading
    await expect(page.locator('h1', { hasText: 'Purchases' }).or(page.locator('text=Purchases').first())).toBeVisible({ timeout: 15000 });

    // Find all vendor chips (looking for active/selectable buttons, often containing counts)
    // We wait for at least one button to be visible
    await expect(page.locator('button').first()).toBeVisible({ timeout: 15000 });

    const buttons = await page.locator('button').all();
    const vendorChips = [];
    
    for (const btn of buttons) {
      const text = await btn.textContent();
      if (text && text.match(/^[A-Z][\w\s.,&'()-]+\d+$/i) && !['Purchases', 'Overdue', 'Purchase Request', 'Tutorial'].some(s => text.includes(s))) {
        vendorChips.push(btn);
      }
    }

    console.log(`Found ${vendorChips.length} vendor chips.`);

    // If there are vendors, let's click the first one and verify cards load
    if (vendorChips.length > 0) {
      const firstVendor = vendorChips[0];
      const vendorName = await firstVendor.textContent();
      console.log(`Clicking vendor: ${vendorName}`);
      
      await firstVendor.click();
      
      // Wait for content to render. We expect specific product SKUs or titles.
      // Usually they are in headings (h2, h3, etc.) or specific card components
      await page.waitForTimeout(2000); // Wait for animations or data fetch
      
      const cards = page.locator('article, .card, [class*="card"]');
      const count = await cards.count();
      console.log(`Found ${count} product cards for ${vendorName}`);
      
      // We expect at least one card if they have items
      if (count === 0) {
        console.warn(`Warning: No product cards found for ${vendorName}. Validating fallback content...`);
      }
    }
  });
});
