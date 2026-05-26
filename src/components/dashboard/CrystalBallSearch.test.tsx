// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CrystalBallSearch } from "./CrystalBallSearch";
import type { CrystalBallItem } from "./CrystalBallDetail";

function makeResult(productId: string): CrystalBallItem {
    return {
        productId,
        productName: `${productId} product`,
        vendorName: "Concentrates Inc.",
        vendorPartyId: "vendor-123",
        itemType: "bom-component",
        stockOnHand: 10,
        stockOnOrder: 0,
        dailyRate: 1,
        dailyRateSource: "demand",
        dailyRateLabel: "Demand Burn",
        unitPrice: 1,
        salesVelocity: 0,
        demandVelocity: 1,
        runwayDays: 10,
        adjustedRunwayDays: 10,
        projectedStockoutDate: "2026-06-01",
        leadTimeDays: 14,
        leadTimeProvenance: "14d default",
        projections: [],
        openPOs: [],
        recommendation: {
            suggestedQty: 20,
            urgency: "critical",
            coverDays: 90,
            provenance: [],
            formulaVersion: "test",
        },
    };
}

describe("CrystalBallSearch", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("offers a vendor-only action when a supplier search matches multiple SKUs", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                results: [makeResult("FM104"), makeResult("FM105")],
            }),
        }));
        const onVendorSelect = vi.fn();

        render(<CrystalBallSearch onSelect={() => undefined} onVendorSelect={onVendorSelect} />);

        fireEvent.change(screen.getByPlaceholderText(/Search SKU or Supplier/i), {
            target: { value: "Concentrates" },
        });

        await waitFor(() => expect(screen.getByText(/View supplier: Concentrates Inc\./i)).toBeTruthy());
        fireEvent.click(screen.getByText(/View supplier: Concentrates Inc\./i));

        expect(onVendorSelect).toHaveBeenCalledWith({
            vendorName: "Concentrates Inc.",
            vendorPartyId: "vendor-123",
        });
    });
});
