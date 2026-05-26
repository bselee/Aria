import fs from "fs";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
    buildFinaleSkuMappingReviewRows,
    parseFinaleProductListCsv,
    writeFinaleSkuWorkbook,
} from "./finale-sku-workbook";

const SAMPLE_CSV = `Product ID,Description,QoH units,Stockout (configurable),Days until reorder (configurable),Sales last 30 days,Sales last 60 days,Consumption velocity (configurable),ROM,Category,Sublocation summary,Units Per Pallet,Grade,Liquid,Supplier 1,Wholesale Price,BuildASoil Price
OAG104LABELFR,FCB Castor Bean 1gal Label Front,120,,,0,0,0,Demand velocity,Product Labels,MFG: 120,,A,,Axiom Print,,
OAG104LABELBK,FCB Castor Bean 1gal Label Back,110,,,0,0,0,Demand velocity,Product Labels,MFG: 110,,A,,Axiom Print,,
APL104,"Label - (L.O.S. Malibu Soil 8.5""x11"" - Cubic Foot)",7030,,,0,0,0,Do not reorder,Deprecating,SOIL: 7030,,C,,Axiom Print,,
`;

describe("Finale SKU Axiom workbook generation", () => {
    it("builds one mapping review row per Finale SKU with Finale SKU as the reference", () => {
        const products = parseFinaleProductListCsv(SAMPLE_CSV);
        const rows = buildFinaleSkuMappingReviewRows(products);

        expect(rows).toHaveLength(3);
        expect(rows.map(row => row.finaleSku)).toEqual([
            "APL104",
            "OAG104LABELBK",
            "OAG104LABELFR",
        ]);
        expect(rows[0]).toMatchObject({
            finaleSku: "APL104",
            axiomJobName: "APL104",
            finaleSkus: "APL104",
            specStatus: "do_not_reorder",
            autoOrderAllowed: "no",
        });
        expect(rows.find(row => row.finaleSku === "OAG104LABELFR")).toMatchObject({
            labelSide: "front",
            frontBackGroup: "OAG104",
            qtyFraction: 1,
        });
        expect(rows.find(row => row.finaleSku === "OAG104LABELBK")).toMatchObject({
            labelSide: "back",
            frontBackGroup: "OAG104",
            qtyFraction: 1,
        });
    });

    it("writes a workbook with Mapping Review and Order Templates keyed by Finale SKU", async () => {
        const rows = buildFinaleSkuMappingReviewRows(parseFinaleProductListCsv(SAMPLE_CSV));
        const outputPath = path.join(os.tmpdir(), `axiom-finale-sku-workbook-${Date.now()}.xlsx`);

        await writeFinaleSkuWorkbook(rows, outputPath);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(outputPath);
        const review = workbook.getWorksheet("Mapping Review");
        const templates = workbook.getWorksheet("Order Templates");

        expect(review).toBeDefined();
        expect(templates).toBeDefined();
        expect(review!.getRow(1).values).toContain("finale_sku");
        expect(review!.getCell("A2").value).toBe("APL104");
        expect(templates!.getCell("A2").value).toBe("APL104");
        expect(templates!.getCell("H2").value).toBe("no");

        fs.unlinkSync(outputPath);
    });
});
