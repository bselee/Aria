import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import fs from "fs";
import { extractPDF } from "../lib/pdf/extractor";
import { parseInvoice } from "../lib/pdf/invoice-parser";

async function main() {
    const buf = fs.readFileSync("C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/ULINE/Uline_Invoice_205814897_119441639_1.pdf");
    const ext = await extractPDF(buf);
    const inv = await parseInvoice(ext.rawText);
    for (const li of inv.lineItems) {
        const derivedQty = (li.extendedPrice && li.unitPrice && li.unitPrice > 0)
            ? Math.round(li.extendedPrice / li.unitPrice) : null;
        console.log(`${li.sku} | qty=${li.quantity} extPrice=${li.extendedPrice} unitPrice=${li.unitPrice} → derived=${derivedQty}`);
    }
}
main();
