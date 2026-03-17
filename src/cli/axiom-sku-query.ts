/**
 * @file    axiom-sku-query.ts
 * @purpose One-off script to pull Axiom POs and SKU list from Finale for mapping
 */
import fs from 'fs';
import { FinaleClient } from '../lib/finale/client';

async function main() {
    const finale = new FinaleClient();
    const get = (finale as any).get.bind(finale);

    // 1. Search for Axiom POs via REST
    console.log('=== AXIOM PURCHASE ORDERS (REST) ===\n');
    try {
        const poResp = await get('purchaseorder', {
            vendorFilter: 'Axiom',
            lastUpdatedDate: '2025-10-01T00:00:00',
        });
        const poUrls = poResp || [];
        console.log(`Found ${poUrls.length} Axiom PO URLs\n`);

        // Fetch details for each PO
        for (const poUrl of poUrls.slice(0, 30)) {
            try {
                const url = typeof poUrl === 'string' ? poUrl : poUrl?.purchaseOrderUrl;
                if (!url) continue;
                const po = await get(url.replace(/^.*\/api\//, ''));
                const num = po.purchaseOrderNumber || po.orderNumber;
                const date = po.orderDate?.substring(0, 10);
                const items = po.purchaseOrderLineItemList || [];
                console.log(`PO#${num} | ${date} | status=${po.statusId}`);
                for (const li of items) {
                    console.log(`  → ${li.productId} | qty=${li.quantity} | $${li.unitPrice}`);
                }
            } catch (e: any) {
                console.log(`  Error fetching PO detail: ${e.message}`);
            }
        }
    } catch (e: any) {
        console.log(`REST PO search error: ${e.message}`);
    }

    // 2. Get Axiom version data from saved API data 
    console.log('\n=== AXIOM API VERSION/JOB DATA ===\n');
    const apiPath = 'C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/axiom-order-details.json';
    if (fs.existsSync(apiPath)) {
        const data = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
        for (const inv of data) {
            for (const est of inv.estimates) {
                const versions = est.versions || [];
                const vStr = versions.length > 0
                    ? versions.map((v: any) => `${v.value}(qty:${v.version})`).join(', ')
                    : 'single label';
                console.log(`${inv.invoiceNumber} | $${est.price} | ${est.jobName} | totalQty=${est.quantity} | ${vStr}`);
            }
        }
    }
}

main().catch(console.error);
