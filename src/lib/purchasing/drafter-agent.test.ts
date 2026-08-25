/**
 * @file    src/lib/purchasing/drafter-agent.test.ts
 * @purpose Unit tests for the drafter-agent's pure helpers — the vendor cycle
 *          map build (Gate 4 feed). Zero network, zero DB.
 * @author  Hermia
 * @created 2026-08-25
 * @deps    vitest
 */

import { describe, expect, it, vi } from "vitest";

// Heavy deps — never touch live systems from a unit test. The pure helper
// under test only needs the map/classify functions from vendor-order-cycle.
vi.mock("../db", () => ({ createClient: () => null }));
vi.mock("../finale/client", () => ({ FinaleClient: class {} }));

import { buildVendorCycleMap } from "./drafter-agent";

function daysAgo(days: number): string {
    return new Date(Date.now() - days * 86400000).toISOString();
}

const groups = [
    { vendorPartyId: "party-grassroots", vendorName: "Grassroots Fabric Pots" },
    { vendorPartyId: "party-uline", vendorName: "ULINE" },
];

describe("buildVendorCycleMap", () => {
    it("locks a vendor with a recent non-canceled, non-dropship PO", () => {
        const recentPOs = [
            {
                orderId: "PO-1234",
                orderDate: daysAgo(10), // inside the 45-day fetch AND the 30-day cycle window
                status: "ORDER_COMMITTED",
                supplier: "Grassroots Fabric Pots",
                vendorPartyId: "party-grassroots",
            },
        ];
        const map = buildVendorCycleMap(groups, recentPOs);
        expect(map["party-grassroots"].decision).toBe("routine_locked");
        expect(map["party-grassroots"].blockingPO?.orderId).toBe("PO-1234");
    });

    it("does not lock on canceled or dropship POs", () => {
        const recentPOs = [
            {
                orderId: "PO-9999",
                orderDate: daysAgo(5),
                status: "ORDER_CANCELED",
                supplier: "ULINE",
                vendorPartyId: "party-uline",
            },
            {
                orderId: "PO-9998",
                orderDate: daysAgo(5),
                status: "ORDER_DROPSHIP",
                isDropship: true,
                supplier: "ULINE",
                vendorPartyId: "party-uline",
            },
        ];
        const map = buildVendorCycleMap(groups, recentPOs);
        expect(map["party-uline"].decision).toBe("clear");
    });

    it("clears a vendor with no matching POs at all", () => {
        const map = buildVendorCycleMap(groups, []);
        expect(map["party-grassroots"].decision).toBe("clear");
        expect(map["party-uline"].decision).toBe("clear");
    });
});
