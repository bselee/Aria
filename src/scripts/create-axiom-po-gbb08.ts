/**
 * @file    create-axiom-po-gbb08.ts
 * @purpose One-off script: Create draft Finale PO for Axiom Print INV122608
 *          GBB08 (Gnar Bud Butter v8) Roll Labels, Qty 4000, $709.96
 * @author  Antigravity
 * @created 2026-03-23
 * @updated 2026-03-23
 * @deps    finale/client, storage/vendor-invoices
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { FinaleClient } from '../lib/finale/client';
import { upsertVendorInvoice } from '../lib/storage/vendor-invoices';

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  Axiom Print PO — INV122608 (GBB08 Roll Labels)     ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    const finale = new FinaleClient();

    // ── Step 1: Find Axiom Print vendor ──────────────────────────────────
    console.log('1️⃣  Looking up Axiom Print vendor in Finale...');
    let vendorPartyId = await finale.findVendorPartyByName('Axiom Print');
    if (!vendorPartyId) vendorPartyId = await finale.findVendorPartyByName('Axiom');
    if (!vendorPartyId) {
        console.error('❌ Axiom Print vendor not found in Finale');
        process.exit(1);
    }
    console.log(`   ✅ Vendor party ID: ${vendorPartyId}\n`);

    // ── Step 2: Build line items ─────────────────────────────────────────
    // Invoice INV122608:
    //   GBB08 / E1160766 — Roll Labels, 5.00 x 6.00, Qty 4000, Total $709.96
    //   Per-label price: $709.96 / 4000 = $0.17749
    const totalPrice = 709.96;
    const quantity = 4000;
    const unitPrice = totalPrice / quantity;  // $0.17749

    const items = [
        {
            productId: 'GBB08',
            quantity,
            unitPrice,
        },
    ];

    console.log('2️⃣  Line items:');
    console.log(`   GBB08 (Gnar Bud Butter v8 Roll Labels)`);
    console.log(`   Qty: ${quantity} × $${unitPrice.toFixed(4)} = $${totalPrice.toFixed(2)}\n`);

    // ── Step 3: Create draft PO ──────────────────────────────────────────
    console.log('3️⃣  Creating draft PO in Finale...');
    const memo = `[Aria] Axiom Print INV122608 — GBB08 Roll Labels 5x6 Qty 4000`;
    const result = await finale.createDraftPurchaseOrder(vendorPartyId, items, memo);

    console.log(`\n   ✅ Draft PO created!`);
    console.log(`   PO #: ${result.orderId}`);
    console.log(`   URL: ${result.finaleUrl}`);
    console.log(`   Facility: ${result.facilityName}`);

    if (result.duplicateWarnings.length > 0) {
        console.log('\n   ⚠️  Duplicate warnings:');
        for (const w of result.duplicateWarnings) {
            console.log(`      ${w}`);
        }
    }

    if (result.priceAlerts.length > 0) {
        console.log('\n   💰 Price change alerts:');
        for (const a of result.priceAlerts) {
            console.log(`      ${a}`);
        }
    }

    // ── Step 4: Archive to vendor_invoices ────────────────────────────────
    console.log('\n4️⃣  Archiving to vendor_invoices...');
    try {
        await upsertVendorInvoice({
            vendor_name: 'Axiom Print',
            invoice_number: 'INV122608',
            invoice_date: '2026-03-23',
            po_number: result.orderId,
            subtotal: totalPrice,
            freight: 0,
            tax: 0,
            total: totalPrice,
            status: 'received',
            source: 'manual',
            source_ref: 'axiom-manual-2026-03-23-gbb08',
            line_items: [
                {
                    sku: 'GBB08',
                    description: 'Gnar Bud Butter v8 Roll Labels 5x6',
                    qty: quantity,
                    unit_price: unitPrice,
                    ext_price: totalPrice,
                },
            ],
            raw_data: {
                axiom_invoice: 'INV122608',
                axiom_ecode: 'E1160766',
                product: 'Roll Labels',
                size: '5.00 x 6.00',
                quantity,
                total: totalPrice,
            },
        });
        console.log('   ✅ Archived to vendor_invoices');
    } catch (err: any) {
        console.warn(`   ⚠️  Archive failed (non-blocking): ${err.message}`);
    }

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`✅ DONE — PO #${result.orderId} created for Axiom INV122608`);
    console.log('══════════════════════════════════════════════════════════\n');
}

main().catch(err => {
    console.error('❌ Script failed:', err);
    process.exit(1);
});
