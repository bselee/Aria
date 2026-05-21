import { describe, expect, it } from "vitest";

import {
    FINALE_FREIGHT_DESCRIPTION,
    FINALE_FREIGHT_PROMO_URL,
    buildFinaleFreightAdjustment,
    mergeInvoiceCorrelationNote,
} from "./freight-adjustment";

describe("Finale freight adjustments", () => {
    it("uses Finale's native Freight adjustment so landed cost calculates", () => {
        expect(buildFinaleFreightAdjustment(15.68)).toEqual({
            amount: 15.68,
            description: FINALE_FREIGHT_DESCRIPTION,
            productPromoUrl: FINALE_FREIGHT_PROMO_URL,
        });
    });

    it("keeps invoice correlation in notes instead of the freight adjustment label", () => {
        expect(mergeInvoiceCorrelationNote("", ["INV126321"])).toBe("Invoice #INV126321");
        expect(mergeInvoiceCorrelationNote("Rush order", ["INV126321"])).toBe("Rush order\nInvoice #INV126321");
        expect(mergeInvoiceCorrelationNote("Invoice #INV126321", ["INV126321"])).toBe("Invoice #INV126321");
    });
});
