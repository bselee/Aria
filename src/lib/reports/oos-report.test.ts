import { describe, expect, it } from "vitest";

import { parseStockieCSV } from "./oos-report";

describe("parseStockieCSV", () => {
    it("parses the current Stockie inventory-report header layout", () => {
        const csv = [
            "index,LOCATION,PRODUCT,PRODUCT URL,VARIANT,SKU,BARCODE,VENDOR,THRESHOLD (QTY),COMMITTED,AVAILABLE,ON HAND,INCOMING,RESTOCK TO (QTY),REORDER QTY",
            '0,"BuildASoil HQ","1/4"" to 1/4"" Bulkhead",https://example.com/products/omp101,Default Title,OMP101,,BuildASoil,0,0,0,0,0,,',
            '1,"BuildASoil HQ","3.0 Soil Building Kits",https://example.com/products/sbk103,6 lb,SBK103,810166421232.0,BuildASoil,0,14,0,14,0,,',
        ].join("\n");

        expect(parseStockieCSV(csv)).toEqual([
            {
                sku: "OMP101",
                productName: '1/4" to 1/4" Bulkhead',
                variant: "Default Title",
                shopifyVendor: "BuildASoil",
                shopifyCommitted: 0,
                shopifyAvailable: 0,
                shopifyOnHand: 0,
                shopifyIncoming: 0,
                shopifyProductUrl: "https://example.com/products/omp101",
            },
            {
                sku: "SBK103",
                productName: "3.0 Soil Building Kits",
                variant: "6 lb",
                shopifyVendor: "BuildASoil",
                shopifyCommitted: 14,
                shopifyAvailable: 0,
                shopifyOnHand: 14,
                shopifyIncoming: 0,
                shopifyProductUrl: "https://example.com/products/sbk103",
            },
        ]);
    });

    it("ignores rows without a SKU", () => {
        const csv = [
            "index,LOCATION,PRODUCT,PRODUCT URL,VARIANT,SKU,BARCODE,VENDOR,THRESHOLD (QTY),COMMITTED,AVAILABLE,ON HAND,INCOMING,RESTOCK TO (QTY),REORDER QTY",
            '0,"BuildASoil HQ","Missing SKU",https://example.com/products/no-sku,Default Title,,,BuildASoil,0,0,0,0,0,,',
        ].join("\n");

        expect(parseStockieCSV(csv)).toEqual([]);
    });
});
