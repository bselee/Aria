/**
 * @file    purchasing-dashboard.ts
 * @purpose Scrapes the Finale purchasing dashboard to extract items, vendors, and status.
 *          Uses persistent Chrome session for authentication.
 * @author  Aria / Will
 * @created 2026-04-07
 */

import { sessionManager } from './session-manager';
import { Page } from 'playwright';

export interface PurchaseItem {
  sku: string;
  description: string;
  vendor: string;
  quantity: number;
  unit_price: number;
  total: number;
  status: string;
  requested_date: string;
  last_updated: string;
}

export interface ScrapeResult {
  items: PurchaseItem[];
  timestamp: string;
  vendorCount: number;
}

/**
 * Scrape the purchasing dashboard table.
 * Adjust selectors based on actual Finale dashboard structure.
 */
export async function scrapePurchasingDashboard(): Promise<ScrapeResult> {
  const context = await sessionManager.ensureContext();
  const page = await context.newPage();

  try {
    console.log('🌐 Navigating to Finale purchasing dashboard...');
    const response = await page.goto('https://app.finaleinventory.com/purchasing', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    if (!response?.ok()) {
      throw new Error(`Dashboard load failed: HTTP ${response?.status()}`);
    }

    console.log('⏳ Waiting for table to load...');
    // Wait for data table - adjust selector as needed
    await page.waitForSelector('table, [data-testid="purchasing-table"]', { 
      timeout: 30000 
    });

    console.log('📊 Extracting purchase items...');
    // Extract all rows from table
    const items = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr, [data-testid="purchasing-table"] tbody tr');
      return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('td');
        // Adjust indices based on actual column order
        return {
          sku: cells[0]?.textContent?.trim() || '',
          description: cells[1]?.textContent?.trim() || '',
          vendor: cells[2]?.textContent?.trim() || '',
          quantity: parseFloat(cells[3]?.textContent?.trim() || '0'),
          unit_price: parseFloat(cells[4]?.textContent?.trim() || '0'),
          total: parseFloat(cells[5]?.textContent?.trim() || '0'),
          status: cells[6]?.textContent?.trim() || '',
          requested_date: cells[7]?.textContent?.trim() || '',
          last_updated: cells[8]?.textContent?.trim() || ''
        };
      }).filter(item => item.sku.length > 0); // Skip empty rows
    }) as PurchaseItem[];

    // Count unique vendors
    const uniqueVendors = new Set(items.map(item => item.vendor.trim()).filter(Boolean));

    console.log(`✅ Scraped ${items.length} items from ${uniqueVendors.size} vendors`);
    
    return {
      items,
      timestamp: new Date().toISOString(),
      vendorCount: uniqueVendors.size
    };
  } finally {
    await page.close();
  }
}

/**
 * Validate session and scrape in one call.
 * Returns error object if session is invalid.
 */
export async function validateSessionAndScrape(): Promise<ScrapeResult | { error: string; message: string }> {
  console.log('🔐 Validating session...');
  const isValid = await sessionManager.checkSessionValidity();
  
  if (!isValid) {
    return { 
      error: 'SESSION_EXPIRED', 
      message: 'Dashboard session expired. Refresh .basauto-session.json from DevTools.' 
    };
  }

  console.log('✅ Session valid, proceeding with scrape...');
  return await scrapePurchasingDashboard();
}
