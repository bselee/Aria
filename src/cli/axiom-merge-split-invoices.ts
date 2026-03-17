/**
 * @file    axiom-merge-split-invoices.ts
 * @purpose Merge 9 split Axiom invoices into their parent POs by adding missing line items.
 *          These invoices have $0 shipping and are date-adjacent to existing POs,
 *          confirming they are split invoices from the same Axiom orders.
 * @author  Will / Antigravity
 * @created 2026-03-17
 * @updated 2026-03-17
 * @deps    finale/client
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';
import { upsertVendorInvoice } from '../lib/storage/vendor-invoices';
import fs from 'fs';

// ── Mapping: invoice → parent PO ──────────────────────────────────────────────
// Derived from date-proximity analysis + $0 shipping confirmation
const MERGE_MAP: Array<{
    invoiceNumber: string;
    targetPO: string;
    reason: string;
}> = [
    { invoiceNumber: 'INV122172', targetPO: '124478', reason: 'Same day (3/16), $0 ship' },
    { invoiceNumber: 'INV120067', targetPO: '124356', reason: '2 days apart (2/6→2/4), $0 ship' },
    { invoiceNumber: 'INV115878', targetPO: '123972', reason: '3 days apart (11/7→11/10), $0 ship' },
    { invoiceNumber: 'INV115514', targetPO: '123941', reason: '2 days apart (10/31→10/29), $0 ship' },
    { invoiceNumber: 'INV115508', targetPO: '123941', reason: '2 days apart (10/31→10/29), $0 ship' },
    { invoiceNumber: 'INV115195', targetPO: '123941', reason: '2 days apart (10/27→10/29), same SKUs, $0 ship' },
    { invoiceNumber: 'INV114969', targetPO: '123941', reason: '7 days apart (10/22→10/29), $0 ship' },
    { invoiceNumber: 'INV114832', targetPO: '123941', reason: '8 days apart (10/21→10/29), $0 ship' },
    { invoiceNumber: 'INV114400', targetPO: '123941', reason: '20 days apart (10/9→10/29), $0 ship' },
];

// ── SKU mapping (from reconcile-axiom.ts) ─────────────────────────────────────
interface SkuMapping { skus: string[]; qtyFraction: number; }
const AXIOM_TO_FINALE: Record<string, SkuMapping> = {
    'GNS Front 1 Gallon':     { skus: ['GNS11'], qtyFraction: 1 },
    'GNS Back 1 Gallon':      { skus: ['GNS21'], qtyFraction: 1 },
    'GNS Front Half Gallon':  { skus: ['GNS12'], qtyFraction: 1 },
    'GNS Back Half Gallon':   { skus: ['GNS22'], qtyFraction: 1 },
    'GnarBar07Milled':        { skus: ['GNS17'], qtyFraction: 0.5 },
    'GnarBar062lbs':          { skus: ['GNS16'], qtyFraction: 0.5 },
    'GNS Front 2LBS':         { skus: ['GNS07'], qtyFraction: 0.5 },
    'GNS Back 2LBS':          { skus: ['GNS06'], qtyFraction: 0.5 },
    'GNAR BAR 2lbs':          { skus: ['GNS11', 'GNS21'], qtyFraction: 0.5 },
    'GNAR BAR 6 lbs':         { skus: ['GNS12', 'GNS22'], qtyFraction: 0.5 },
    'BAS Ball_Full 1 Gallon':  { skus: ['BAF1G'], qtyFraction: 1 },
    'BAF00LABEL':              { skus: ['BAF00LABEL'], qtyFraction: 1 },
    'BAF1G':                   { skus: ['BAF1G'], qtyFraction: 1 },
    'BAS Ball_Full Pint':     { skus: ['BBL101'], qtyFraction: 1 },
    'BABL101':                 { skus: ['BABL101'], qtyFraction: 1 },
    'DOM101':                  { skus: ['DOM101'], qtyFraction: 1 },
    'GBB08':                   { skus: ['GBB08'], qtyFraction: 1 },
    'GBB07':                   { skus: ['GBB07'], qtyFraction: 1 },
    'OAG104FRBK':        { skus: ['OAG104LABELFR', 'OAG104LABELBK'], qtyFraction: 0.5 },
    'OAG207FRBK':        { skus: ['OAG207LABELFR', 'OAG207LABELBK'], qtyFraction: 0.5 },
    'OAG211FRBK':        { skus: ['OAG211LABELFR', 'OAG211LABELBK'], qtyFraction: 0.5 },
    'VCal OA Gallon Labels': { skus: ['OAG110LABELFR', 'OAG110LABELBK'], qtyFraction: 0.5 },
    'VCal OA Pint Label':    { skus: ['OAG109LABELFR', 'OAG109LABELBK'], qtyFraction: 0.5 },
    'AG111':                  { skus: ['AG111'], qtyFraction: 1 },
    'FCB1G':                  { skus: ['FCB1G'], qtyFraction: 1 },
    'CWP DRINK SOME':         { skus: ['CWP DRINK SOME'], qtyFraction: 1 },
    'KGD104':                  { skus: ['KGD104'], qtyFraction: 1 },
    'GA105':                   { skus: ['GA105'], qtyFraction: 1 },
    'PU105L':                  { skus: ['PU105L'], qtyFraction: 1 },
};

function toFinaleIds(jobName: string): SkuMapping | null {
    const direct = AXIOM_TO_FINALE[jobName];
    if (direct) return direct;
    const key = Object.keys(AXIOM_TO_FINALE).find(k =>
        jobName.toLowerCase().includes(k.toLowerCase()) ||
        k.toLowerCase().includes(jobName.toLowerCase())
    );
    return key ? AXIOM_TO_FINALE[key] : null;
}

// ─────────────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  Merge Split Axiom Invoices → Parent POs        ║');
    console.log('╚══════════════════════════════════════════════════╝');
    if (DRY_RUN) console.log('   🔍 DRY RUN — no changes will be saved\n');

    // Load invoice data
    const dataPath = 'C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/processed/axiom-order-details.json';
    const invoices = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    const finale = new FinaleClient();
    const get = (finale as any).get.bind(finale);
    const post = (finale as any).post.bind(finale);
    const accountPath = (finale as any).accountPath;

    let added = 0;
    let skipped = 0;
    let errors = 0;

    for (const merge of MERGE_MAP) {
        const inv = invoices.find((i: any) => i.invoiceNumber === merge.invoiceNumber);
        if (!inv) { console.log(`   ⚠️  ${merge.invoiceNumber}: not found in data`); errors++; continue; }

        console.log(`\n   ── ${merge.invoiceNumber} → PO ${merge.targetPO} (${merge.reason}) ──`);

        // Resolve invoice SKUs
        const newItems: Array<{ productId: string; quantity: number; unitPrice: number }> = [];
        for (const est of inv.estimates) {
            const mapping = toFinaleIds(est.jobName);
            if (!mapping) {
                console.log(`      ⚠️  Unmapped: "${est.jobName}"`);
                continue;
            }
            const perLabelPrice = est.quantity > 0 ? est.price / est.quantity : est.price;
            for (const sku of mapping.skus) {
                newItems.push({
                    productId: sku,
                    quantity: Math.round(est.quantity * mapping.qtyFraction),
                    unitPrice: perLabelPrice,
                });
            }
        }

        if (newItems.length === 0) { console.log('      ⚠️  No mappable SKUs'); skipped++; continue; }

        // Fetch current PO
        const po = await finale.getOrderDetails(merge.targetPO);
        const existingItems = po.orderItemList || [];
        const existingSkus = new Set(existingItems.map((i: any) =>
            i.productUrl?.split('/').pop() || i.productId || ''
        ));

        let needsSave = false;
        for (const item of newItems) {
            if (existingSkus.has(item.productId)) {
                // SKU already on PO — check if price needs updating
                const existing = existingItems.find((i: any) =>
                    (i.productUrl?.split('/').pop() || i.productId) === item.productId
                );
                if (existing && Math.abs(existing.unitPrice - item.unitPrice) > 0.001) {
                    console.log(`      📝 ${item.productId}: price $${existing.unitPrice.toFixed(4)} → $${item.unitPrice.toFixed(4)}`);
                    if (!DRY_RUN) {
                        existing.unitPrice = item.unitPrice;
                        needsSave = true;
                    }
                } else {
                    console.log(`      ⏭️  ${item.productId}: already on PO at correct price`);
                }
                continue;
            }

            console.log(`      + ${item.productId}: ${item.quantity} × $${item.unitPrice.toFixed(4)}`);

            if (!DRY_RUN) {
                existingItems.push({
                    productUrl: `/${accountPath}/api/product/${encodeURIComponent(item.productId)}`,
                    productId: item.productId,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                });
                needsSave = true;
                added++;
            } else {
                added++;
            }
        }

        // Batch save: unlock once, push all changes, restore
        if (needsSave && !DRY_RUN) {
            try {
                const originalStatus = await (finale as any).unlockForEditing(po, merge.targetPO);
                // Re-fetch fresh PO state after unlock
                const freshPO = await finale.getOrderDetails(merge.targetPO);
                const freshItems = freshPO.orderItemList || [];
                const freshSkuSet = new Set(freshItems.map((i: any) =>
                    i.productUrl?.split('/').pop() || i.productId || ''
                ));

                // Apply new items to fresh PO
                const beforeCount = freshItems.length;
                for (const item of newItems) {
                    if (freshSkuSet.has(item.productId)) {
                        // Update price if changed
                        const existing = freshItems.find((i: any) =>
                            (i.productUrl?.split('/').pop() || i.productId) === item.productId
                        );
                        if (existing) existing.unitPrice = item.unitPrice;
                    } else {
                        freshItems.push({
                            productUrl: `/${accountPath}/api/product/${encodeURIComponent(item.productId)}`,
                            productId: item.productId,
                            quantity: item.quantity,
                            unitPrice: item.unitPrice,
                        });
                    }
                }

                freshPO.orderItemList = freshItems;

                // Extend each adjustment's allocation array with $0 entries for new items
                const newCount = freshItems.length - beforeCount;
                if (newCount > 0 && freshPO.orderAdjustmentList?.length) {
                    for (const adj of freshPO.orderAdjustmentList) {
                        if (Array.isArray(adj.orderAdjustmentAllocationList)) {
                            for (let i = 0; i < newCount; i++) {
                                adj.orderAdjustmentAllocationList.push(0);
                            }
                        }
                    }
                }

                await post(`/${accountPath}/api/order/${encodeURIComponent(merge.targetPO)}`, freshPO);
                await (finale as any).restoreOrderStatus(merge.targetPO, originalStatus);
                console.log('      ✅ Saved');
            } catch (err: any) {
                console.log(`      ❌ Save failed: ${err.message}`);
                errors++;
            }
        }

        // Archive to vendor_invoices
        if (!DRY_RUN) {
            try {
                await upsertVendorInvoice({
                    vendor_name: 'Axiom Print',
                    invoice_number: inv.invoiceNumber,
                    invoice_date: inv.orderDate?.substring(0, 10) ?? null,
                    po_number: merge.targetPO,
                    subtotal: inv.subtotal,
                    freight: inv.shipping,
                    tax: inv.tax,
                    total: inv.total,
                    status: 'reconciled',
                    source: 'portal_scrape',
                    source_ref: `reconcile-axiom-merge-${new Date().toISOString().split('T')[0]}`,
                    line_items: newItems.map(i => ({
                        sku: i.productId,
                        description: i.productId,
                        qty: i.quantity,
                        unit_price: i.unitPrice,
                        ext_price: i.quantity * i.unitPrice,
                    })),
                    raw_data: inv as unknown as Record<string, unknown>,
                });
            } catch { /* dedup ok */ }
        }
    }

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║   Line items added:  ${added}`);
    console.log(`║   Skipped:           ${skipped}`);
    console.log(`║   Errors:            ${errors}`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('\n⚠️  REMINDER: Manually delete draft POs #124482–124490 from Finale UI');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
