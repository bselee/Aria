// @vitest-environment jsdom

import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CrystalBallDetail, type CrystalBallItem } from "./CrystalBallDetail";

function makeItem(overrides: Partial<CrystalBallItem> = {}): CrystalBallItem {
    return {
        productId: "FM104",
        productName: "Fish Meal",
        vendorName: "Concentrates Inc.",
        vendorPartyId: "123",
        itemType: "bom-component",
        stockOnHand: 30.79,
        stockOnOrder: 0,
        dailyRate: 0.77,
        dailyRateSource: "demand",
        dailyRateLabel: "Demand Burn",
        unitPrice: 58.2,
        salesVelocity: 0,
        demandVelocity: 0.77,
        runwayDays: 40,
        adjustedRunwayDays: 40,
        projectedStockoutDate: "2026-07-05",
        leadTimeDays: 14,
        leadTimeProvenance: "14d default",
        projections: [
            { daysOut: 10, projectedStock: 23, consumed: 8, incoming: 0, surplus: 23, needsOrder: false, orderByDate: null, coveragePct: 100 },
            { daysOut: 30, projectedStock: 8, consumed: 23, incoming: 0, surplus: 8, needsOrder: false, orderByDate: null, coveragePct: 100 },
            { daysOut: 60, projectedStock: -15, consumed: 46, incoming: 0, surplus: -15, needsOrder: true, orderByDate: "2026-06-21", coveragePct: 75 },
        ],
        openPOs: [],
        recommendation: {
            suggestedQty: 40,
            urgency: "watch",
            coverDays: 90,
            provenance: [],
            formulaVersion: "test",
        },
        historicalPOs: [
            { orderId: "124578", orderDate: "2026-04-01", receiveDate: "2026-04-17", quantity: 40, status: "Completed" },
        ],
        stockAvailable: 30.79,
        forwardDemandEntry: {
            requiredQty: 55,
            earliestBuildDate: "2026-05-25",
            feedsBuilds: ["CRAFT10", "CRAFT4"],
        },
        ...overrides,
    };
}

describe("CrystalBallDetail", () => {
    it("puts the ordering verdict and next action date at the top of the deep dive", () => {
        render(<CrystalBallDetail item={makeItem()} onClose={() => undefined} />);

        expect(screen.getByText(/No PO needed today/i)).toBeTruthy();
        expect(screen.getByText(/Next action: order by 2026-06-21/i)).toBeTruthy();
        expect(screen.getByText(/covered for 30d/i)).toBeTruthy();
        expect(screen.getByText(/allocation risk is build-plan based/i)).toBeTruthy();
        expect(screen.getByText(/Recommended PO qty: 40/i)).toBeTruthy();
    });
});
