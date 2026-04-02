// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import TrackingBoardPanel from "./TrackingBoardPanel";

function stubLocalStorage(initialHeight = "280") {
    const store = new Map<string, string>([["aria-dash-track-h", initialHeight]]);
    vi.stubGlobal("localStorage", {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
    });
}

function stubFetch(payload: any) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(payload),
    }));
}

describe("TrackingBoardPanel", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("restores persisted height and renders board buckets", async () => {
        stubLocalStorage("340");
        stubFetch({
            board: {
                arrivingToday: [
                    {
                        id: "ship-1",
                        poNumbers: ["PO-100"],
                        vendorNames: ["ULINE"],
                        trackingNumber: "123456789012",
                        carrierName: "FedEx",
                        statusDisplay: "Expected Apr 2",
                        statusCategory: "in_transit",
                        estimatedDeliveryAt: "2026-04-02T18:00:00.000Z",
                        deliveredAt: null,
                        publicTrackingUrl: "https://example.com/track/123456789012",
                        freshnessMinutes: 5,
                    },
                ],
                outForDelivery: [],
                deliveredAwaitingReceipt: [],
                exceptions: [],
                stale: [],
                recentlyDelivered: [],
            },
            shipments: [],
            asOf: "2026-04-02T15:00:00.000Z",
            answer: null,
        });

        const { container } = render(<TrackingBoardPanel />);

        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(screen.getByText(/Arriving Today/i)).toBeTruthy();
        expect(screen.getByText(/PO-100/i)).toBeTruthy();
        expect(container.querySelector('[style*="height: 340px"]')).toBeTruthy();
    });

    it("renders the direct tracking answer card when the API returns one", async () => {
        stubLocalStorage();
        stubFetch({
            board: {
                arrivingToday: [],
                outForDelivery: [],
                deliveredAwaitingReceipt: [],
                exceptions: [],
                stale: [],
                recentlyDelivered: [],
            },
            shipments: [],
            asOf: "2026-04-02T15:00:00.000Z",
            answer: {
                primaryLine: "PO-200 - Out for delivery",
                metaLine: "fresh 5m ago",
            },
        });

        render(<TrackingBoardPanel initialQuery="PO-200" />);

        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(screen.getByText(/PO-200 - Out for delivery/i)).toBeTruthy();
        expect(screen.getByText(/fresh 5m ago/i)).toBeTruthy();
    });
});
