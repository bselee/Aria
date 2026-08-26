// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import ActivePurchasesPanel from "./ActivePurchasesPanel";

function stubLocalStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
    });
}

function stubFetch(purchasesPayload: any) {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
        const u = String(url);
        if (u.includes("/api/dashboard/active-purchases")) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve(purchasesPayload) });
        }
        if (u.includes("/api/dashboard/po-shipment-legs")) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ legs: {} }) });
        }
        if (u.includes("/api/dashboard/vendor-reliability")) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) });
        }
        // PostgREST at-risk index and anything else — empty result
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [], error: null }) });
    }));
}

function makePurchase(overrides: Record<string, any> = {}) {
    return {
        orderId: "PO-100",
        vendorName: "ULINE",
        status: "committed",
        orderDate: "2026-03-01",
        expectedDate: "2026-04-05",
        receiveDate: null,
        total: 1234,
        items: [{ productId: "SKU-1", quantity: 10 }],
        finaleUrl: "https://finale.example/PO-100",
        leadProvenance: "21d default",
        isReceived: false,
        completionState: "in_flight",
        trackingNumbers: [],
        shipments: [],
        sentVerification: {
            verified: true,
            sentAt: "2026-03-01T10:00:00.000Z",
            source: "po_send",
            evidence: [],
        },
        etaProfile: {
            expectedDate: "2026-04-05",
            source: "default",
            confidence: "low",
            label: "21d default",
        },
        ...overrides,
    };
}

const confirmedMovement = {
    status: "in_transit",
    trackingNumbers: ["1Z999AA10123456784"],
    primaryEta: "2026-04-03T17:00:00.000Z",
    primaryCarrier: "UPS",
    primaryUrl: "https://www.ups.com/track?tracknum=1Z999AA10123456784",
    evidenceLevel: "confirmed",
    deliveredAt: null,
    hoursSinceDelivered: null,
    receiptLag: "ok",
    receiptLagLabel: null,
    invoice: { state: "paid", invoiceId: "INV-7", hasTrackingFromInvoice: false },
    correlation: { orphanTrackingCount: 0, poLinkedShipmentCount: 1, lastSource: "carrier_poll" },
};

describe("ActivePurchasesPanel movement badge strip", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders carrier + tracking + ETA for a confirmed PO", async () => {
        stubLocalStorage();
        stubFetch({
            purchases: [makePurchase({ movement: confirmedMovement })],
            cachedAt: "2026-04-05T00:00:00.000Z",
        });

        render(<ActivePurchasesPanel embedded />);

        // New format: "UPS 1Z99…84" (carrier + short tracking)
        await waitFor(() => expect(screen.getByText(/UPS.*1Z99/)).toBeTruthy());
        // ETA shown inline with dot prefix
        expect(screen.getByText(/ETA Apr 3/)).toBeTruthy();
        // Tracking link points to carrier URL
        const trackLink = screen.getByRole("link", { name: /UPS/ });
        expect(trackLink.getAttribute("href")).toBe("https://www.ups.com/track?tracknum=1Z999AA10123456784");
    });

    it("shows NEED RECEIVE when carrier delivered but Finale not received", async () => {
        stubLocalStorage();
        stubFetch({
            purchases: [
                makePurchase({
                    isReceived: false,
                    movement: {
                        ...confirmedMovement,
                        status: "delivered",
                        primaryEta: null,
                        deliveredAt: "2026-04-03T12:00:00.000Z",
                        hoursSinceDelivered: 36,
                        receiptLag: "flag",
                        receiptLagLabel: "DELIVERED 36h · need receive",
                    },
                    shipments: [
                        {
                            tracking_number: "1Z999AA10123456784",
                            public_tracking_url: confirmedMovement.primaryUrl,
                            status_display: "Delivered",
                            status_category: "delivered",
                            estimated_delivery_at: null,
                            evidenceLevel: "confirmed",
                        },
                    ],
                }),
            ],
            cachedAt: "2026-04-05T00:00:00.000Z",
        });

        render(<ActivePurchasesPanel embedded />);

        // New format: "· NEED RECEIVE 36h"
        await waitFor(() => expect(screen.getByText(/NEED RECEIVE 36h/)).toBeTruthy());
    });

    it("shows NEED RECEIVE in red past 48h delivered-unreceived", async () => {
        stubLocalStorage();
        stubFetch({
            purchases: [
                makePurchase({
                    isReceived: false,
                    movement: {
                        ...confirmedMovement,
                        status: "delivered",
                        primaryEta: null,
                        hoursSinceDelivered: 55,
                        receiptLag: "escalate",
                        receiptLagLabel: "DELIVERED 55h · OVERDUE receive",
                    },
                }),
            ],
            cachedAt: "2026-04-05T00:00:00.000Z",
        });

        render(<ActivePurchasesPanel embedded />);

        // New format: "· NEED RECEIVE 55h" (rose-400 for escalate)
        await waitFor(() => expect(screen.getByText(/NEED RECEIVE 55h/)).toBeTruthy());
        const el = screen.getByText(/NEED RECEIVE 55h/);
        expect(el.className).toContain("text-rose-400");
    });

    it("shows carrier + tracking for candidate-only evidence (no unconfirmed label)", async () => {
        stubLocalStorage();
        stubFetch({
            purchases: [
                makePurchase({
                    movement: {
                        ...confirmedMovement,
                        status: "candidate",
                        evidenceLevel: "candidate",
                        invoice: { state: "none", hasTrackingFromInvoice: false },
                    },
                }),
            ],
            cachedAt: "2026-04-05T00:00:00.000Z",
        });

        render(<ActivePurchasesPanel embedded />);

        // New format: carrier + tracking (no "unconfirmed" label)
        await waitFor(() => expect(screen.getByText(/UPS.*1Z99/)).toBeTruthy());
        const trackLink = screen.getByRole("link", { name: /UPS/ });
        expect(trackLink.getAttribute("href")).toBe("https://www.ups.com/track?tracknum=1Z999AA10123456784");
    });

    it("shows 'No tracking yet' when evidence is none", async () => {
        stubLocalStorage();
        stubFetch({
            purchases: [
                makePurchase({
                    typicalTrackingSource: "Email Body",
                    movement: {
                        status: "none",
                        trackingNumbers: [],
                        primaryEta: null,
                        primaryCarrier: null,
                        primaryUrl: null,
                        evidenceLevel: "none",
                        deliveredAt: null,
                        hoursSinceDelivered: null,
                        receiptLag: "ok",
                        receiptLagLabel: null,
                        invoice: { state: "none", hasTrackingFromInvoice: false },
                        correlation: { orphanTrackingCount: 0, poLinkedShipmentCount: 0, lastSource: null },
                    },
                }),
            ],
            cachedAt: "2026-04-05T00:00:00.000Z",
        });

        render(<ActivePurchasesPanel embedded />);

        await waitFor(() => expect(screen.getByText(/No tracking yet/)).toBeTruthy());
    });

    it("shows OVERDUE when past expected date", async () => {
        stubLocalStorage();
        stubFetch({
            purchases: [
                makePurchase({
                    expectedDate: "2026-03-01", // past date
                    movement: {
                        ...confirmedMovement,
                        primaryEta: "2026-03-01T17:00:00.000Z",
                    },
                }),
            ],
            cachedAt: "2026-04-05T00:00:00.000Z",
        });

        render(<ActivePurchasesPanel embedded />);

        await waitFor(() => expect(screen.getByText(/OVERDUE/)).toBeTruthy());
    });
});
