/**
 * @file    uline-cart-to-po.ts
 * @purpose Read Will's live ULINE shopping cart and create a matching Finale
 *          draft PO. Pack-size registry is consulted so cart "1 carton" rows
 *          turn into "500 ea @ $0.328" PO lines for correct receiving.
 *
 * @usage
 *   IMPORTANT: Close Chrome first — the script attaches to your persistent
 *   profile via BrowserManager.
 *
 *   node --import tsx src/cli/uline-cart-to-po.ts            # preview only (default)
 *   node --import tsx src/cli/uline-cart-to-po.ts --live     # actually create the draft PO
 *
 * Output: prints preview table; on --live writes a draft PO directly to Finale
 *         (this is Will's manual action, treated like a dashboard click — no
 *         approval gate). The drafted PO appears in Finale as ORDER_CREATED
 *         for review and commit.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { FinaleClient } from '../lib/finale/client';
import { BrowserManager } from '../lib/scraping/browser-manager';
import { scrapeObservedUlineCartRows } from '../lib/purchasing/uline-cart-live';
import { getPackSizes } from '../lib/purchasing/pack-size-registry';

const CART_URL = 'https://www.uline.com/Cart/Cart.aspx';
const UL_SESSION_FILE = '.uline-session.json';

interface PoLine {
    productId: string;
    quantity: number;       // eaches
    unitPrice: number;      // per-each
    cartCartons: number;    // original cart qty (cartons/cases)
    cartUnitPrice: number;  // original cart price (per carton/case)
    packSize: number;       // 1 if no registry entry
    packUnit: string;       // "carton" | "case" | "each" | etc.
    packSource: 'registry' | 'inferred';
}

async function main() {
    const args = process.argv.slice(2);
    const live = args.includes('--live');

    console.log('\n🛒 ULINE Cart → Finale Draft PO');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Mode: ${live ? '🔴 LIVE — will create draft PO' : '🟢 dry-run (use --live to create)'}\n`);

    // ─── Step 1: scrape ULINE cart ───
    console.log('📋 Phase 1: Scraping ULINE cart');
    console.log('   ⚠️  Chrome must be closed for this step\n');

    const manager = BrowserManager.getInstance();
    const page = await manager.launchBrowser({ headless: false, cookiesPath: UL_SESSION_FILE });

    let cartRows: Awaited<ReturnType<typeof scrapeObservedUlineCartRows>> = [];

    try {
        await page.goto(CART_URL, { waitUntil: 'load', timeout: 30_000 });
        await page.waitForTimeout(2_500);

        // If we got bounced to a login wall, give Will time to sign in manually
        const isLogin = await page.locator('#txtEmail, input[type="password"]').first()
            .isVisible({ timeout: 1_000 }).catch(() => false);
        if (isLogin) {
            console.log('   🔐 Login wall detected — sign in in the visible browser, then press Enter here.');
            await new Promise<void>(resolve => {
                process.stdin.once('data', () => resolve());
            });
            await page.goto(CART_URL, { waitUntil: 'load', timeout: 30_000 });
            await page.waitForTimeout(2_500);
            await manager.saveCookies();
        }

        cartRows = await scrapeObservedUlineCartRows(page);
        console.log(`   Found ${cartRows.length} cart row${cartRows.length === 1 ? '' : 's'}\n`);

        if (cartRows.length === 0) {
            console.log('   Cart appears empty — nothing to copy.');
            return;
        }
    } finally {
        await manager.close().catch(() => { /* ignore */ });
    }

    // ─── Step 2: pack-size lookup + price conversion ───
    const skus = cartRows.map(r => r.ulineModel);
    const packMap = await getPackSizes(skus);

    const lines: PoLine[] = [];
    const missingPrice: string[] = [];

    for (const row of cartRows) {
        const sku = row.ulineModel;
        const pack = packMap.get(sku);

        // Cart unit price is per-carton (or per-whatever-unit ULINE sells).
        // If pack registered: convert qty to eaches and price to per-each.
        // If not: pass-through (1/each assumption — same as before this script).
        const unitsPerPack = pack?.unitsPerPack ?? 1;
        const packUnit = pack?.packUnit ?? 'each';

        if (row.unitPrice == null) {
            missingPrice.push(sku);
            continue;
        }

        const eachQty = row.quantity * unitsPerPack;
        const eachPrice = row.unitPrice / unitsPerPack;

        lines.push({
            productId: sku,
            quantity: eachQty,
            unitPrice: Number(eachPrice.toFixed(4)),
            cartCartons: row.quantity,
            cartUnitPrice: row.unitPrice,
            packSize: unitsPerPack,
            packUnit,
            packSource: pack ? 'registry' : 'inferred',
        });
    }

    // ─── Step 3: preview ───
    console.log('📦 Phase 2: Cart → PO line conversion\n');
    console.log('  SKU         Cart           Pack             PO line               Source');
    console.log('  ' + '─'.repeat(85));
    for (const line of lines) {
        const cart = `${line.cartCartons} × $${line.cartUnitPrice.toFixed(2)}`.padEnd(15);
        const pack = `${line.packSize}/${line.packUnit}`.padEnd(15);
        const po = `${line.quantity} ea @ $${line.unitPrice.toFixed(4)}`.padEnd(20);
        const total = `$${(line.quantity * line.unitPrice).toFixed(2)}`;
        console.log(`  ${line.productId.padEnd(11)} ${cart} ${pack} ${po} ${line.packSource.padEnd(10)} = ${total}`);
    }
    if (missingPrice.length > 0) {
        console.log(`\n  ⚠ Skipped ${missingPrice.length} row(s) with no price scraped: ${missingPrice.join(', ')}`);
    }

    const grandTotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
    console.log(`\n  Grand total: $${grandTotal.toFixed(2)} across ${lines.length} line${lines.length === 1 ? '' : 's'}`);
    const inferredCount = lines.filter(l => l.packSource === 'inferred').length;
    if (inferredCount > 0) {
        console.log(`  Note: ${inferredCount} line${inferredCount === 1 ? '' : 's'} had no pack registry entry — treated as 1/each.`);
        console.log(`        Re-run src/cli/seed-uline-pack-sizes.ts after a fresh MyOrderHistory export to fill those in.`);
    }

    if (!live) {
        console.log('\n🟢 Dry-run complete. Re-run with --live to create the Finale draft PO.\n');
        return;
    }

    // ─── Step 4: create Finale draft PO ───
    console.log('\n📝 Phase 3: Creating Finale draft PO\n');

    const finale = new FinaleClient();
    const vendorPartyId = await finale.findVendorPartyByName('ULINE');
    if (!vendorPartyId) {
        console.error('❌ Could not find ULINE vendor party in Finale. Aborting.');
        process.exit(1);
    }
    console.log(`   ULINE vendor partyId: ${vendorPartyId}`);

    const memo = [
        '[Aria] Copied from live ULINE shopping cart',
        `Generated: ${new Date().toISOString()}`,
        `Lines: ${lines.length}, total $${grandTotal.toFixed(2)}`,
        inferredCount > 0 ? `⚠ ${inferredCount} line(s) used 1/each fallback (no pack registry entry)` : null,
        'Review in Finale before committing.',
    ].filter(Boolean).join('\n');

    const result = await finale.createDraftPurchaseOrder(
        vendorPartyId,
        lines.map(l => ({
            productId: l.productId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
        })),
        memo,
    );

    console.log(`\n✅ Draft PO created: #${result.orderId}`);
    console.log(`   ${result.finaleUrl}`);
    if (result.duplicateWarnings?.length) {
        console.log('\n   Duplicate warnings:');
        result.duplicateWarnings.forEach(w => console.log(`   - ${w}`));
    }
    if (result.priceAlerts?.length) {
        console.log('\n   Price alerts:');
        result.priceAlerts.forEach(p => console.log(`   - ${p}`));
    }
}

main().catch(err => {
    console.error('\n❌ Failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
