// Why did the Stock Bag Depot invoice not link? The PDF prints the PO plainly:
//   Customer PO No.                Payment Terms        ...
//       PO 125492                  PBS-CARD            ...
// Feed the real page text to the real extractor and see what it returns.
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { extractPOByRegex } from "../src/lib/pdf/invoice-parser";

const pdf = "tmp_bol/1a1cd1b3ae7cb378_Sales Invoice 112690.pdf";
const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });

console.log("--- extractor on the real page ---");
console.log("extractPOByRegex =>", JSON.stringify(extractPOByRegex(text)));

console.log("\n--- which label shapes are present in that page ---");
const lines = text.split(/\r?\n/);
for (const [i, l] of lines.entries()) {
    if (/P\.?O\.?|Order\s+No/i.test(l)) console.log(`  ${String(i).padStart(3)}| ${l.trim().slice(0, 120)}`);
}

console.log("\n--- candidate strings, one per label shape ---");
const cases: [string, string][] = [
    ["bare PO + digits, no hash (what this PDF prints)", "Customer PO No.\n    PO 125492"],
    ["PO with hash", "PO# 125492"],
    ["Customer PO + digits directly", "Customer PO 125492"],
    ["Customer PO No. + digits", "Customer PO No. 125492"],
    ["P.O. No. + digits", "P.O. No. 125492"],
    ["Order No. + digits (the vendor's own order number)", "Order No. 113742"],
    ["address trap: PO Box", "Bill To: PO Box 4808 Montrose"],
];
for (const [label, sample] of cases) {
    console.log(`  ${JSON.stringify(extractPOByRegex(sample))}\t<- ${label}`);
}
