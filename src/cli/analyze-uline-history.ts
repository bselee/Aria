/**
 * @file    analyze-uline-history.ts
 * @purpose Run monthly/quarterly/yearly consumption analysis on the ULINE
 *          MyOrderHistory.xlsx export dropped in the Sandbox. ULINE is the
 *          source of truth for what we actually bought from them — this
 *          complements the Finale-based product_consumption_analysis tool.
 * @usage   node --import tsx src/cli/analyze-uline-history.ts [path] [--top N]
 */

import XLSX from 'xlsx';
import path from 'node:path';

const DEFAULT_PATH = 'C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/ULINE/MyOrderHistory.xlsx';

type Row = {
    date: Date;
    orderNo: string;
    category: string;
    sku: string;
    description: string;
    qty: number;
    extPrice: number;
};

type Bucket = { period: string; qty: number; spend: number; orders: Set<string> };

function bucketKey(d: Date, kind: 'month' | 'quarter' | 'year'): string {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    if (kind === 'year') return String(y);
    if (kind === 'quarter') return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    return `${y}-${String(m).padStart(2, '0')}`;
}

function addToBucket(map: Map<string, Bucket>, key: string, qty: number, spend: number, orderNo: string) {
    let b = map.get(key);
    if (!b) { b = { period: key, qty: 0, spend: 0, orders: new Set() }; map.set(key, b); }
    b.qty += qty;
    b.spend += spend;
    b.orders.add(orderNo);
}

function fmt(n: number, digits = 0): string {
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtUSD(n: number): string {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

async function main() {
    const args = process.argv.slice(2);
    const topIdx = args.indexOf('--top');
    const top = topIdx >= 0 ? parseInt(args[topIdx + 1] || '15', 10) : 15;
    const filePath = args.find((a, i) => !a.startsWith('--') && i !== topIdx + 1) || DEFAULT_PATH;

    console.log(`\n📊 ULINE Consumption Analysis`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Source: ${path.basename(filePath)}`);

    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: null });

    // Header row is at index 4: Date | Order # | Category | Model # | Description | Qty | Ext. Price
    const rows: Row[] = [];
    for (let i = 5; i < raw.length; i++) {
        const r = raw[i];
        if (!r || !r[0] || !r[3]) continue;
        const dateStr = String(r[0]);
        const [mm, dd, yyyy] = dateStr.split('/');
        const d = new Date(Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10)));
        if (isNaN(d.getTime())) continue;
        rows.push({
            date: d,
            orderNo: String(r[1] ?? ''),
            category: String(r[2] ?? ''),
            sku: String(r[3] ?? '').trim(),
            description: String(r[4] ?? '').replace(/&reg;|&trade;/g, '').trim(),
            qty: Number(r[5]) || 0,
            extPrice: Number(r[6]) || 0,
        });
    }

    if (rows.length === 0) {
        console.log('No order rows parsed — file layout may have changed.');
        return;
    }

    const dates = rows.map(r => r.date.getTime());
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const windowDays = Math.round((maxDate.getTime() - minDate.getTime()) / 86400000) + 1;

    console.log(`Window: ${minDate.toISOString().slice(0, 10)} → ${maxDate.toISOString().slice(0, 10)}  (${windowDays}d)`);
    console.log(`Line items: ${rows.length}  ·  Unique SKUs: ${new Set(rows.map(r => r.sku)).size}  ·  Orders: ${new Set(rows.map(r => r.orderNo)).size}`);

    // ─── Overall period rollups ───
    const overallMonth = new Map<string, Bucket>();
    const overallQtr = new Map<string, Bucket>();
    const overallYear = new Map<string, Bucket>();
    for (const r of rows) {
        addToBucket(overallMonth, bucketKey(r.date, 'month'), r.qty, r.extPrice, r.orderNo);
        addToBucket(overallQtr, bucketKey(r.date, 'quarter'), r.qty, r.extPrice, r.orderNo);
        addToBucket(overallYear, bucketKey(r.date, 'year'), r.qty, r.extPrice, r.orderNo);
    }

    const totalSpend = rows.reduce((s, r) => s + r.extPrice, 0);
    const totalQty = rows.reduce((s, r) => s + r.qty, 0);

    console.log(`\n💰 Overall spend: ${fmtUSD(totalSpend)}  ·  Total units: ${fmt(totalQty)}`);

    console.log(`\n📅 YEARLY`);
    for (const y of [...overallYear.values()].sort((a, b) => a.period.localeCompare(b.period))) {
        console.log(`  ${y.period}  ·  ${fmtUSD(y.spend).padStart(10)}  ·  ${fmt(y.qty).padStart(8)} units  ·  ${y.orders.size} orders`);
    }

    console.log(`\n📅 QUARTERLY`);
    for (const q of [...overallQtr.values()].sort((a, b) => a.period.localeCompare(b.period))) {
        console.log(`  ${q.period}  ·  ${fmtUSD(q.spend).padStart(10)}  ·  ${fmt(q.qty).padStart(8)} units  ·  ${q.orders.size} orders`);
    }

    console.log(`\n📅 MONTHLY`);
    for (const m of [...overallMonth.values()].sort((a, b) => a.period.localeCompare(b.period))) {
        console.log(`  ${m.period}  ·  ${fmtUSD(m.spend).padStart(10)}  ·  ${fmt(m.qty).padStart(8)} units`);
    }

    // ─── Per-SKU aggregates ───
    type SkuAgg = {
        sku: string;
        description: string;
        category: string;
        totalQty: number;
        totalSpend: number;
        orderCount: number;
        firstSeen: Date;
        lastSeen: Date;
    };
    const skuMap = new Map<string, SkuAgg>();
    for (const r of rows) {
        let a = skuMap.get(r.sku);
        if (!a) {
            a = {
                sku: r.sku, description: r.description, category: r.category,
                totalQty: 0, totalSpend: 0, orderCount: 0,
                firstSeen: r.date, lastSeen: r.date,
            };
            skuMap.set(r.sku, a);
        }
        a.totalQty += r.qty;
        a.totalSpend += r.extPrice;
        a.orderCount += 1;
        if (r.date < a.firstSeen) a.firstSeen = r.date;
        if (r.date > a.lastSeen) a.lastSeen = r.date;
    }

    const bySpend = [...skuMap.values()].sort((a, b) => b.totalSpend - a.totalSpend);

    console.log(`\n🏆 TOP ${top} SKUs BY SPEND (${windowDays}d window)`);
    console.log(`${'SKU'.padEnd(14)} ${'qty'.padStart(8)} ${'spend'.padStart(10)} ${'per mo'.padStart(8)} ${'per qtr'.padStart(8)} ${'per yr'.padStart(9)}  description`);
    const perDay = (q: number) => q / windowDays;
    for (const a of bySpend.slice(0, top)) {
        const pd = perDay(a.totalQty);
        console.log(
            `${a.sku.padEnd(14)} ${fmt(a.totalQty).padStart(8)} ${fmtUSD(a.totalSpend).padStart(10)} ` +
            `${fmt(pd * 30, 1).padStart(8)} ${fmt(pd * 91, 1).padStart(8)} ${fmt(pd * 365, 0).padStart(9)}  ` +
            `${a.description.slice(0, 55)}`
        );
    }

    // ─── By category rollup ───
    const catMap = new Map<string, { spend: number; qty: number; skus: Set<string> }>();
    for (const r of rows) {
        let c = catMap.get(r.category);
        if (!c) { c = { spend: 0, qty: 0, skus: new Set() }; catMap.set(r.category, c); }
        c.spend += r.extPrice; c.qty += r.qty; c.skus.add(r.sku);
    }
    const catSorted = [...catMap.entries()].sort((a, b) => b[1].spend - a[1].spend);
    console.log(`\n📂 BY CATEGORY`);
    for (const [cat, c] of catSorted) {
        console.log(`  ${cat.padEnd(28)} ${fmtUSD(c.spend).padStart(10)}  ${fmt(c.qty).padStart(7)} units  (${c.skus.size} SKUs)`);
    }

    // ─── Velocity flags — SKUs with zero orders in last 6 months ───
    const sixMoAgo = new Date(maxDate.getTime() - 180 * 86400000);
    const dormant = bySpend.filter(a => a.lastSeen < sixMoAgo && a.totalSpend > 100);
    if (dormant.length > 0) {
        console.log(`\n⚠️  DORMANT SKUs (no orders in last 6mo, but >$100 lifetime spend): ${dormant.length}`);
        for (const a of dormant.slice(0, 10)) {
            console.log(`  ${a.sku.padEnd(14)}  last: ${a.lastSeen.toISOString().slice(0, 10)}  ·  lifetime: ${fmtUSD(a.totalSpend)}  ·  ${a.description.slice(0, 50)}`);
        }
    }

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Per-SKU aggregates available for ${skuMap.size} SKUs.`);
    console.log(`Run \`product_consumption_analysis\` in Aria to cross-check Finale stock vs ULINE velocity.\n`);
}

main().catch(err => {
    console.error('Analysis failed:', err);
    process.exit(1);
});
