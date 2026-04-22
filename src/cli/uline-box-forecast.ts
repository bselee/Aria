import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

async function getUlineBoxConsumption() {
    const client: any = new FinaleClient();
    console.log("📦 Analyzing ULINE box consumption and 2026 forecast...");

    try {
        const today = new Date();
        const startOfYear = new Date(today.getFullYear(), 0, 1);
        const daysYTD = Math.ceil((today.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24));
        const daysRemaining = 365 - daysYTD;

        // Step 1: Get recent Uline PO items (last 365 days)
        const recentPOs = await client.getRecentPurchaseOrders(365, 500);
        const ulinePOs = recentPOs.filter((po: any) => 
            po.vendorName.toUpperCase().includes('ULINE') && 
            po.status === 'Completed'
        );

        const skuTotals = new Map();
        for (const po of ulinePOs) {
            for (const item of po.items) {
                const qty = typeof item.quantity === 'string' ? parseFloat(item.quantity) : item.quantity;
                skuTotals.set(item.productId, (skuTotals.get(item.productId) || 0) + qty);
            }
        }

        console.log(`Found ${skuTotals.size} unique ULINE SKUs with purchase history.`);

        const results = [];
        for (const [sku, totalPurchased] of skuTotals.entries()) {
            const product = await client.lookupProduct(sku);
            if (!product) continue;

            const name = product.name.toUpperCase();
            // Filter for boxes and related supplies
            if (!name.includes('BOX') && !name.includes('CORRUGATED') && !sku.startsWith('ULS') && !name.includes('BAG')) {
                continue;
            }

            const dailyVel = totalPurchased / 365;
            const activity = await client.getProductActivity(sku, 365);

            results.push({
                SKU: sku,
                Description: product.name,
                'Daily Vel': dailyVel.toFixed(2),
                'YTD Est Cons': Math.round(dailyVel * daysYTD),
                'Forc Rem': Math.round(dailyVel * daysRemaining),
                'Total 26 Est': Math.round(totalPurchased),
                'On Hand': activity.stockOnHand ?? 0,
                'Last Purchase': activity.lastPurchaseDate || 'N/A'
            });
        }

        results.sort((a, b) => b['Total 26 Est'] - a['Total 26 Est']);

        console.log("\n--- ULINE CONSUMPTION & 2026 FORECAST ---");
        console.log("Based on last 365 days of purchase history\n");
        
        console.log(`${'SKU'.padEnd(12)} | ${'YTD Cons'.padEnd(10)} | ${'Forc Rem'.padEnd(10)} | ${'Total 26'.padEnd(10)} | ${'On Hand'.padEnd(8)} | ${'Description'}`);
        console.log("-".repeat(110));
        
        results.forEach(r => {
            console.log(`${r.SKU.padEnd(12)} | ${r['YTD Est Cons'].toString().padEnd(10)} | ${r['Forc Rem'].toString().padEnd(10)} | ${r['Total 26 Est'].toString().padEnd(10)} | ${r['On Hand'].toString().padEnd(8)} | ${r.Description}`);
        });

        process.exit(0);
    } catch (err) {
        console.error("Error:", err.message);
        process.exit(1);
    }
}

getUlineBoxConsumption();
