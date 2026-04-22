import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import * as xlsx from 'xlsx';

const filePath = 'C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/ULINE/MyOrderHistory.xlsx';

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
    orders.push({ date, orderNum: String(row[1] || ''), category: String(row[2] || '').toUpperCase(), sku: String(row[3] || '').trim(), description: String(row[4] || '').trim(), qty, extPrice });
}

// Filter to box/packaging items only
const allBoxOrders = orders.filter(o => 
    o.description.toUpperCase().includes('BOX') || 
    o.description.toUpperCase().includes('CORRUGATED') ||
    o.description.toUpperCase().includes('BAG') ||
    o.description.toUpperCase().includes('WRAP') ||
    o.description.toUpperCase().includes('LABEL') ||
    o.description.toUpperCase().includes('ENVELOPE')
);

// Aggregate by SKU
const skuMap = new Map<string, { sku: string; description: string; category: string; totalQty: number; totalSpent: number; orderCount: number; lastOrder: Date }>();
for (const o of allBoxOrders) {
    if (!skuMap.has(o.sku)) {
        skuMap.set(o.sku, { sku: o.sku, description: o.description, category: o.category, totalQty: 0, totalSpent: 0, orderCount: 0, orders: new Set(), lastOrder: o.date });
    }
    const entry = skuMap.get(o.sku)!;
    entry.totalQty += o.qty;
    entry.totalSpent += o.extPrice;
    entry.orders.add(o.orderNum);
    entry.orderCount = entry.orders.size;
    if (o.date > entry.lastOrder) entry.lastOrder = o.date;
}

// Calculate velocity and quarterly needs
const quarterlyDays = 90;
const reportEnd = orders[0].date;
const reportStart = orders[orders.length - 1].date;
const totalDays = Math.ceil((reportEnd.getTime() - reportStart.getTime()) / (1000 * 60 * 60 * 24));

const results = [];
for (const [sku, data] of skuMap.entries()) {
    const unitCost = data.totalQty > 0 ? data.totalSpent / data.totalQty : 0;
    const dailyVel = data.totalQty / totalDays;
    const quarterlyNeed = Math.ceil(dailyVel * quarterlyDays);
    
    // Round up to bundle size (most boxes come in bundles of 20-25)
    const bundleSize = 25;
    const suggestedQty = Math.ceil(quarterlyNeed / bundleSize) * bundleSize;

    results.push({
        SKU: sku,
        Description: data.description.length > 50 ? data.description.substring(0, 47) + '...' : data.description,
        'Unit Cost': unitCost.toFixed(2),
        'Daily Vel': dailyVel.toFixed(1),
        'Qtrly Need': quarterlyNeed,
        'SUGGEST QTY': suggestedQty,
        'Est. Cost': `$${(suggestedQty * unitCost).toFixed(2)}`,
        'Last Order': data.lastOrder.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
    });
}

results.sort((a, b) => b['SUGGEST QTY'] - a['SUGGEST QTY']);

console.log("\n=== ULINE QUARTERLY ORDER (Based on Consumption Only) ===");
console.log(`Report Period: ${reportStart.toLocaleDateString()} to ${reportEnd.toLocaleDateString()}`);
console.log(`Based on ${totalDays} days of order history | Quarterly = 90 days\n`);

console.log(`${'SKU'.padEnd(10)} | ${'Qtrly Need'.padEnd(12)} | ${'SUGGEST QTY'.padEnd(14)} | ${'Est. Cost'.padEnd(12)} | ${'Last'.padEnd(8)} | ${'Description'}`);
console.log("-".repeat(130));

let totalQty = 0;
let totalCost = 0;
for (const r of results) {
    console.log(`${r.SKU.padEnd(10)} | ${r['Qtrly Need'].toString().padEnd(12)} | ${r['SUGGEST QTY'].toString().padEnd(14)} | ${r['Est. Cost'].padEnd(12)} | ${r['Last Order'].padEnd(8)} | ${r.Description}`);
    totalQty += r['SUGGEST QTY'];
    totalCost += parseFloat(r['Est. Cost'].replace('$', ''));
}

console.log("\n" + "=".repeat(130));
console.log(`TOTAL: ${totalQty.toLocaleString()} units | $${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

// Save to CSV
const fs = require('fs');
const csvLines = ['SKU,Description,Unit_Cost,Daily_Vel,Qtrly_Need,Suggest_Qty,Est_Cost,Last_Order'];
for (const r of results) {
    csvLines.push(`${r.SKU},"${r.Description}",${r['Unit Cost']},${r['Daily Vel']},${r['Qtrly Need']},${r['SUGGEST QTY']},${r['Est. Cost'] === '—' ? '0' : r['Est. Cost'].replace('$', '')},${r['Last Order']}`);
}
fs.writeFileSync('uline-quarterly-order-consumption.csv', csvLines.join('\n'));
console.log("\nCSV saved to uline-quarterly-order-consumption.csv");
