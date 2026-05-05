// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import PurchasingPanel from "./PurchasingPanel";

function stubLocalStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
    });
}

function makeFixtureItem() {
    return {
        productId: "CP-LABEL-1",
        productName: "Colorful printed label",
        supplierName: "Colorful Packaging Ltd",
        supplierPartyId: "10918",
        unitPrice: 14,
        stockOnHand: 44,
        stockOnOrder: 0,
        purchaseVelocity: 1,
        salesVelocity: 1,
        demandVelocity: 1,
        dailyRate: 1,
        dailyRateSource: "demand",
        runwayDays: 12,
        adjustedRunwayDays: 12,
        leadTimeDays: 45,
        leadTimeProvenance: "vendor policy override",
        openPOs: [],
        urgency: "critical",
        explanation: "12 day runway. Vendor policy: order 6 months at a time.",
        suggestedQty: 200,
        orderIncrementQty: 100,
        isBulkDelivery: false,
        finaleReorderQty: null,
        finaleStockoutDays: 12,
        finaleConsumptionQty: null,
        finaleDemandQty: 1,
        reorderMethod: "default",
        recommendation: {
            formulaVersion: "v2.1-vendor-policy-2026-05-06",
            coverDays: 180,
            rawNeededEaches: 86,
            provenance: [
                { step: "lead_time", detail: "Using 45d vendor policy override", value: 45 },
                { step: "cover_days", detail: "Using 180d total cover from vendor policy", value: 180 },
            ],
        },
        assessment: {
            decision: "order",
            recommendedQty: 200,
            confidence: "high",
            reasonCodes: [],
            explanation: "Order recommended — runway low, vendor cover policy applies.",
        },
        vendorPolicy: {
            leadTimeOverrideDays: 45,
            targetCoverDays: 180,
            moqMode: "warn",
            overbuyReviewPct: 50,
            overbuyReviewDollars: 1000,
            notes: "Custom packaging: 30-45 day lead time, order roughly 6 months at a time.",
        },
        moqWarning: true,
        reviewRequired: true,
        reviewReasons: [
            "Large overbuy from ordering constraints: +100 eaches (233%) approx $1400",
        ],
    };
}

function stubFetch() {
    const criticalPayload = {
        groups: [
            {
                vendorName: "Colorful Packaging Ltd",
                vendorPartyId: "10918",
                urgency: "critical",
                items: [makeFixtureItem()],
            },
        ],
        cachedAt: "2026-05-05T12:00:00.000Z",
        vendorSummaries: [
            {
                vendorName: "Colorful Packaging Ltd",
                vendorPartyId: "10918",
                actionableCount: 1,
                blockedCount: 0,
                highestConfidence: "high",
            },
        ],
    };
    const emptyPayload = {
        groups: [],
        cachedAt: "2026-05-05T12:00:00.000Z",
        vendorSummaries: [],
    };

    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        let body: any = emptyPayload;
        if (url.includes("/api/dashboard/purchasing") && url.includes("urgency=critical")) {
            body = criticalPayload;
        } else if (url.includes("/api/dashboard/active-purchases")) {
            body = { activePurchases: [], asOf: "2026-05-05T12:00:00.000Z" };
        }
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(body),
        });
    }));
}

describe("PurchasingPanel - vendor policy badges", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders cover/lead/MOQ-warn/Review badges and review reasons block", async () => {
        stubLocalStorage();
        stubFetch();

        render(<PurchasingPanel />);

        await waitFor(() => expect(fetch).toHaveBeenCalled());

        // Vendor groups render collapsed by default — click the vendor tab to expand items.
        const vendorTab = await screen.findByText(/Colorful Packagi/i);
        fireEvent.click(vendorTab);

        await waitFor(() => expect(screen.getByText("180d cover")).toBeTruthy());

        expect(screen.getByText("180d cover")).toBeTruthy();
        expect(screen.getByText("45d lead")).toBeTruthy();
        expect(screen.getByText("MOQ warn")).toBeTruthy();
        expect(screen.getByText("Review")).toBeTruthy();
        expect(
            screen.getByText(/Large overbuy from ordering constraints: \+100 eaches/i),
        ).toBeTruthy();
    });
});
