#!/usr/bin/env node
/**
 * @file sop-hub-publisher.ts
 * @purpose Push draft SOPs to the BuildASoil SOP Hub localStorage.
 *          Run on the SOP Hub page via bookmarklet or console paste.
 *          Edit this file to add/modify SOPs, then re-run.
 * @deps None — pure JS, runs in browser console
 * @usage Copy the output of `node sop-hub-publisher.js` and paste into console
 */

// ===== EDIT YOUR SOPS BELOW =====

interface SOPSection {
  title: string;
  steps: string[];
  video: string;
  image: string;
  links: { label: string; url: string }[];
}

interface SOP {
  title: string;
  status: 'draft' | 'active' | 'needs-update';
  department: string;
  usedBy: string[];
  access: 'public' | 'restricted';
  owner: string;
  platforms: string[];
  purpose: string;
  when: string;
  risk: string;
  sections: SOPSection[];
  quality: string[];
  crossDept: string[];
  related_sops: string[];
  troubleshooting: [string, string][];
  category: string;
}

const SOPsToPublish: SOP[] = [
  // ========== PURCHASING SOPS ==========
  {
    title: "Purchase Order Creation and Approval",
    status: "draft",
    department: "Purchasing",
    usedBy: ["Inventory"],
    access: "public",
    owner: "Responsible Role: Purchasing Staff",
    platforms: ["Finale Inventory", "Gmail"],
    purpose: "Create and approve purchase orders in Finale Inventory to replenish stock and maintain accurate inventory levels across all locations.",
    when: "Use this SOP whenever stock falls below the reorder point, a new item needs to be introduced, or a supplier requests a PO to process an order.",
    risk: "Orders are placed with incorrect quantities or pricing, inventory goes out of stock, duplicate orders are created, or payment terms are missed.",
    sections: [
      {
        title: "Identify What to Order",
        steps: [
          "Open Finale Inventory Stock > Reorder to review items flagged for restock.",
          "Review the Quantity to Order column.",
          "Check Current Stock sorted by Remaining Quantity ascending.",
          "Cross-reference with open customer orders and production builds.",
          "Check supplier minimum order quantity and shipping schedule."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Select Supplier and Get Pricing",
        steps: [
          "Confirm preferred supplier on product detail page.",
          "Check last PO or email for current pricing. If unclear, request quote.",
          "For recurring orders, use last confirmed price.",
          "Note lead time and delivery window."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Create the PO in Finale",
        steps: [
          "Navigate to Purchasing > New Purchase Order.",
          "Select supplier, warehouse location, order date, expected date.",
          "Add items by SKU with quantity and unit price.",
          "Review subtotal. Set status to Draft."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Review and Approve",
        steps: [
          "Verify quantities, prices, supplier, location, date.",
          "Under $500: self-approve and commit.",
          "$500+: send to Ops Manager in Slack for review.",
          "Once approved: click Commit. Email PO as PDF to supplier."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Communicate the Order",
        steps: [
          "Add note in Finale with supplier details.",
          "If out-of-stock: post PO number and ETA in Slack thread."
        ],
        video: "", image: "", links: []
      }
    ],
    quality: [
      "Confirmed price and supplier before committing",
      "Approval documented for POs over $500",
      "Lead time recorded for tracking"
    ],
    crossDept: [
      "Notify Inventory of urgent POs via Slack",
      "AP uses PO data for invoice matching"
    ],
    related_sops: ["SOP How to Research Purchase Orders in Finale Inventory"],
    troubleshooting: [
      ["Supplier wont accept email POs", "Use their portal"],
      ["Price differs from last PO", "Request current quote"],
      ["PO needs cancellation", "Cancel in Finale, notify supplier"]
    ],
    category: "Procurement"
  },
  {
    title: "Vendor Receiving and Inspection",
    status: "draft",
    department: "Purchasing",
    usedBy: ["Inventory", "Soil Products", "Manufacturing"],
    access: "public",
    owner: "Responsible Role: Receiving Staff",
    platforms: ["Finale Inventory"],
    purpose: "Inspect incoming vendor shipments for accuracy, damage, and quality before accepting into inventory.",
    when: "Whenever a shipment arrives from a vendor.",
    risk: "Damaged products enter inventory, quantities miscounted, AP pays for goods not received.",
    sections: [
      {
        title: "Before the Truck",
        steps: [
          "Check scheduled deliveries in Finale.",
          "Review PO details and special handling notes.",
          "Clear area. Gather tools."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Receive the Shipment",
        steps: [
          "Get packing slip, confirm PO number.",
          "Count pallets before driver leaves.",
          "Move to receiving area. Count every item.",
          "Verify SKU, quantity, unit of measure.",
          "Check for damage. Photograph immediately.",
          "Note lot numbers and expiration dates."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Handle Discrepancies",
        steps: [
          "Shortage: note on packing slip.",
          "Damage: photograph, notify Purchasing via Slack.",
          "Wrong product: do not receive, contact Purchasing.",
          "Over-shipment: get approval before accepting."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Stage for System Receiving",
        steps: [
          "Sort and stage by SKU near storage.",
          "Mark pallets with PO number and date.",
          "Proceed to Finale Inventory Receiving SOP.",
          "Do not put away until system receiving is done."
        ],
        video: "", image: "", links: []
      }
    ],
    quality: [
      "Every item physically counted",
      "Damage photographed before driver leaves",
      "Discrepancies reported within 1 hour",
      "Packing slips filed by PO number"
    ],
    crossDept: [
      "Soil: raw materials may need quality check",
      "AP needs docs for credits"
    ],
    related_sops: [
      "SOP - Finale Inventory Receiving",
      "SOP - Purchase Order Creation and Approval"
    ],
    troubleshooting: [
      ["Driver refuses full inspection", "Sign for pallet count only"],
      ["Item with no PO exists", "Set aside, contact Purchasing"],
      ["Bulk material off-quality", "Do not accept, photo, flag Purchasing"]
    ],
    category: "Receiving"
  },
  {
    title: "Finale Inventory Receiving",
    status: "draft",
    department: "Purchasing",
    usedBy: ["Inventory"],
    access: "public",
    owner: "Responsible Role: Receiving or Inventory Staff",
    platforms: ["Finale Inventory"],
    purpose: "Receive PO items into Finale so stock updates and PO completes.",
    when: "After physical inspection is complete.",
    risk: "Inventory wrong, AP cant close PO, reorder wrong.",
    sections: [
      {
        title: "Open the PO",
        steps: [
          "Log in to Finale.",
          "Purchasing > View Purchase Orders.",
          "Search PO, confirm Committed."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Receive Items",
        steps: [
          "Click Receive Purchase Order.",
          "Select location.",
          "Enter qty received for each line.",
          "Enter lot/expiration dates.",
          "Assign sublocation."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Landed Costs",
        steps: [
          "If freight/handling: Add Landed Cost.",
          "Select type, enter amount.",
          "No estimates."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Complete Receipt",
        steps: [
          "Review, click Complete Shipment.",
          "Confirm status update.",
          "Verify inventory."
        ],
        video: "", image: "", links: []
      },
      {
        title: "Final Steps",
        steps: [
          "File packing slip.",
          "Notify Fulfillment of urgent stock.",
          "If discrepancy: inform AP.",
          "Move to storage."
        ],
        video: "", image: "", links: []
      }
    ],
    quality: [
      "Received within 4 hours of physical arrival",
      "Qty matches physical count",
      "Sublocations correct",
      "Landed costs applied",
      "Packing slips filed"
    ],
    crossDept: [
      "AP matches receipt to invoices",
      "Manufacturing needs accurate counts"
    ],
    related_sops: [
      "SOP - Vendor Receiving and Inspection",
      "SOP - Purchase Order Creation and Approval"
    ],
    troubleshooting: [
      ["Wrong location on PO", "Dont receive, contact Purchasing"],
      ["No sublocation", "Use General temporarily"]
    ],
    category: "Receiving"
  }
];

// ===== GENERATE PUBLISH SCRIPT =====
// Run this: node sop-hub-publisher.js | clip
// Then paste into browser console on the SOP Hub page

function generatePublishScript(sops: SOP[]): string {
  return `(function(){
var s=JSON.parse(localStorage.getItem('bas_sops')||'[]');
var n=1;s.forEach(function(x){var m=x.id&&x.id.match(/^sop-(\\d+)$/);if(m)n=Math.max(n,parseInt(m[1])+1)});
${sops.map((sop, i) => {
  const id = `sop-"+(n+${i})`;
  const usedBy = JSON.stringify(sop.usedBy);
  const platforms = JSON.stringify(sop.platforms);
  const sections = JSON.stringify(sop.sections).replace(/"/g, '\\"');
  const quality = JSON.stringify(sop.quality).replace(/"/g, '\\"');
  const crossDept = JSON.stringify(sop.crossDept).replace(/"/g, '\\"');
  const related = JSON.stringify(sop.related_sops).replace(/"/g, '\\"');
  const troubleshooting = JSON.stringify(sop.troubleshooting).replace(/"/g, '\\"');
  
  return `s.push({id:${id},title:${JSON.stringify(sop.title)},status:${JSON.stringify(sop.status)},department:${JSON.stringify(sop.department)},usedBy:${JSON.stringify(sop.usedBy)},access:${JSON.stringify(sop.access)},owner:${JSON.stringify(sop.owner)},updated:"Jun 22, 2026",review:"Sep 22, 2026",platforms:${JSON.stringify(sop.platforms)},purpose:${JSON.stringify(sop.purpose)},when:${JSON.stringify(sop.when)},risk:${JSON.stringify(sop.risk)},sections:${JSON.stringify(sop.sections)},quality:${JSON.stringify(sop.quality)},crossDept:${JSON.stringify(sop.crossDept)},related_sops:${JSON.stringify(sop.related_sops)},troubleshooting:${JSON.stringify(sop.troubleshooting)},category:${JSON.stringify(sop.category)}});`;
}).join('\n')}
localStorage.setItem('bas_sops',JSON.stringify(s));
if(typeof SL!=='undefined'&&SL.sops&&typeof renderSidebar==='function'){SL.sops=s;renderSidebar('Purchasing');}
console.log('Published '+${sops.length}+' SOPs. Total: '+s.length);
})();`;
}

// Print to stdout
console.log(generatePublishScript(SOPsToPublish));

// Also print compact bookmarklet version
console.log('\n--- Bookmarklet (compact) ---');
const compact = generatePublishScript(SOPsToPublish)
  .replace(/\s+/g, ' ')
  .replace(/, /g, ',')
  .replace(/; /g, ';');
console.log('javascript:' + encodeURI(compact));
