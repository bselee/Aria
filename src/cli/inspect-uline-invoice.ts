import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import fs from "fs";
import { extractPDF } from "../lib/pdf/extractor";
import { parseInvoice } from "../lib/pdf/invoice-parser";
import { FinaleClient } from "../lib/finale/client";

const buf = fs.readFileSync("C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/ULINE/Uline_Invoice_205814897_119441639_1.pdf");
const ULINE_TO_FINALE: Record<string, string> = {
    "S-15837B": "FJG101", "S-13505B": "FJG102", "S-13506B": "FJG103",
    "S-10748B": "FJG104", "S-12229": "10113", "S-4551": "ULS455", "H-1621": "Ho-1621",
};

async function main() {
    const ext = await extractPDF(buf);
    const inv = await parseInvoice(ext.rawText, ext.tables?.map(t => [t.headers.join(" | "), ...t.rows.map(r => r.join(" | "))]));
    console.log(`Vendor: ${inv.vendorName} | Total: $${inv.total} | PO: ${inv.poNumber}`);
    console.log(`\nLine items (${inv.lineItems.length}):`);
    const client = new FinaleClient();
    for (const li of inv.lineItems) {
        const finaleSku = ULINE_TO_FINALE[li.sku] || li.sku;
        let found = false;
        try { await client.lookupProduct(finaleSku); found = true; } catch {}
        const status = found ? "✅" : "❌";
        console.log(`  ${status} ${li.sku} → ${finaleSku} | ${li.quantity} x $${li.unitPrice} | ${li.description?.slice(0,50)}`);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
