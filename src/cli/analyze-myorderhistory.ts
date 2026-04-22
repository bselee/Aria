import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import * as xlsx from 'xlsx';

const filePath = 'C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/ULINE/MyOrderHistory.xlsx';

const workbook = xlsx.readFile(filePath);
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const rawData = xlsx.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

const dataRows = rawData.slice(5).filter((row: any) => row && row[0] && row[3]); // Skip metadata

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
    
    const orderNum = String(row[1] || '');
    const category = String(row[2] || '').toUpperCase();
    const sku = String(row[3] || '').trim();
    const description = String(row[4] || '').trim();
    const qty = parseFloat(row[5]) || 0;
    const extPrice = parseFloat(String(row[6] || '0').replace(/[$,]/g, '')) || 0;

    if (!sku || qty === 0) continue;
    orders.push({ date, orderNum, category, sku, description, qty, extPrice });
}

console.log(`Parsed ${orders.length} order lines from ${orders[0].date.toLocaleDateString()} to ${orders[orders.length-1].date.toLocaleDateString()}`);

// Filter for box/corrugated items
const boxKeywords = ['BOXES, CORRUGATED', 'BAGS, POLY', 'STRETCH WRAP', 'LABELS', 'ENVELOPES', 'CORRUGATED PAD'];
const boxOrders = orders.filter(o => 
    boxKeywords.some(k => o.category.includes(k))
);

// Also include items with "Box" or "Corrugated" in description
const allBoxOrders = orders.filter(o => 
    o.description.toUpperCase().includes('BOX') || 
    o.description.toUpperCase().includes('CORRUGATED') ||
    o.description.toUpperCase().includes('BAG') ||
    o.description.toUpperCase().includes('WRAP')
);

// Use allBoxOrders for more comprehensive view
const analysisOrders = allBoxOrders;

// Aggregate by SKU
const skuMap = new Map<string, { 
    sku: string; 
    description: string; 
    category: string;
    totalQty: number; 
    totalSpent: number; 
    orderCount: number;
    orders: Set<string>;
    lastOrder: Date;
    firstOrder: Date;
}>();

for (const o of analysisOrders) {
    if (!skuMap.has(o.sku)) {
        skuMap.set(o.sku, {
            sku: o.sku,
            description: o.description,
            category: o.category,
            totalQty: 0,
            totalSpent: 0,
            orderCount: 0,
            orders: new Set(),
            lastOrder: o.date,
            firstOrder: o.date
        });
    }
    const entry = skuMap.get(o.sku)!;
    entry.totalQty += o.qty;
    entry.totalSpent += o.extPrice;
    entry.orders.add(o.orderNum);
    entry.orderCount = entry.orders.size;
    if (o.date > entry.lastOrder) entry.lastOrder = o.date;
    if (o.date < entry.firstOrder) entry.firstOrder = o.date;
}

// Calculate time span and velocity
const reportStart = orders[orders.length - 1].date;
const reportEnd = orders[0].date;
const totalDays = Math.ceil((reportEnd.getTime() - reportStart.getTime()) / (1000 * 60 * 60 * 24));
const daysPerYear = 365;

const results = [];
for (const [sku, data] of skuMap.entries()) {
    const unitCost = data.totalQty > 0 ? data.totalSpent / data.totalQty : 0;
    const dailyVel = data.totalQty / totalDays;
    const yearlyProjection = dailyVel * daysPerYear;
    
    results.push({
        SKU: sku,
        Description: data.description.length > 50 ? data.description.substring(0, 47) + '...' : data.description,
        '2Y Qty': data.totalQty,
        'Orders': data.orderCount,
        '$/unit': unitCost.toFixed(2),
        'Total Spent': `$${data.totalSpent.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        'Yearly Est': Math.round(yearlyProjection).toLocaleString(),
        'Daily Vel': dailyVel.toFixed(1),
        'Last Order': data.lastOrder.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
    });
}

results.sort((a, b) => parseInt(b['2Y Qty'].toString().replace(/,/g, '')) - parseInt(a['2Y Qty'].toString().replace(/,/g, '')));

// Print
console.log("\n=== ULINE BOX & PACKAGING CONSUMPTION ANALYSIS ===");
console.log(`Report Period: ${reportStart.toLocaleDateString()} to ${reportEnd.toLocaleDateString()} (${totalDays} days)\n`);

console.log(`${'SKU'.padEnd(10)} | ${'2Y Qty'.padEnd(10)} | ${'Yearly Est'.padEnd(12)} | ${'Daily Vel'.padEnd(10)} | ${'$/unit'.padEnd(8)} | ${'Orders'.padEnd(7)} | ${'Last'.padEnd(8)} | ${'Description'}`);
console.log("-".repeat(140));

for (const r of results.slice(0, 20)) {
    console.log(`${r.SKU.padEnd(10)} | ${r['2Y Qty'].toString().padEnd(10)} | ${r['Yearly Est'].padEnd(12)} | ${r['Daily Vel'].padEnd(10)} | ${r['$/unit'].padEnd(8)} | ${r['Orders'].toString().padEnd(7)} | ${r['Last Order'].padEnd(8)} | ${r.Description}`);
}

// Totals
const totalQty2Y = results.reduce((sum, r) => sum + parseInt(r['2Y Qty'].toString().replace(/,/g, '')), 0);
const totalSpent2Y = results.reduce((sum, r) => sum + parseFloat(r['Total Spent'].replace(/[$,]/g, '')), 0);

console.log("\n" + "=".repeat(140));
console.log(`TOTAL: ${totalQty2Y.toLocaleString()} units over 2 years | $${totalSpent2Y.toLocaleString('en-US', { minimumFractionDigits: 2 })} spent on boxes/packaging`);

// Save to CSV
const fs = require('fs');
const csvLines = ['SKU,Description,2Y_Qty,Yearly_Est,Daily_Vel,Unit_Cost,Order_Count,Last_Order,Category'];
for (const r of results) {
    csvLines.push(`${r.SKU},"${r.Description}",${r['2Y Qty']},${r['Yearly Est']},${r['Daily Vel']},${r['$/unit']},${r['Orders']},${r['Last Order']}`);
}
fs.writeFileSync('uline-box-consumption-analysis.csv', csvLines.join('\n'));
console.log("\nCSV saved to uline-box-consumption-analysis.csv");
