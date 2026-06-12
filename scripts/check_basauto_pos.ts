import { createClient } from "../src/lib/supabase";

const sb = createClient();
if (!sb) { console.log("NO SUPABASE CLIENT"); process.exit(1); }

async function main() {
  // Check what's actually in the table
  const { data: sample } = await sb.from('purchase_orders').select('order_id, status, vendor_name, line_items').limit(3);
  console.log("=== SAMPLE PO STRUCTURE ===");
  console.log(JSON.stringify(sample, null, 2));

  // Check recent POs (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30*86400000).toISOString();
  const { data: recentPOs } = await sb.from('purchase_orders')
    .select('order_id, status, vendor_name, line_items, order_date')
    .gte('order_date', thirtyDaysAgo)
    .limit(100);
  console.log(`\n=== RECENT POs (last 30 days): ${recentPOs?.length || 0} ===`);
  
  const skus = ['RAWCRATERBASALT','ACP101','CRAFT1BAG','XWC','KMS101','RAWMUSTARDSEED','RAWRICEBRAN','ALK101','BAS101','OAG219','OAG226','OAG227','CSW102','SBD21410311','BASEM5-100','ADZ01','FJG104','S-12230','S-4092','S-4128','JPS102','BLM206','BLM209','S-4796','SMT307','S-21310','PPD201'];
  const skuToPOs: Record<string, any[]> = {};
  for (const po of (recentPOs || [])) {
    const items = po.line_items || [];
    for (const it of items) {
      const sku = it.productId || it.sku || it.product_id;
      if (!sku) continue;
      if (skus.includes(sku)) {
        skuToPOs[sku] = skuToPOs[sku] || [];
        skuToPOs[sku].push({ po: po.order_id, vendor: po.vendor_name, status: po.status, qty: it.quantity, date: po.order_date });
      }
    }
  }
  for (const sku of skus) {
    if (skuToPOs[sku]) {
      console.log(sku + ': ' + JSON.stringify(skuToPOs[sku]));
    }
  }
  
  // Check draft_pos
  const { data: drafts } = await sb.from('draft_pos').select('draft_po_id, supplier_name, status, line_items, created_at').limit(50);
  console.log(`\n=== DRAFT POS: ${drafts?.length || 0} ===`);
  const draftMatches: Record<string, any[]> = {};
  for (const d of (drafts || [])) {
    const items = d.line_items || [];
    for (const it of items) {
      const sku = it.productId || it.sku || it.product_id;
      if (!sku) continue;
      if (skus.includes(sku)) {
        draftMatches[sku] = draftMatches[sku] || [];
        draftMatches[sku].push({ draft: d.draft_po_id, vendor: d.supplier_name, qty: it.quantity });
      }
    }
  }
  for (const sku of skus) {
    if (draftMatches[sku]) {
      console.log(sku + ' DRAFT: ' + JSON.stringify(draftMatches[sku]));
    }
  }
}
main();
