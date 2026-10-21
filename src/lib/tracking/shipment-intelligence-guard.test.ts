/**
 * @file    shipment-intelligence-guard.test.ts
 * @purpose UPDATE-only guard tests for the two purchase_orders writers that
 *          used to blind-upsert phantom PO rows (vendor_name null, no
 *          line_items, total 0) for vendor/broker/outbound-freight references
 *          that are NOT real Finale POs.
 *
 *          Contract: syncLegacyPurchaseOrderTracking and
 *          _doSyncPOLifecycleFromShipment may only UPDATE an existing
 *          purchase_orders row (created by po-finale-sync); they must NEVER
 *          INSERT a row for a reference not already in the table.
 * @author  aria-coder
 * @created 2026-09
 * @deps    vitest
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    poRows: [] as any[],
    shipments: [] as any[],
    updateCalls: [] as Array<{ po_number: string; payload: any }>,
    upsertCalls: [] as any[],
}));

const finale = vi.hoisted(() => ({
    updateTracking: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db", () => ({
    createClient: vi.fn(() => {
        return {
            from: (table: string) => {
                if (table === "purchase_orders") {
                    return {
                        select: () => ({
                            eq: (_col: string, val: any) => ({
                                maybeSingle: async () => {
                                    const row = state.poRows.find((r) => r.po_number === val);
                                    return { data: row ?? null, error: null };
                                },
                            }),
                            in: async () => ({ data: [], error: null }),
                        }),
                        update: (payload: any) => ({
                            eq: (_col: string, val: any) => {
                                state.updateCalls.push({ po_number: val, payload });
                                return Promise.resolve({ error: null });
                            },
                        }),
                        upsert: (payload: any) => {
                            state.upsertCalls.push(payload);
                            return Promise.resolve({ error: null });
                        },
                    };
                }
                if (table === "shipments") {
                    return {
                        select: () => ({
                            contains: () => ({
                                eq: async () => ({ data: state.shipments, error: null }),
                            }),
                        }),
                    };
                }
                throw new Error(`Unexpected table ${table}`);
            },
        };
    }),
}));

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: class {
        async updatePurchaseOrderTracking(...args: any[]) {
            return finale.updateTracking(...args);
        }
    },
}));

import {
    syncLegacyPurchaseOrderTracking,
    _doSyncPOLifecycleFromShipment,
} from "./shipment-intelligence";

function makeShipment(overrides: Record<string, any> = {}): any {
    return {
        id: "ship-1",
        tracking_key: "fedex:123456789012",
        tracking_number: "123456789012",
        normalized_tracking_number: "123456789012",
        carrier_name: "FedEx",
        carrier_key: "fedex",
        tracking_kind: "parcel",
        po_numbers: ["125280"],
        vendor_names: ["Cen-Tec"],
        status_category: "in_transit",
        status_display: "In transit",
        public_tracking_url: "https://example.com/track/123456789012",
        estimated_delivery_at: null,
        delivered_at: null,
        last_checked_at: null,
        last_source: "email_tracking",
        source_confidence: 0.9,
        source_refs: [],
        active: true,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
        ...overrides,
    };
}

beforeEach(() => {
    state.poRows = [];
    state.shipments = [];
    state.updateCalls = [];
    state.upsertCalls = [];
    finale.updateTracking.mockClear();
});

describe("syncLegacyPurchaseOrderTracking (UPDATE-only guard)", () => {
    it("does NOT insert a purchase_orders row when the PO does not exist", async () => {
        state.shipments = [{ tracking_number: "1Z999AA10123456784", public_tracking_url: "https://x/t" }];

        await syncLegacyPurchaseOrderTracking("999999");

        expect(state.upsertCalls).toHaveLength(0);
        expect(state.updateCalls).toHaveLength(0);
        expect(finale.updateTracking).not.toHaveBeenCalled();
    });

    it("UPDATEs an existing PO's tracking_numbers (never upsert/insert)", async () => {
        state.poRows = [{ po_number: "125280", vendor_name: "Cen-Tec" }];
        state.shipments = [{ tracking_number: "1Z999AA10123456784", public_tracking_url: "https://x/t" }];

        await syncLegacyPurchaseOrderTracking("125280");

        expect(state.upsertCalls).toHaveLength(0);
        expect(state.updateCalls).toHaveLength(1);
        expect(state.updateCalls[0].po_number).toBe("125280");
        expect(state.updateCalls[0].payload.tracking_numbers).toContain("1Z999AA10123456784");
        // Finale push still fires for a real PO.
        expect(finale.updateTracking).toHaveBeenCalledWith(
            "125280",
            "1Z999AA10123456784",
            "https://x/t",
        );
    });

    it("skips a row that exists but has NULL vendor_name (phantom / non-Finale ref)", async () => {
        state.poRows = [{ po_number: "113205", vendor_name: null }];
        state.shipments = [{ tracking_number: "466969990027", public_tracking_url: "https://x/t" }];

        await syncLegacyPurchaseOrderTracking("113205");

        expect(state.updateCalls).toHaveLength(0);
        expect(state.upsertCalls).toHaveLength(0);
        expect(finale.updateTracking).not.toHaveBeenCalled();
    });

    it("skips a closed row (closed phantom still anchors evidence — the 4764 case)", async () => {
        state.poRows = [{ po_number: "4764", vendor_name: "Brite Ideas", status: "closed" }];
        state.shipments = [{ tracking_number: "64058921", public_tracking_url: "https://x/t" }];

        await syncLegacyPurchaseOrderTracking("4764");

        expect(state.updateCalls).toHaveLength(0);
        expect(state.upsertCalls).toHaveLength(0);
        expect(finale.updateTracking).not.toHaveBeenCalled();
    });

    it("skips the merge when a PO accumulates more than 25 trackings (magnet containment)", async () => {
        state.poRows = [{ po_number: "125280", vendor_name: "Cen-Tec", status: "open" }];
        state.shipments = Array.from({ length: 26 }, (_, i) => ({
            tracking_number: `1Z999AA1012345678${String(i).padStart(2, "0")}`,
            public_tracking_url: `https://x/t${i}`,
        }));

        await syncLegacyPurchaseOrderTracking("125280");

        expect(state.updateCalls).toHaveLength(0);
        expect(state.upsertCalls).toHaveLength(0);
        expect(finale.updateTracking).not.toHaveBeenCalled();
    });
});

describe("_doSyncPOLifecycleFromShipment (UPDATE-only guard)", () => {
    it("does NOT insert a purchase_orders row when the PO does not exist", async () => {
        await _doSyncPOLifecycleFromShipment("999999", makeShipment({ po_numbers: ["999999"] }));

        expect(state.upsertCalls).toHaveLength(0);
        expect(state.updateCalls).toHaveLength(0);
    });

    it("UPDATEs an existing PO's lifecycle (never upsert/insert)", async () => {
        state.poRows = [{
            po_number: "125280",
            vendor_name: "Cen-Tec",
            status: "open",
            lifecycle_stage: "sent",
            tracking_status_summary: null,
            shipping_evidence: [],
            lifecycle_transitions: [],
        }];

        await _doSyncPOLifecycleFromShipment("125280", makeShipment({ po_numbers: ["125280"] }));

        expect(state.upsertCalls).toHaveLength(0);
        expect(state.updateCalls.length).toBeGreaterThanOrEqual(1);
        // At least one update targets the existing PO.
        expect(state.updateCalls.some((c) => c.po_number === "125280")).toBe(true);
    });

    it("skips a row that exists but has NULL vendor_name (phantom / non-Finale ref)", async () => {
        state.poRows = [{
            po_number: "149915",
            vendor_name: null,
            status: "open",
            lifecycle_stage: "sent",
            tracking_status_summary: null,
            shipping_evidence: [],
            lifecycle_transitions: [],
        }];

        await _doSyncPOLifecycleFromShipment("149915", makeShipment({ po_numbers: ["149915"] }));

        expect(state.upsertCalls).toHaveLength(0);
        expect(state.updateCalls).toHaveLength(0);
    });

    it("skips a closed row (closed phantom still anchors evidence)", async () => {
        state.poRows = [{
            po_number: "4764",
            vendor_name: "Brite Ideas",
            status: "closed",
            lifecycle_stage: "sent",
            tracking_status_summary: null,
            shipping_evidence: [],
            lifecycle_transitions: [],
        }];

        await _doSyncPOLifecycleFromShipment("4764", makeShipment({ po_numbers: ["4764"] }));

        expect(state.upsertCalls).toHaveLength(0);
        expect(state.updateCalls).toHaveLength(0);
    });
});
