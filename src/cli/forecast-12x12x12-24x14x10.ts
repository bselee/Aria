import { readFileSync } from 'fs';

const raw = readFileSync('C:\\Users\\BuildASoil\\Downloads\\MyOrderHistory.csv', 'utf-8');
const lines = raw.split('\n').filter(Boolean);

function parseCSV(line: string): string[] {
    const res: string[] = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
        else if (ch === ',' && !inQ) { res.push(cur.trim()); cur = ''; }
        else cur += ch;
    }
    res.push(cur.trim());
    return res;
}

const hdr = lines.findIndex(l => l.startsWith('Date,Order #,Category'));
const data = lines.slice(hdr + 1).map(l => parseCSV(l));
const boxLines = data.filter(r => (r[2] || '').includes('Boxes, Corrugated'));

// S-4125 = 12×12×12  |  S-4738 = 24×14×10
const target = [
    { sku: 'S-4125', label: '12×12×12', spSku: 'SP-121212', ulinePrice: 1.09, surepackPrice: 1.00 },
    { sku: 'S-4738', label: '24×14×10', spSku: null, ulinePrice: 2.29, surepackPrice: null },
];

const sixMoAgo = new Date();
sixMoAgo.setMonth(sixMoAgo.getMonth() - 6);
const twoYrAgo = new Date();
twoYrAgo.setFullYear(twoYrAgo.getFullYear() - 2);

function getDate(d: string): Date {
    const p = d.split('/');
    return new Date(parseInt(p[2]), parseInt(p[0])-1, parseInt(p[1]));
}

for (const t of target) {
    const orders = boxLines.filter(r => (r[3] || '').trim() === t.sku);
    const total2yr = orders.filter(r => getDate(r[0]) >= twoYrAgo);
    const total6mo = orders.filter(r => getDate(r[0]) >= sixMoAgo);

    const qty2yr = total2yr.reduce((s, r) => s + (parseInt(r[5]) || 0), 0);
    const qty6mo = total6mo.reduce((s, r) => s + (parseInt(r[5]) || 0), 0);
    const count2yr = total2yr.length;
    const count6mo = total6mo.length;
    const annualRate = Math.round(qty2yr / 2);

    // Monthly breakdown last 6 months
    const monthly: Record<string, number> = {};
    for (const r of total6mo) {
        const d = getDate(r[0]);
        const mo = `${d.toLocaleString('en', { month: 'short' })} ${d.getFullYear().toString().slice(-2)}`;
        monthly[mo] = (monthly[mo] || 0) + (parseInt(r[5]) || 0);
    }

    const daily6mo = (qty6mo / 182).toFixed(1);
    const monthly6mo = Math.round(qty6mo / 6);

    console.log(`━━━ ${t.label} (${t.sku}) ━━━`);
    console.log(`Current stock: 494 (S-4125) / 0 (SP-121212)`);
    console.log("");
    console.log(`Uline Order History:`);
    console.log(`  2yr: ${qty2yr.toLocaleString()} units (${count2yr} orders) → ${annualRate.toLocaleString()}/yr`);
    console.log(`  6mo: ${qty6mo.toLocaleString()} units (${count6mo} orders) → ${daily6mo}/day → ${monthly6mo}/mo`);
    console.log(`  Avg order: ${count2yr > 0 ? Math.round(qty2yr / count2yr).toLocaleString() : 0} units`);

    // Monthly breakdown
    if (Object.keys(monthly).length > 0) {
        console.log(`  Recent: ${Object.entries(monthly).sort(([a],[b]) => a.localeCompare(b)).map(([m,q]) => `${m}: ${q.toLocaleString()}`).join(', ')}`);
    }

    console.log("");
    console.log(`Pricing:`);
    console.log(`  Uline ${t.sku}: $${t.ulinePrice.toFixed(3)}/unit`);
    if (t.surepackPrice && t.spSku) {
        console.log(`  Surepack ${t.spSku}: $${t.surepackPrice.toFixed(3)}/unit (saves $${(t.ulinePrice - t.surepackPrice).toFixed(3)})`);
    }
    console.log("");

    // Stock and runway
    const stock = t.label === '12×12×12' ? 494 : 884; // from earlier check
    const consumptionDaily = parseFloat(daily6mo);
    const consumptionMo = monthly6mo;
    const runwayDays = consumptionDaily > 0 ? Math.round(stock / consumptionDaily) : 999;

    console.log(`Stock & Runway:`);
    console.log(`  Stock: ${stock.toLocaleString()} units → ${runwayDays}d (${(runwayDays/30).toFixed(1)}mo) at ${consumptionDaily}/day`);
    console.log("");

    // 6-month outlook
    console.log("6-Month Outlook:");

    // For 12×12×12: Recommend switch to Surepack
    if (t.label === '12×12×12') {
        const need6mo = consumptionMo * 6;
        const pack = 25;
        const toOrder = Math.ceil((need6mo - stock) / pack) * pack;
        const costSP = toOrder * t.surepackPrice!;
        const costUline = toOrder * t.ulinePrice;
        const savings = costUline - costSP;
        const totalAfter = stock + toOrder;
        const moCovered = (totalAfter / consumptionMo).toFixed(1);

        console.log(`  Month    | Stock In | Burn     | Stock Out`);
        console.log(`  ─────────┼──────────┼──────────┼──────────`);
        let running = stock;
        const months = ['Jul 26','Aug 26','Sep 26','Oct 26','Nov 26','Dec 26','Jan 27'];
        for (const m of months) {
            const before = running;
            if (running < 0) running = 0;
            if (running < consumptionMo && running > 0 && m === months[0]) {
                // Order arrives this month
                console.log(`  ${m} | ${String(Math.max(0, before)).padStart(6)} | ${String(consumptionMo).padStart(6)} | ${String(Math.max(0, before + toOrder - consumptionMo)).padStart(6)} (order ${toOrder} SP ⚡)`);
                running = before + toOrder - consumptionMo;
            } else if (running <= 0) {
                console.log(`  ${m} | ${String(0).padStart(6)} | ${String(0).padStart(6)} | ${String(0).padStart(6)} (STOCKOUT)`);
            } else {
                running -= consumptionMo;
                console.log(`  ${m} | ${String(Math.max(0, before)).padStart(6)} | ${String(consumptionMo).padStart(6)} | ${String(Math.max(0, running)).padStart(6)}`);
            }
        }

        console.log(`\n  Recommendation: Order ${toOrder} units of ${t.spSku} from Surepack`);
        console.log(`  Cost: $${Math.round(costSP).toLocaleString()}  (vs $${Math.round(costUline).toLocaleString()} Uline — save $${Math.round(savings).toLocaleString()})`);
        console.log(`  Covers ${moCovered} months total.`);
    }

    // For 24×14×10: No Surepack alternative, plan Uline orders
    if (t.label === '24×14×10') {
        const need6mo = consumptionMo * 6;
        console.log(`  Month    | Stock In | Burn     | Stock Out`);
        console.log(`  ─────────┼──────────┼──────────┼──────────`);
        let running = stock;
        const months = ['Jul 26','Aug 26','Sep 26','Oct 26','Nov 26','Dec 26','Jan 27'];
        for (const m of months) {
            const before = running;
            if (running < 0) running = 0;
            // Typical Uline order qty from history: ~568 units
            if (running < consumptionMo * 2 && running > 0) {
                const orderQty = 570;
                const cost = Math.round(orderQty * t.ulinePrice);
                running = before + orderQty - consumptionMo;
                console.log(`  ${m} | ${String(before).padStart(6)} | ${String(consumptionMo).padStart(6)} | ${String(Math.max(0, running)).padStart(6)} (order ${orderQty} Uline $${cost.toLocaleString()})`);
            } else {
                running -= consumptionMo;
                console.log(`  ${m} | ${String(before).padStart(6)} | ${String(consumptionMo).padStart(6)} | ${String(Math.max(0, running)).padStart(6)}`);
            }
        }

        console.log(`\n  Recommendation: Stock is healthy (5.4mo runway). Next order ~Dec 2026.`);
        console.log(`  Typical order: 500-600 units from Uline at ~$2.29 = ~$1,260/order.`);
    }

    console.log("");
}
