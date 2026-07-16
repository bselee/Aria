import { FinaleClient } from '@/lib/finale/client';

async function main() {
    const c = new FinaleClient() as any;

    // Key box SKUs
    const skus = ['S-4796', 'SP22146', 'S-4122', 'SP12126', 'S-4125', 'SP-121212', 'ULS455', 'SP301515', 'S-4128', 'S-4092', 'S-4124', 'S-4738'];

    console.log("SKU".padEnd(14), "OnHand".padEnd(8), "OnOrder".padEnd(8), "Demand90d".padEnd(12), "Demand/mo".padEnd(10), "StockoutDays".padEnd(14), "QtyRec".padEnd(8));
    console.log("-".repeat(100));

    for (const sku of skus) {
        try {
            const p = await (c as any).getComponentStockProfile(sku);
            const onHand = p.onHand ?? 0;
            const onOrder = p.onOrder ?? 0;
            const stockoutDays = p.stockoutDays ?? 0;
            // demand velocity
            const demand90d = p.demand90 ?? p.demand ?? 0;
            const demandMo = Math.round(demand90d / 3);
            const qtyRec = p.recommendedQty ?? 0;

            console.log(
                sku.padEnd(14),
                String(onHand).padStart(6),
                String(onOrder).padStart(6),
                String(demand90d).padStart(10),
                String(demandMo).padStart(8),
                String(stockoutDays).padStart(10),
                String(qtyRec).padStart(8)
            );
        } catch (e: any) {
            console.log(sku.padEnd(14), 'ERR:', e.message);
        }
    }

    // Get purchasing intelligence for the key sizes
    console.log("\n\n--- Purchasing Intelligence ---");
    for (const sku of ['S-4796', 'S-4122', 'S-4125']) {
        try {
            const pi = await (c as any).getComponentPurchasingIntelligence(sku);
            console.log(`\n${sku}:`);
            console.log(JSON.stringify(pi, null, 2).slice(0, 800));
        } catch (e: any) {
            console.log(sku, 'ERR:', e.message);
        }
    }
}
main().catch(e => console.error(e));
