/**
 * Directly populate draft PO 124541 from ULINE invoice 205814897.
 * Items parsed from raw text (ULINE compact format: {qty}{UOM}{SKU}{desc}{price}{ext}).
 * Usage: node --import tsx src/cli/populate-uline-po.ts [--dry-run]
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { FinaleClient } from "../lib/finale/client";

const DRY_RUN = process.argv.includes("--dry-run");
const PO_ID = "124541";

// Items parsed from raw PDF text + verified against Finale product list.
// H-121 (free knife set, $0.00) intentionally excluded from PO.
const ITEMS = [
    { productId: "S-15625", quantity: 48,   unitPrice: 9.50  },  // security tape
    { productId: "S-2835",  quantity: 1,    unitPrice: 41.00 },  // 7x8" reclosable bags (raw: 1CTS-2835 + "7 X 8"...")
    { productId: "S-4092",  quantity: 500,  unitPrice: 0.51  },  // 9x5x5" corrugated boxes (raw: 500EAS-4092 + "9 X 5 X 5"...")
    { productId: "S-4796",  quantity: 2000, unitPrice: 1.99  },  // 22x14x6" corrugated boxes
    { productId: "S-4128",  quantity: 500,  unitPrice: 0.65  },  // 12x6x6" long corrugated boxes
    { productId: "ULS455",  quantity: 90,   unitPrice: 3.33  },  // 30x15x15" corrugated boxes (S-4551 → ULS455)
    { productId: "S-6771",  quantity: 2,    unitPrice: 7.45  },  // air in a can
];

// From invoice: subtotal=$5,371.60, freight=$1.50, tax=$249.78, total=$5,622.88
const FREIGHT = 1.50;
const TAX     = 249.78;

async function main() {
    const client = new FinaleClient();

    // Validate all SKUs exist before touching the PO
    console.log(`Validating ${ITEMS.length} SKUs in Finale...`);
    for (const item of ITEMS) {
        const exists = await client.validateProductExists(item.productId);
        if (!exists) {
            console.error(`❌ SKU not found in Finale: ${item.productId} — aborting`);
            process.exit(1);
        }
        const lineTotal = item.quantity * item.unitPrice;
        console.log(`  ✅ ${item.productId} × ${item.quantity} @ $${item.unitPrice.toFixed(2)} = $${lineTotal.toFixed(2)}`);
    }

    const itemsSubtotal = ITEMS.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
    console.log(`\nSubtotal: $${itemsSubtotal.toFixed(2)} (invoice: $5,371.60)`);
    console.log(`Freight:  $${FREIGHT.toFixed(2)}`);
    console.log(`Tax:      $${TAX.toFixed(2)}`);
    console.log(`Total:    $${(itemsSubtotal + FREIGHT + TAX).toFixed(2)}`);

    if (DRY_RUN) {
        console.log("\n[DRY RUN] No changes made.");
        process.exit(0);
    }

    console.log(`\nPopulating PO ${PO_ID} with ${ITEMS.length} items...`);
    await client.addItemsToPO(PO_ID, ITEMS);
    console.log(`✅ Items added to PO ${PO_ID}`);

    console.log(`Adding freight $${FREIGHT}...`);
    await client.addOrderAdjustment(PO_ID, "FREIGHT", FREIGHT, "Freight");
    console.log(`✅ Freight added`);

    console.log(`Adding tax $${TAX}...`);
    await client.addOrderAdjustment(PO_ID, "TAX", TAX, "Sales Tax");
    console.log(`✅ Tax added`);

    console.log(`\n🎉 PO ${PO_ID} fully populated from ULINE invoice 205814897 ($${(itemsSubtotal + FREIGHT + TAX).toFixed(2)})`);
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
