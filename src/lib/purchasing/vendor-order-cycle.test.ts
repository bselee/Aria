import { describe, expect, it } from "vitest";

import {
    classifyVendorOrderCycle,
    deriveVendorCycleExceptionEvidence,
    mapRecentPOsToVendorCyclePOs,
} from "./vendor-order-cycle";
import type { AssessedPurchasingLine } from "./assessment-service";

function line(overrides: Partial<AssessedPurchasingLine["item"]> = {}): AssessedPurchasingLine {
    return {
        item: {
            productId: "BSA101",
            productName: "TeaLAB item",
            supplierName: "TeaLAB",
            supplierPartyId: "party-tealab",
            unitPrice: 15,
            stockOnHand: 20,
            stockOnOrder: 0,
            purchaseVelocity: 0,
            salesVelocity: 1,
            demandVelocity: 1,
            dailyRate: 1,
            runwayDays: 20,
            adjustedRunwayDays: 20,
            leadTimeDays: 14,
            leadTimeProvenance: "14d (Finale)",
            openPOs: [],
            urgency: "warning",
            explanation: "Routine reorder.",
            suggestedQty: 24,
            orderIncrementQty: 1,
            isBulkDelivery: false,
            finaleReorderQty: 24,
            finaleStockoutDays: 20,
            finaleConsumptionQty: 0,
            finaleDemandQty: 90,
            ...overrides,
        },
        candidate: {
            vendorName: "TeaLAB",
            productId: overrides.productId ?? "BSA101",
            directDemand: overrides.demandVelocity ?? 1,
            bomDemand: 0,
            stockOnHand: overrides.stockOnHand ?? 20,
            stockOnOrder: overrides.stockOnOrder ?? 0,
            adjustedRunwayDays: overrides.adjustedRunwayDays ?? 20,
            finishedGoodsCoverageDays: null,
            leadTimeDays: overrides.leadTimeDays ?? 14,
            suggestedQty: overrides.suggestedQty ?? 24,
            orderIncrementQty: overrides.orderIncrementQty ?? 1,
            minimumOrderQty: null,
            minimumOrderValue: null,
            unitPrice: overrides.unitPrice ?? 15,
            explanation: "Routine reorder.",
            sourceUrgency: overrides.urgency ?? "warning",
            openPOs: [],
            leadTimeProvenance: "14d (Finale)",
            finaleDemandQty: 90,
            finaleConsumptionQty: 0,
            isBulkDelivery: false,
            reorderMethod: "default",
        },
        assessment: {
            vendorName: "TeaLAB",
            productId: overrides.productId ?? "BSA101",
            decision: "order",
            recommendedQty: overrides.suggestedQty ?? 24,
            confidence: "high",
            reasonCodes: ["direct_demand_support"],
            explanation: "Current demand supports reorder.",
            metrics: {
                directDemand: overrides.demandVelocity ?? 1,
                bomDemand: 0,
                sharedDemand: overrides.demandVelocity ?? 1,
                stockOnHand: overrides.stockOnHand ?? 20,
                stockOnOrder: overrides.stockOnOrder ?? 0,
                adjustedRunwayDays: overrides.adjustedRunwayDays ?? 20,
                finishedGoodsCoverageDays: null,
                leadTimeDays: overrides.leadTimeDays ?? 14,
            },
        },
    };
}

describe("classifyVendorOrderCycle", () => {
    it("maps Finale recent PO history into vendor cycle PO records", () => {
        const mapped = mapRecentPOsToVendorCyclePOs([
            {
                orderId: "124832",
                vendorName: "TeaLAB",
                vendorPartyId: "party-tealab",
                status: "Committed",
                orderDate: "2026-05-19T15:00:00.000Z",
                receiveDate: "2026-05-29",
                items: [
                    { productId: "BSA101" },
                    { sku: "BBB101" },
                    { productId: "" },
                ],
            },
            { orderId: "missing-date", orderDate: null, items: [] },
        ]);

        expect(mapped).toEqual([
            {
                orderId: "124832",
                vendorName: "TeaLAB",
                vendorPartyId: "party-tealab",
                status: "Committed",
                orderDate: "2026-05-19",
                receiveDate: "2026-05-29",
                skus: ["BSA101", "BBB101"],
            },
        ]);
    });

    it("locks routine replenishment when a stocking PO exists in the 30-day vendor cycle", () => {
        const decision = classifyVendorOrderCycle({
            vendorPartyId: "party-tealab",
            asOfDate: "2026-05-27",
            requestedLines: [line()],
            recentPOs: [
                {
                    orderId: "124832",
                    vendorPartyId: "party-tealab",
                    vendorName: "TeaLAB",
                    status: "Committed",
                    orderDate: "2026-05-19",
                    receiveDate: null,
                    skus: ["BSA101"],
                },
            ],
        });

        expect(decision.decision).toBe("routine_locked");
        expect(decision.blockingPO?.orderId).toBe("124832");
        expect(decision.lockedUntil).toBe("2026-06-18");
    });

    it("ignores canceled and dropship POs for routine cycle locks", () => {
        const decision = classifyVendorOrderCycle({
            vendorPartyId: "party-grassroots",
            asOfDate: "2026-05-27",
            requestedLines: [line({ supplierPartyId: "party-grassroots", supplierName: "Grassroots Fabric Pots" })],
            recentPOs: [
                {
                    orderId: "124731",
                    vendorPartyId: "party-grassroots",
                    vendorName: "Grassroots Fabric Pots",
                    status: "Canceled",
                    orderDate: "2026-04-30",
                    receiveDate: null,
                    skus: ["GLP101"],
                },
                {
                    orderId: "23391567-DropshipPO",
                    vendorPartyId: "party-grassroots",
                    vendorName: "Grassroots Fabric Pots",
                    status: "Completed",
                    orderDate: "2026-05-20",
                    receiveDate: null,
                    skus: ["GLP105"],
                },
            ],
        });

        expect(decision.decision).toBe("clear");
        expect(decision.ignoredPOs.map(po => po.orderId).sort()).toEqual(["124731", "23391567-DropshipPO"].sort());
    });

    it("allows a build or surge exception even when routine cycle is locked", () => {
        const exceptionLine = line({
            productId: "BSA101",
            triggerReason: "stockout-padded",
            adjustedRunwayDays: 2,
            runwayDays: 2,
            urgency: "critical",
        } as any);

        const decision = classifyVendorOrderCycle({
            vendorPartyId: "party-tealab",
            asOfDate: "2026-05-27",
            requestedLines: [exceptionLine],
            recentPOs: [
                {
                    orderId: "124801",
                    vendorPartyId: "party-tealab",
                    vendorName: "TeaLAB",
                    status: "Completed",
                    orderDate: "2026-05-07",
                    receiveDate: "2026-05-21",
                    skus: ["BSA102", "BBB101"],
                },
            ],
        });

        expect(decision.decision).toBe("exception_allowed");
        expect(decision.exceptionEvidence.map(evidence => evidence.reason)).toContain("stockout_before_cycle_end");
    });

    it("derives exception evidence from build-driven trigger context", () => {
        const evidence = deriveVendorCycleExceptionEvidence(line({
            productId: "GLP114",
            triggerReason: "build-driven",
            triggerDetail: "Build CRAFT10 needs this component.",
        } as any));

        expect(evidence).toEqual([
            expect.objectContaining({
                reason: "build_critical",
                productId: "GLP114",
            }),
        ]);
    });
});
