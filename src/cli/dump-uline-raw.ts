import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import fs from "fs";
import { extractPDF } from "../lib/pdf/extractor";

const buf = fs.readFileSync("C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/ULINE/Uline_Invoice_205814897_119441639_1.pdf");
async function main() {
    const ext = await extractPDF(buf);
    console.log(ext.rawText.slice(0, 4000));
}
main();
