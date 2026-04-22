import { describe, expect, it } from "vitest";
import { buildEmailBody, buildSlackBody, type BuildBlockingInfo } from "./oos-email-trigger";
import type { OOSReportResult, EnrichedOOSItem, EnrichedPOInfo } from "./oos-report";

describe("oos email trigger wording", () => {
    it("uses vendor outreach wording for aging PO sections", () => {
        const po: EnrichedPOInfo = {
            orderId: "PO-100",
            status: "open",
            orderDate: "2026-04-01",
            supplier: "Test Vendor",
            quantityOnOrder: 10,
            total: "$100.00",
            finaleUrl: "https://example.com/po",
            expectedDelivery: "2026-04-10",
            trackingNumbers: [],
            trackingLinks: [],
            trackingStatuses: [],
            shipDate: null,
            carrier: null,
        };

        const item: EnrichedOOSItem = {
            sku: "SKU-1",
            productName: "Test Product",
            variant: "Default",
            shopifyVendor: "Test Vendor",
            shopifyCommitted: 0,
            shopifyAvailable: 0,
            shopifyOnHand: 0,
            shopifyIncoming: 10,
            shopifyProductUrl: "https://example.com/product",
            finaleStatus: "active",
            finaleSupplier: "Test Vendor",
            isManufactured: false,
            hasBOM: false,
            leadTimeDays: null,
            openPOs: [po],
            actionRequired: "REVIEW - test",
            finaleProductUrl: "https://example.com/finale-product",
        };

        const result: OOSReportResult = {
            outputPath: "tmp/report.xlsx",
            totalItems: 1,
            needsOrder: [],
            onOrder: [],
            agingPOs: ["SKU-1"],
            internalBuild: [],
            notInFinale: [],
            received: [],
            needsReview: [],
        };

        const html = buildEmailBody(
            result,
            [item],
            [],
            new Map<string, BuildBlockingInfo>(),
            "Apr 22, 2026",
        );
        const slack = buildSlackBody(
            result,
            [item],
            [],
            new Map<string, BuildBlockingInfo>(),
        );

        expect(html).toContain("Aging POs - Vendor Outreach");
        expect(slack).toContain("Aging POs - Vendor Outreach");
    });
});
