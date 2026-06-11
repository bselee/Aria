import { createClient } from '@/lib/supabase';

const supabase = createClient();

async function queryRMC103() {
    console.log('\n=== RMC103 Data Profile ===\n');

    // 1. Check if RMC103 exists in our purchase_orders table
    const { data: poHistory, error: poErr } = await supabase
        .from('purchase_orders')
        .select('po_number, products(name, sku), quantity, order_date, status')
        .or('products.sku.eq.RMC103')
        .order('order_date', { ascending: false })
        .limit(10);

    console.log('📦 Supabase PO History:');
    if (poErr) {
        console.log('  Error:', poErr.message);
    } else if (!poHistory || poHistory.length === 0) {
        console.log('  No POs found for RMC103');
    } else {
        console.log(`  Found ${poHistory.length} PO(s):`);
        poHistory.forEach(po => {
            console.log(`    ${po.po_number} | ${po.products?.name || 'unknown'} | qty=${po.quantity} | ${po.order_date} | ${po.status}`);
        });
    }

    // 2. Check Finale GraphQL for RMC103 signals
    console.log('\n🔍 Finale GraphQL Signals:');
    const { data: finaleData, error: finaleErr } = await supabase
        .from('finale_cache')
        .select('product_id, sku, name, stock_on_hand, reorder_qty, demand_qty, demand_per_day, vendor_name')
        .eq('sku', 'RMC103')
        .limit(1);

    if (finaleErr) {
        console.log('  Error:', finaleErr.message);
    } else if (!finaleData || finaleData.length === 0) {
        console.log('  RMC103 not in finale_cache');
    } else {
        const f = finaleData[0];
        console.log(`  Product ID: ${f.product_id}`);
        console.log(`  Name: ${f.name}`);
        console.log(`  Stock: ${f.stock_on_hand}`);
        console.log(`  Reorder Qty: ${f.reorder_qty}`);
        console.log(`  Demand Qty: ${f.demand_qty}`);
        console.log(`  Demand/Day: ${f.demand_per_day}`);
        console.log(`  Vendor: ${f.vendor_name}`);
    }

    // 3. Check product_categories (resellable classification)
    const { data: categories, error: catErr } = await supabase
        .from('product_categories')
        .select('category_id, categories(name)')
        .or('product_id.eq.RMC103')
        .limit(5);

    console.log('\n🏷️  Categories:');
    if (catErr) {
        console.log('  Error:', catErr.message);
    } else if (!categories || categories.length === 0) {
        console.log('  No categories found');
    } else {
        categories.forEach(c => {
            console.log(`  ${c.categories?.name || c.category_id}`);
        });
    }

    // 4. Check vendor_pricing
    const { data: pricing, error: priceErr } = await supabase
        .from('vendor_pricing')
        .select('vendors(name), unit_price, moq, case_pack')
        .or('product_id.eq.RMC103,product_sku.eq.RMC103')
        .limit(5);

    console.log('\n💰 Vendor Pricing:');
    if (priceErr) {
        console.log('  Error:', priceErr.message);
    } else if (!pricing || pricing.length === 0) {
        console.log('  No vendor pricing found');
    } else {
        pricing.forEach(p => {
            console.log(`  ${p.vendors?.name || 'unknown'} | $${p.unit_price} | MOQ=${p.moq} | Case=${p.case_pack}`);
        });
    }

    process.exit(0);
}

queryRMC103().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
