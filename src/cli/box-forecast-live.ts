/**
 * @file    box-forecast-live.ts
 * @purpose Repeatable box forecast: live Finale stock + open-PO inbound + consumption
 *          derived from Finale's own purchase history (no external CSV required).
 *          Produces a bulk-order plan targeting coverage through the Black Friday peak.
 * @author  Hermia
 * @created 2026-10-06
 * @deps    @/lib/finale/client -> getProductActivity, getStockLevel
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 *
 * Usage: node --import tsx src/cli/box-forecast-live.ts [windowDays] [targetDays]
 *   windowDays  consumption lookback (default 180)
 *   targetDays  coverage horizon from today (default 101 = Oct 6 → Jan 15)
 */

import * as dotenv from 'dotenv';
import { pathToFileURL } from 'url';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

/** A consumption lane: one or more Finale SKUs that draw from the same physical box. */
interface LaneSpec {
    label: string;
    skus: string[];
    pack: number;
    /** Preferred switched vendor SKU (Surepack) */
    spSku?: string;
    spPrice?: number;
    ulinePrice: number;
}

const LANES: LaneSpec[] = [
    { label: '22×14×6', skus: ['S-4796', 'S-4905', 'SP-22146'], pack: 20, spSku: 'SP-22146', spPrice: 1.73, ulinePrice: 1.99 },
    { label: '12×12×6', skus: ['S-4122', 'SP-12126'], pack: 25, spSku: 'SP-12126', spPrice: 0.86, ulinePrice: 0.99 },
    { label: '12×12×12', skus: ['S-4125', 'SP-121212'], pack: 25, spSku: 'SP-121212', spPrice: 1.00, ulinePrice: 1.09 },
    { label: '12×6×6', skus: ['S-4128'], pack: 25, ulinePrice: 0.65 },
    { label: '9×5×5', skus: ['S-4092'], pack: 25, ulinePrice: 0.51 },
    { label: '24×14×10', skus: ['S-4738'], pack: 20, ulinePrice: 2.29 },
    { label: '12×12×8', skus: ['S-4124'], pack: 25, ulinePrice: 1.05 },
    { label: '30×15×15', skus: ['ULS455', 'SP-301515'], pack: 15, spSku: 'SP-301515', spPrice: 3.12, ulinePrice: 3.40 },
    { label: '24×13×31', skus: ['S-12610'], pack: 25, ulinePrice: 4.10 },
    { label: '15×15×30', skus: ['S-4412'], pack: 15, ulinePrice: 2.97 },
];

const BF_UPLIFT = 1.10;
/** A Committed PO older than this many days without receipt is treated as stale. */
const STALE_PO_DAYS = 120;

const WINDOW_DAYS = parseInt(process.argv[2] || '180', 10);
const TARGET_DAYS = parseInt(process.argv[3] || '101', 10);

interface SkuActivity {
    sku: string;
    stock: number;
    purchased: number;
    openPOs: { orderId: string; quantity: number; orderDate: string }[];
    lastPurchase: string | null;
    purchaseCount: number;
}

/**
 * Fetch stock, consumption and open POs for one SKU.
 * @param client Finale client
 * @param sku    Finale product ID
 * @param days   lookback window for purchase history
 */
async function fetchActivity(client: any, sku: string, days: number): Promise<SkuActivity | null> {
    try {
        const act = await client.getProductActivity(sku, days);
        // getStockLevel is the more reliable REST read; fall back to activity.stockOnHand
        let stock = act.stockOnHand ?? 0;
        try {
            const level = await client.getStockLevel(sku);
            if (level !== null && level !== undefined) stock = level;
        } catch { /* keep activity value */ }

        return {
            sku,
            stock,
            purchased: act.purchasedQty ?? 0,
            openPOs: act.openPOs ?? [],
            lastPurchase: act.lastPurchaseDate ?? null,
            purchaseCount: act.purchaseCount ?? 0,
        };
    } catch (e: any) {
        console.error(`  ⚠️  ${sku}: ${e.message}`);
        return null;
    }
}

/** Days between a Finale "M/D/YYYY" (or ISO) date and today. */
function ageDays(dateStr: string): number {
    if (!dateStr) return 0;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 0;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function pad(s: string | number, n: number): string { return String(s).padEnd(n); }

async function main() {
    const client: any = new FinaleClient();
    const today = new Date();
    const horizon = new Date(today.getTime() + TARGET_DAYS * 86400000);

    console.log('='.repeat(158));
    console.log(`  BOX FORECAST — live stock + open-PO inbound + ${WINDOW_DAYS}d consumption history`);
    console.log(`  Today: ${today.toLocaleDateString('en-US')}   Coverage horizon: ${horizon.toLocaleDateString('en-US')} (${TARGET_DAYS}d)   BF uplift: +10%`);
    console.log('='.repeat(158));
    console.log('');

    console.log(
        pad('Lane', 13) + pad('Stock', 8) + pad('Inbound', 10) + pad('Burn/mo', 10) +
        pad('BF+10%', 10) + pad('Runway', 9) + pad('BF Runway', 11) +
        pad('Proj @ horizon', 18) + pad('Order', 10) + pad('Cost', 11) + '  Status'
    );
    console.log('-'.repeat(158));

    interface Row {
        label: string; stock: number; inbound: number; breakDown: string;
        burnMonthly: number; runway: number; bfRunway: number;
        projAtHorizon: number; order: number; cost: number; vendor: string; price: number;
        packs: number;
    }
    const rows: Row[] = [];
    const skuWarnings: string[] = [];

    for (const lane of LANES) {
        let stock = 0;
        let purchased = 0;
        let inbound = 0;
        const parts: string[] = [];

        for (const sku of lane.skus) {
            const a = await fetchActivity(client, sku, WINDOW_DAYS);
            if (!a) continue;
            stock += a.stock;
            purchased += a.purchased;
            parts.push(`${sku}:${a.stock}`);

            for (const po of a.openPOs) {
                const age = ageDays(po.orderDate);
                if (age > STALE_PO_DAYS) {
                    skuWarnings.push(`${sku}: PO ${po.orderId} marked Committed but ordered ${age}d ago (${po.orderDate}) — treated as STALE, excluded`);
                    continue;
                }
                inbound += po.quantity;
            }
        }

        const daily = purchased / WINDOW_DAYS;
        const monthly = daily * 30.4;
        const bfDaily = daily * BF_UPLIFT;
        const bfMonthly = monthly * BF_UPLIFT;

        const totalAvail = stock + inbound;
        const runway = daily > 0 ? Math.round(totalAvail / daily) : 999;
        const bfRunway = bfDaily > 0 ? Math.round(totalAvail / bfDaily) : 999;

        // Projected position at the horizon (all consumption at BF+10% rate)
        const projAtHorizon = Math.round(totalAvail - bfDaily * TARGET_DAYS);

        // Order enough to land the horizon with a 30-day BF buffer
        const bufferTarget = Math.round(bfDaily * 30);
        let shortfall = bufferTarget - projAtHorizon;
        if (shortfall < 0) shortfall = 0;
        const pack = lane.pack || 25;
        const order = Math.ceil(shortfall / pack) * pack;

        const vendor = lane.spSku ? `Surepack ${lane.spSku}` : 'Uline';
        const price = lane.spPrice ?? lane.ulinePrice;
        const cost = order * price;

        rows.push({
            label: lane.label, stock, inbound, breakDown: parts.join(' '),
            burnMonthly: monthly, runway, bfRunway, projAtHorizon,
            order, cost, vendor, price, packs: order / pack,
        });

        const status = order > 0 ? (projAtHorizon < 0 ? '🔴 ORDER NOW' : '🟡 ORDER') : '✅ OK';

        console.log(
            pad(lane.label, 13) +
            pad(String(stock), 8) +
            pad(inbound > 0 ? `+${inbound}` : '—', 10) +
            pad(String(Math.round(monthly)), 10) +
            pad(String(Math.round(bfMonthly)), 10) +
            pad(runway >= 999 ? '∞' : `${runway}d`, 9) +
            pad(bfRunway >= 999 ? '∞' : `${bfRunway}d`, 11) +
            pad(projAtHorizon >= 0 ? `${projAtHorizon} (+${Math.round(projAtHorizon / (bfDaily || 1))}d)` : `${projAtHorizon} SHORT`, 18) +
            pad(order > 0 ? String(order) : '—', 10) +
            pad(order > 0 ? '$' + Math.round(cost).toLocaleString() : '—', 11) +
            '  ' + status
        );
    }

    console.log('\n' + '='.repeat(158));
    console.log('  BULK ORDER PLAN — place now, land before mid-October');
    console.log('='.repeat(158));
    console.log('');

    const orders = rows.filter(r => r.order > 0);
    if (orders.length === 0) {
        console.log('  Nothing to order — every lane holds through the horizon with a 30-day buffer.');
    }
    let total = 0;
    for (const o of orders) {
        total += o.cost;
        console.log(`  ${pad(o.label, 13)} ${String(o.order).padStart(6)} units (${String(o.packs).padStart(3)} packs) from ${pad(o.vendor, 22)} @ $${o.price.toFixed(3)} = $${Math.round(o.cost).toLocaleString()}`);
    }
    if (orders.length) {
        console.log('  ' + '─'.repeat(96));
        console.log(`  ${''.padEnd(13)} ${''.padStart(66)} TOTAL: $${Math.round(total).toLocaleString()}`);
    }

    console.log('\n' + '='.repeat(158));
    console.log('  STOCK BREAKDOWN (per SKU on hand)');
    console.log('='.repeat(158));
    for (const r of rows) {
        console.log(`  ${pad(r.label, 13)} ${r.breakDown}   → total ${r.stock}${r.inbound ? ` + ${r.inbound} inbound` : ''}`);
    }

    if (skuWarnings.length) {
        console.log('\n' + '='.repeat(158));
        console.log('  ⚠️  STALE / SUSPECT PO FLAGS');
        console.log('='.repeat(158));
        for (const w of skuWarnings) console.log(`  • ${w}`);
    }
    console.log('');
}

const isEntrypoint = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;

if (isEntrypoint) {
    main().catch(e => { console.error(e); process.exit(1); });
}
