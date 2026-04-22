import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import * as xlsx from 'xlsx';
import { FinaleClient } from '../lib/finale/client';

const filePath = 'C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/ULINE/MyOrderHistory.xlsx';

async function analyze() {
    const client = new FinaleClient();
    console.log("📦 Loading ULINE order history...\n");

    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawData = xlsx.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

    const dataRows = rawData.slice(5).filter((row: any) => row && row[0] && row[3]);

    interface OrderRow {
        date: Date;
        orderNum: string;
        category: string;
        sku: string;
        description: string;
        qty: number;
        extPrice: number;
    }

    const orders: OrderRow[] = [];
    for (const row of dataRows) {
        const dateStr = String(row[0] || '');
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) continue;
        const qty = parseFloat(row[5]) || 0;
        const extPrice = parseFloat(String(row[6] || '0').replace(/[$,]/g, '')) || 0;
        orders.push({
            date, orderNum: String(row[1] || ''), category: String(row[2] || '').toUpperCase(),
            sku: String(row[3] || '').trim(), description: String(row[4] || '').trim(), qty, extPrice
        });
    }

    const allBoxOrders = orders.filter(o => 
        o.description.toUpperCase().includes('BOX') || 
        o.description.toUpperCase().includes('CORRUGATED') ||
        o.description.toUpperCase().includes('BAG') ||
        o.description.toUpperCase().includes('WRAP')
    );

    const skuMap = new Map<string, { sku: string; description: string; category: string; totalQty: number; totalSpent: number; orderCount: number; lastOrder: Date; firstOrder: Date }>();
    for (const o of allBoxOrders) {
        if (!skuMap.has(o.sku)) {
            skuMap.set(o.sku, { sku: o.sku, description: o.description, category: o.category, totalQty: 0, totalSpent: 0, orderCount: 0, orders: new Set(), lastOrder: o.date, firstOrder: o.date });
        }
        const entry = skuMap.get(o.sku)!;
        entry.totalQty += o.qty;
        entry.totalSpent += o.extPrice;
        entry.orders.add(o.orderNum);
        entry.orderCount = entry.orders.size;
        if (o.date > entry.lastOrder) entry.lastOrder = o.date;
        if (o.date < entry.firstOrder) entry.firstOrder = o.date;
    }

    const reportStart = orders[orders.length - 1].date;
    const reportEnd = orders[0].date;
    const totalDays = Math.ceil((reportEnd.getTime() - reportStart.getTime()) / (1000 * 60 * 60 * 24));
    const quarterlyDays = 90;

    console.log(`Analyzing ${skuMap.size} box/packaging SKUs against Finale stock...\n`);

    const results = [];
    for (const [sku, data] of skuMap.entries()) {
        const unitCost = data.totalQty > 0 ? data.totalSpent / data.totalQty : 0;
        const dailyVel = data.totalQty / totalDays;
        const quarterlyNeed = Math.ceil(dailyVel * quarterlyDays);

        // Check Finale stock
        const activity = await client.getProductActivity(sku, 90);
        const openPOs = activity.openPOs || [];
        const onHand = activity.stockOnHand ?? 0;
        const inTransit = openPOs.reduce((sum: number, po: any) => sum + po.quantity, 0);
        const available = onHand + inTransit;
        const suggestedQty = Math.max(0, quarterlyNeed - available);

        results.push({
            SKU: sku,
            Description: data.description.length > 45 ? data.description.substring(0, 42) + '...' : data.description,
            'Unit Cost': unitCost.toFixed(2),
            'Daily Vel': dailyVel.toFixed(1),
            'Qtrly Need': quarterlyNeed,
            'On Hand': onHand,
            'In Transit': inTransit,
            'Available': available,
            'SUGGEST QTY': suggestedQty,
            'Est. Cost': suggestedQty > 0 ? `$${(suggestedQty * unitCost).toFixed(2)}` : '—',
            'Last Order': data.lastOrder.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
        });

        process.stdout.write(`✓ ${sku}: ${suggestedQty > 0 ? `Order ${suggestedQty}` : 'In stock'}\n`);
    }

    results.sort((a, b) => b['SUGGEST QTY'] - a['SUGGEST QTY']);

    console.log("\n\n=== ULINE QUARTERLY ORDER RECOMMENDATION ===");
    console.log(`Based on daily velocity × 90 days, minus current stock & in-transit POs\n`);

    console.log(`${'SKU'.padEnd(10)} | ${'Qtrly Need'.padEnd(12)} | ${'On Hand'.padEnd(10)} | ${'In Transit'.padEnd(11)} | ${'AVAILABLE'.padEnd(11)} | ${'SUGGEST QTY'.padEnd(14)} | ${'Est. Cost'.padEnd(12)} | ${'Description'}`);
    console.log("-".repeat(150));

    let totalSuggested = 0;
    let totalCost = 0;
    for (const r of results) {
        const flag = r['SUGGEST QTY'] > 0 ? '📦' : '  ';
        console.log(`${flag} ${r.SKU.padEnd(8)} | ${r['Qtrly Need'].toString().padEnd(12)} | ${r['On Hand'].toString().padEnd(10)} | ${r['In Transit'].toString().padEnd(11)} | ${r['Available'].toString().padEnd(11)} | ${r['SUGGEST QTY'].toString().padEnd(14)} | ${r['Est. Cost'].padEnd(12)} | ${r.Description}`);
        totalSuggested += r['SUGGEST QTY'];
        if (r['Est. Cost'] !== '—') totalCost += parseFloat(r['Est. Cost'].replace('$', ''));
    }

    console.log("\n" + "=".repeat(150));
    console.log(`TOTAL SUGGESTED: ${totalSuggested.toLocaleString()} units | Est. Cost: $${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`Note: Final order quantities should be rounded up to bundle increments (usually 20-25 per bundle).`);

    // Save to CSV
    const fs = require('fs');
    const csvLines = ['SKU,Description,Unit_Cost,Daily_Vel,Qtrly_Need,On_Hand,In_Transit,Available,Suggest_Qty,Est_Cost,Last_Order'];
    for (const r of results) {
        csvLines.push(`${r.SKU},"${r.Description}",${r['Unit Cost']},${r['Daily Vel']},${r['Qtrly Need']},${r['On Hand']},${r['In Transit']},${r['Available']},${r['SUGGEST QTY']},${r['Est. Cost'] === '—' ? '0' : r['Est. Cost'].replace('$', '')},${r['Last Order']}`);
    }
    fs.writeFileSync('uline-quarterly-order.csv', csvLines.join('\n'));
    console.log("\nCSV saved to uline-quarterly-order.csv");
}

analyze();
