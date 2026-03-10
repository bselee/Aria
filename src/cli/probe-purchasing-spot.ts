/**
 * Spot-check specific known SKUs to validate purchasing intelligence output format.
 * Usage: node --import tsx src/cli/probe-purchasing-spot.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { FinaleClient } from '../lib/finale/client';

const client = new FinaleClient();
const base = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const account = process.env.FINALE_ACCOUNT_PATH || '';
const apiKey = process.env.FINALE_API_KEY || '';
const apiSecret = process.env.FINALE_API_SECRET || '';
const auth = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

const testSkus = ['S-4092', 'S-4128', 'S-445', 'ACP101', 'ACTV102'];

async function run() {
    for (const sku of testSkus) {
        console.log(`\n── ${sku}`);
        try {
            const [prodData, purchaseData, salesData, openPOs] = await Promise.all([
                fetch(`${base}/${account}/api/product/${encodeURIComponent(sku)}`, {
                    headers: { Authorization: auth, Accept: 'application/json' }
                }).then(r => r.json()),
                client.getPurchasedQty(sku, 90),
                client.getSalesQty(sku, 90),
                client.findCommittedPOsForProduct(sku),
            ]);

            if (!prodData?.productId) { console.log('  not found'); continue; }

            const stockOnHand = parseFloat(String(prodData.quantityOnHand ?? 0).replace(/,/g, '')) || 0;
            const stockOnOrder = openPOs.reduce((s: number, po: any) => s + po.quantityOnOrder, 0);
            const purchaseVelocity = purchaseData.totalQty / 90;
            const salesVelocity = salesData.totalSoldQty / 90;
            const dailyRate = Math.max(purchaseVelocity, salesVelocity);
            const rawLead = prodData.leadTime != null ? parseInt(String(prodData.leadTime), 10) : NaN;
            const leadTimeDays = !isNaN(rawLead) && rawLead > 0 ? rawLead : 14;

            if (dailyRate === 0) { console.log('  zero velocity — would be skipped'); continue; }

            const runwayDays = stockOnHand / dailyRate;
            const adjustedRunwayDays = (stockOnHand + stockOnOrder) / dailyRate;
            const rateSource = purchaseVelocity >= salesVelocity ? 'receipts' : 'shipments';
            const suggestedQty = Math.max(50, Math.ceil(dailyRate * (leadTimeDays + 60) / 50) * 50);
            // DECISION(2026-03-09): Use adjusted runway (on-hand + on-order) for urgency.
            // Raw runwayDays caused items with active POs to falsely flag as CRITICAL.
            const urgency = adjustedRunwayDays < leadTimeDays ? 'CRITICAL'
                : adjustedRunwayDays < leadTimeDays + 30 ? 'WARNING'
                    : adjustedRunwayDays < leadTimeDays + 60 ? 'WATCH'
                        : 'OK';

            // Resolve vendor name
            const suppliers = prodData.supplierList || [];
            const main = suppliers.find((s: any) => s.supplierPrefOrderId?.includes('MAIN')) || suppliers[0];
            let vendorName = 'Unknown';
            if (main?.supplierPartyUrl) {
                const pid = main.supplierPartyUrl.split('/').pop();
                const pr = await fetch(`${base}/${account}/api/partygroup/${pid}`, {
                    headers: { Authorization: auth, Accept: 'application/json' }
                });
                const pd = await pr.json();
                vendorName = pd.groupName || 'Unknown';
            }

            const parts: string[] = [
                `Avg ${dailyRate.toFixed(1)}/day (90d ${rateSource})`,
                `${Math.round(stockOnHand)} in stock → ${Math.round(runwayDays)}d`,
                `Lead ${leadTimeDays}d`,
            ];
            if (stockOnOrder > 0) {
                parts.push(`${openPOs.length} open PO (+${Math.round(stockOnOrder)}) → ${Math.round(adjustedRunwayDays)}d adjusted`);
            }
            const urgencyNote = urgency === 'CRITICAL' ? 'order now, already short'
                : urgency === 'WARNING' ? 'order soon'
                    : urgency === 'WATCH' ? 'monitor'
                        : 'covered';
            const explanation = parts.join(' · ') + ` — ${urgencyNote}.`;

            console.log(`   Name        : ${prodData.internalName}`);
            console.log(`   Vendor      : ${vendorName}`);
            console.log(`   Stock REST  : ${stockOnHand}`);
            console.log(`   On Order    : ${stockOnOrder} (${openPOs.length} POs)`);
            console.log(`   Purchase 90d: ${purchaseData.totalQty}  → ${purchaseVelocity.toFixed(2)}/day`);
            console.log(`   Sales 90d   : ${salesData.totalSoldQty}  → ${salesVelocity.toFixed(2)}/day`);
            console.log(`   Daily rate  : ${dailyRate.toFixed(2)}/day (${rateSource})`);
            console.log(`   Runway      : ${runwayDays.toFixed(1)}d  /  ${adjustedRunwayDays.toFixed(1)}d adjusted`);
            console.log(`   Lead time   : ${leadTimeDays}d`);
            console.log(`   Urgency     : ${urgency}`);
            console.log(`   Suggest qty : ${suggestedQty}`);
            console.log(`   Explanation : ${explanation}`);
        } catch (err: any) {
            console.log(`  error: ${err.message}`);
        }
    }
    console.log('\nDone.');
}

run().catch(console.error);
