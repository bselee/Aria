import fs from "fs";
import path from "path";
import {
    buildFinaleSkuMappingReviewRows,
    parseFinaleProductListCsv,
    writeFinaleSkuWorkbook,
} from "../lib/axiom/finale-sku-workbook";

interface Args {
    input: string;
    output: string;
}

function parseArgs(argv: string[]): Args {
    const inputIndex = argv.indexOf("--input");
    const outputIndex = argv.indexOf("--output");
    const input = inputIndex >= 0 ? argv[inputIndex + 1] : "";
    const output = outputIndex >= 0 ? argv[outputIndex + 1] : "";

    if (!input || !output) {
        throw new Error("Usage: tsx src/scripts/build-axiom-finale-sku-workbook.ts --input <finale-products.csv> --output <workbook.xlsx>");
    }

    return { input, output };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const csvText = fs.readFileSync(args.input, "utf8");
    const products = parseFinaleProductListCsv(csvText);
    const rows = buildFinaleSkuMappingReviewRows(products);

    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    await writeFinaleSkuWorkbook(rows, args.output);

    const active = rows.filter(row => row.specStatus !== "do_not_reorder").length;
    const doNotReorder = rows.length - active;
    console.log(`Wrote ${rows.length} Finale-SKU-first Axiom rows to ${args.output}`);
    console.log(`Active/reorderable: ${active}; do not reorder: ${doNotReorder}`);
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
