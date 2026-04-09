// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import ActivePurchasesPanel from "./ActivePurchasesPanel";

function stubLocalStorage() {
    const store = new Map<string, string>([
        ["aria-dash-apch-h", "300"],
        ["aria-dash-apch-collapsed", "false"],
    ]);
    vi.stubGlobal("localStorage", {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
    });
}

function stubFetch(payload: any) {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(payload),
    } as Response)));
}

describe("ActivePurchasesPanel", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders lifecycle labels and only shows movement summaries when tracking evidence is trustworthy", async () => {
        stubLocalStorage();
        stubFetch({
            purchases: [
                {
                    orderId: "PO-SENT",
                    vendorName: "ULINE",
                    status: "Committed",
                    orderDate: "2026-04-01",
                    expectedDate: "2026-04-08",
                    receiveDate: null,
                    total: 100,
                    items: [],
                    finaleUrl: "https://example.com/po/sent",
                    leadProvenance: "7d vendor",
                    lifecycleStage: "sent",
                    lifecycleSummary: null,
                    trackingNumbers: [],
                    shipments: [],
                },
                {
                    orderId: "PO-NO-TRACK",
                    vendorName: "Berger",
                    status: "Committed",
                    orderDate: "2026-04-01",
                    expectedDate: "2026-04-08",
                    receiveDate: null,
                    total: 200,
                    items: [],
                    finaleUrl: "https://example.com/po/notrack",
                    leadProvenance: "7d vendor",
                    lifecycleStage: "tracking_unavailable",
                    lifecycleSummary: null,
                    trackingNumbers: [],
                    shipments: [],
                },
                {
                    orderId: "PO-MOVE",
                    vendorName: "Old Dominion",
                    status: "Committed",
                    orderDate: "2026-04-01",
                    expectedDate: "2026-04-08",
                    receiveDate: null,
                    total: 300,
                    items: [],
                    finaleUrl: "https://example.com/po/move",
                    leadProvenance: "7d vendor",
                    lifecycleStage: "moving_with_tracking",
                    lifecycleSummary: "Out for delivery",
                    trackingNumbers: ["Old Dominion:::1234567"],
                    shipments: [
                        {
                            tracking_number: "Old Dominion:::1234567",
                            public_tracking_url: "https://example.com/live/1234567",
                            status_display: "Out for delivery",
                            estimated_delivery_at: "2026-04-03T18:00:00.000Z",
                        },
                    ],
                },
                {
                    orderId: "PO-AP",
                    vendorName: "JABB",
                    status: "Completed",
                    orderDate: "2026-04-01",
                    expectedDate: "2026-04-05",
                    receiveDate: "2026-04-03",
                    total: 400,
                    items: [],
                    finaleUrl: "https://example.com/po/ap",
                    leadProvenance: "7d vendor",
                    lifecycleStage: "ap_follow_up",
                    lifecycleSummary: null,
                    trackingNumbers: [],
                    shipments: [],
                },
            ],
            cachedAt: "2026-04-03T12:00:00.000Z",
        });

        render(<ActivePurchasesPanel />);

        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(screen.getByText("Sent")).toBeTruthy();
        expect(screen.getByText("Tracking Unavailable")).toBeTruthy();
        expect(screen.getByText("Moving")).toBeTruthy();
        expect(screen.getByText("AP Follow-Up")).toBeTruthy();
        expect(screen.getByText("Out for delivery")).toBeTruthy();
        expect(screen.queryByText(/tracking unavailable/i)?.textContent).toMatch(/Tracking Unavailable/);
    });
});
