import { createClient } from "../src/lib/supabase";

const sb = createClient();
if (!sb) { console.log("NO SUPABASE CLIENT"); process.exit(1); }

// 49 BASAUTO items of concern
const basautoItems = [
  // OVERDUE
  { sku: "RAWCRATERBASALT", urgency: "OVERDUE", daysLeft: 15.21, stock: 8836, reorder: 30602, supplier: "Al and Jerry's llc" },
  { sku: "ACP101", urgency: "OVERDUE", daysLeft: 0, stock: 5.96, reorder: 10, supplier: "Aloe Corp" },
  { sku: "CRAFT1BAG", urgency: "OVERDUE", daysLeft: 34.41, stock: 1604, reorder: 2563, supplier: "Colorful Packaging Ltd" },
  { sku: "XWC", urgency: "OVERDUE", daysLeft: 0, stock: 0, reorder: 15, supplier: "Concentrates Inc." },
  { sku: "KMS101", urgency: "OVERDUE", daysLeft: 0, stock: 28.83, reorder: 79, supplier: "Diamond K Gypsum" },
  { sku: "RAWMUSTARDSEED", urgency: "OVERDUE", daysLeft: 9.85, stock: 3391, reorder: 4890, supplier: "Farm Fuel Inc." },
  { sku: "RAWRICEBRAN", urgency: "OVERDUE", daysLeft: 2.96, stock: 8235, reorder: 19474, supplier: "Farm Fuel Inc." },
  { sku: "ALK101", urgency: "OVERDUE", daysLeft: 34.57, stock: 106, reorder: 472, supplier: "Lexar Industrial" },
  { sku: "BAS101", urgency: "OVERDUE", daysLeft: 3.7, stock: 200, reorder: 5319, supplier: "Lightning Labels" },
  { sku: "OAG219", urgency: "OVERDUE", daysLeft: 0, stock: 3, reorder: 105, supplier: "Organics Alive" },
  { sku: "OAG226", urgency: "OVERDUE", daysLeft: 0, stock: 0.1, reorder: 2, supplier: "Organics Alive" },
  { sku: "OAG227", urgency: "OVERDUE", daysLeft: 0, stock: 0.1, reorder: 2, supplier: "Organics Alive" },
  { sku: "CSW102", urgency: "OVERDUE", daysLeft: 36.89, stock: 25, reorder: 66, supplier: "Propac" },
  { sku: "SBD21410311", urgency: "OVERDUE", daysLeft: 8.08, stock: 910, reorder: 1687, supplier: "Stock Bag Depot" },
  { sku: "BASEM5-100", urgency: "OVERDUE", daysLeft: 0, stock: 0.96, reorder: 2, supplier: "TeraGanix" },
  { sku: "ADZ01", urgency: "OVERDUE", daysLeft: 3.1, stock: 1, reorder: 30, supplier: "The Amazing Dr. Zymes" },
  { sku: "FJG104", urgency: "OVERDUE", daysLeft: 0, stock: 52, reorder: 211, supplier: "ULINE" },
  { sku: "S-12230", urgency: "OVERDUE", daysLeft: 1.33, stock: 2.9, reorder: 207, supplier: "ULINE" },
  { sku: "S-4092", urgency: "OVERDUE", daysLeft: 3.29, stock: 99, reorder: 2084, supplier: "ULINE" },
  { sku: "S-4128", urgency: "OVERDUE", daysLeft: 4.46, stock: 94, reorder: 2034, supplier: "ULINE" },
  { sku: "PPD201", urgency: "OVERDUE", daysLeft: 0, stock: 4.18, reorder: 6, supplier: "Organic AG Products" },
  { sku: "SMT307", urgency: "OVERDUE", daysLeft: 0, stock: 0, reorder: 3, supplier: "Quinton O'Connor" },
  { sku: "S-21310", urgency: "OVERDUE", daysLeft: 0, stock: 0, reorder: 2, supplier: "ULINE" },
  { sku: "KTG101", urgency: "OVERDUE", daysLeft: 0, stock: 0, reorder: 2, supplier: "Amazon" },
  { sku: "MTBC60", urgency: "OVERDUE", daysLeft: 0, stock: 0, reorder: 2, supplier: "Amazon" },
  { sku: "TN850", urgency: "OVERDUE", daysLeft: 0, stock: 0, reorder: 3, supplier: "Amazon" },
  { sku: "TV400", urgency: "OVERDUE", daysLeft: 0, stock: 0, reorder: 2, supplier: "Amazon" },
  { sku: "H-2403", urgency: "OVERDUE", daysLeft: 0, stock: 0, reorder: 6, supplier: "ULINE" },
  { sku: "H-2755", urgency: "OVERDUE", daysLeft: 0, stock: 0, reorder: 22, supplier: "ULINE" },
  { sku: "S-11311BL", urgency: "OVERDUE", daysLeft: 0, stock: 0, reorder: 22, supplier: "ULINE" },
  // URGENT
  { sku: "JPS102", urgency: "URGENT", daysLeft: 14.06, stock: 250, reorder: 318, supplier: "Axiom Print" },
  { sku: "BIG61KGBAG", urgency: "URGENT", daysLeft: 59.68, stock: 93, reorder: 88, supplier: "Colorful Packaging" },
  { sku: "BLM206", urgency: "URGENT", daysLeft: 10.16, stock: 102, reorder: 372, supplier: "Sustainable Village" },
  { sku: "BLM209", urgency: "URGENT", daysLeft: 16.54, stock: 50, reorder: 253, supplier: "Sustainable Village" },
  { sku: "S-4796", urgency: "URGENT", daysLeft: 8.86, stock: 740, reorder: 7282, supplier: "ULINE" },
  // SOON
  { sku: "JPS101", urgency: "SOON", daysLeft: 19.69, stock: 270, reorder: 444, supplier: "Axiom Print" },
  { sku: "CEN102", urgency: "SOON", daysLeft: 22.5, stock: 10, reorder: 36, supplier: "Cen-Tec" },
  { sku: "COWOCO3", urgency: "SOON", daysLeft: 37.45, stock: 57, reorder: 117, supplier: "Colorado Worm" },
  { sku: "OGF101", urgency: "SOON", daysLeft: 22.8, stock: 19, reorder: 69, supplier: "Great Western" },
  { sku: "LY102", urgency: "SOON", daysLeft: 33.49, stock: 211, reorder: 520, supplier: "North Mason" },
  { sku: "CLVR04", urgency: "SOON", daysLeft: 24.46, stock: 40.87, reorder: 60, supplier: "PULSE USA" },
  { sku: "SMT203", urgency: "SOON", daysLeft: 38.57, stock: 6, reorder: 13, supplier: "Quinton O'Connor" },
  { sku: "SMT206", urgency: "SOON", daysLeft: 40.5, stock: 9, reorder: 18, supplier: "Quinton O'Connor" },
  { sku: "RMC101", urgency: "SOON", daysLeft: 37.44, stock: 223, reorder: 492, supplier: "Rootwise" },
  { sku: "RMC102", urgency: "SOON", daysLeft: 40, stock: 80, reorder: 160, supplier: "Rootwise" },
  { sku: "SCO101", urgency: "SOON", daysLeft: 23.5, stock: 59, reorder: 203, supplier: "Seacoast" },
  { sku: "WOL101", urgency: "SOON", daysLeft: 33.84, stock: 50.42, reorder: 86, supplier: "Seaforth" },
  { sku: "BBB101", urgency: "SOON", daysLeft: 26, stock: 13, reorder: 39, supplier: "TeaLAB" },
  { sku: "H-255BL", urgency: "SOON", daysLeft: 18, stock: 2, reorder: 9, supplier: "ULINE" },
  { sku: "S-4125", urgency: "SOON", daysLeft: 14.45, stock: 401, reorder: 1332, supplier: "ULINE" },
];

const skus = basautoItems.map(i => i.sku);

async function main() {
  // 1. Open POs from Supabase
  const { data: pos, error: poErr } = await sb.from('purchase_orders')
    .select('order_id, status, vendor_name, order_date, line_items, expected_receive_date')
    .in('status', ['Committed', 'Locked', 'Sent', 'in_transit', 'sent'])
    .limit(300);
  
  if (poErr) console.error("PO query error:", poErr.message);

  // 2. Draft POs
  const { data: drafts, error: draftErr } = await sb.from('draft_pos')
    .select('draft_po_id, supplier_name, status, line_items, created_at')
    .eq('status', 'draft')
    .limit(100);

  if (draftErr) console.error("Draft query error:", draftErr.message);

  // 3. Last 60 days of received POs to check replenishment cadence
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];
  const { data: recent, error: recentErr } = await sb.from('purchase_orders')
    .select('order_id, status, vendor_name, order_date, line_items')
    .eq('status', 'Completed')
    .gte('order_date', sixtyDaysAgo)
    .limit(200);
  
  if (recentErr) console.error("Recent PO error:", recentErr.message);

  // Build lookup maps
  const openBySku: Record<string, any[]> = {};
  const draftBySku: Record<string, any[]> = {};
  const recentBySku: Record<string, any[]> = {};

  for (const po of (pos || [])) {
    for (const it of po.line_items || []) {
      const sku = it.productId || it.sku;
      if (!sku) continue;
      if (skus.includes(sku)) {
        openBySku[sku] = openBySku[sku] || [];
        openBySku[sku].push({ id: po.order_id, vendor: po.vendor_name, status: po.status, date: po.order_date, eta: po.expected_receive_date, qty: it.quantity });
      }
    }
  }

  for (const d of (drafts || [])) {
    for (const it of d.line_items || []) {
      const sku = it.productId || it.sku;
      if (!sku) continue;
      if (skus.includes(sku)) {
        draftBySku[sku] = draftBySku[sku] || [];
        draftBySku[sku].push({ id: d.draft_po_id, vendor: d.supplier_name, qty: it.quantity });
      }
    }
  }

  for (const po of (recent || [])) {
    for (const it of po.line_items || []) {
      const sku = it.productId || it.sku;
      if (!sku) continue;
      if (skus.includes(sku)) {
        recentBySku[sku] = recentBySku[sku] || [];
        recentBySku[sku].push({ id: po.order_id, vendor: po.vendor_name, date: po.order_date, qty: it.quantity });
      }
    }
  }

  // Output summary
  console.log("=== BASAUTO vs ARIA ORACLE CROSS-REFERENCE ===\n");

  for (const item of basautoItems) {
    const open = openBySku[item.sku] || [];
    const drafts = draftBySku[item.sku] || [];
    const recent = recentBySku[item.sku] || [];
    
    const status = open.length > 0 ? `[ORDERED x${open.map(p => p.qty).reduce((a, b) => a + b, 0)}]` : 
                    drafts.length > 0 ? `[DRAFT x${drafts.map(d => d.qty).reduce((a, b) => a + b, 0)}]` : 
                    recent.length > 0 ? `[No open PO — last ordered: ${recent[0].date}]` : 
                    "[NO POs found — CANDIDATE]";
    
    console.log(`${item.sku} / ${item.supplier}`);
    console.log(`  BASAUTO: ${item.urgency} | stock=${item.stock} daysLeft=${item.daysLeft} reorder=${item.reorder}`);
    console.log(`  ARIA:    ${status}`);
    if (open.length > 0) {
      open.forEach(p => console.log(`           Open PO: ${p.id} ${p.status} qty=${p.qty}${p.eta ? ` ETA ${p.eta}` : ''}`));
    }
    if (drafts.length > 0) {
      drafts.forEach(d => console.log(`           Draft: ${d.id} qty=${d.qty}`));
    }
    if (recent.length > 0 && open.length === 0 && drafts.length === 0) {
      recent.forEach(p => console.log(`           Recent: ${p.id} ${p.date} qty=${p.qty}`));
    }
    console.log();
  }
}

main().catch(console.error);
