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

// ── helpers shared with v2 ordering filter tests below ──────────────────────
function makeWatchItem(overrides: Partial<ReturnType<typeof makeFixtureItem>> = {}) {
    return {
        ...makeFixtureItem(),
        productId: "WATCH-1",
        productName: "Watchlist SKU",
        urgency: "watch",
        runwayDays: 75,
        adjustedRunwayDays: 75,
        finaleStockoutDays: 75,
        leadTimeDays: 14,
        moqWarning: false,
        reviewRequired: false,
        reviewReasons: [],
        ...overrides,
    };
}

function stubFetchWithMixedItems() {
    // Two items: one critical (Colorful) and one watch-tier (75d shortage). Critical
    // matches order_now, watch matches 90 only, neither matches 30 or 60.
    const watchItem = makeWatchItem({ supplierName: "WatchVendor", supplierPartyId: "20001" });
    const criticalPayload = {
        groups: [
            {
                vendorName: "Colorful Packaging Ltd",
                vendorPartyId: "10918",
                urgency: "critical",
                items: [makeFixtureItem()],
            },
            {
                vendorName: "WatchVendor",
                vendorPartyId: "20001",
                urgency: "watch",
                items: [watchItem],
            },
        ],
        cachedAt: "2026-05-05T12:00:00.000Z",
        vendorSummaries: [],
    };
    const emptyPayload = { groups: [], cachedAt: "2026-05-05T12:00:00.000Z", vendorSummaries: [] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        let body: any = emptyPayload;
        if (url.includes("/api/dashboard/purchasing") && url.includes("urgency=critical")) {
            body = criticalPayload;
        } else if (url.includes("/api/dashboard/active-purchases")) {
            body = { activePurchases: [], asOf: "2026-05-05T12:00:00.000Z" };
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
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

describe("PurchasingPanel - qty override dropdown", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders chevron when roundingAlternatives is non-empty", async () => {
        stubLocalStorage();

        const itemWithAlts = {
            ...makeFixtureItem(),
            roundingMethod: "historical" as const,
            roundingAlternatives: [600, 1000],
        };
        const payload = {
            groups: [
                {
                    vendorName: "Colorful Packaging Ltd",
                    vendorPartyId: "10918",
                    urgency: "critical",
                    items: [itemWithAlts],
                },
            ],
            cachedAt: "2026-05-05T12:00:00.000Z",
            vendorSummaries: [],
        };
        const empty = { groups: [], cachedAt: "2026-05-05T12:00:00.000Z", vendorSummaries: [] };
        vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
            const url = String(input);
            let body: any = empty;
            if (url.includes("/api/dashboard/purchasing") && url.includes("urgency=critical")) {
                body = payload;
            } else if (url.includes("/api/dashboard/active-purchases")) {
                body = { activePurchases: [], asOf: "2026-05-05T12:00:00.000Z" };
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        }));

        render(<PurchasingPanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        const vendorTab = await screen.findByText(/Colorful Packagi/i);
        fireEvent.click(vendorTab);

        await waitFor(() => {
            const chevron = document.querySelector('[title="Snap to a different clean number"]');
            expect(chevron).not.toBeNull();
        });
    });
});

describe("PurchasingPanel - v2 ordering filter (planning windows)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Helper: find toolbar filter button by its label substring. The toolbar
    // buttons are uniquely titled (the only buttons in the panel with these
    // tooltips), so title-based lookup is robust to the count+label split.
    function findFilterButton(titleSubstring: string): HTMLButtonElement | null {
        const buttons = Array.from(document.querySelectorAll("button"));
        return buttons.find(b => (b.title || "").toLowerCase().includes(titleSubstring.toLowerCase())) ?? null;
    }

    it("toolbar shows Order Now / 30 / 60 / 90 / All — and no TODAY/WEEK", async () => {
        stubLocalStorage();
        stubFetchWithMixedItems();

        render(<PurchasingPanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        // Each filter button is identified by its tooltip title.
        await waitFor(() => expect(findFilterButton("Items short within lead time")).not.toBeNull());
        expect(findFilterButton("within 30 days")).not.toBeNull();
        expect(findFilterButton("within 60 days")).not.toBeNull();
        expect(findFilterButton("within 90 days")).not.toBeNull();
        expect(findFilterButton("Every actionable item")).not.toBeNull();

        // Old TODAY/WEEK button text is gone (TODAY tooltip would have read differently).
        // Use case-sensitive query to avoid matching the new "ORDER NOW" header.
        const allBtns = Array.from(document.querySelectorAll("button"));
        expect(allBtns.some(b => b.textContent?.includes("TODAY"))).toBe(false);
        expect(allBtns.some(b => b.textContent?.includes("WEEK"))).toBe(false);
    });

    it("counts use item count, not vendor count, and 'All' totals every actionable item", async () => {
        stubLocalStorage();
        stubFetchWithMixedItems();

        render(<PurchasingPanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        // Two actionable items total → All count = 2
        await waitFor(() => {
            const allBtn = findFilterButton("Every actionable item");
            expect(allBtn?.textContent).toMatch(/2\s+ALL/);
        });
        // 90-day window includes both critical (12d) AND watch (75d)
        const ninetyBtn = findFilterButton("within 90 days");
        expect(ninetyBtn?.textContent).toMatch(/2\s+90/);
        // 30-day window includes ONLY critical (12d ≤ 30; watch's 75d > 30)
        const thirtyBtn = findFilterButton("within 30 days");
        expect(thirtyBtn?.textContent).toMatch(/1\s+30/);
    });

    it("migrates legacy localStorage 'today' to order_now (active = red tint)", async () => {
        stubLocalStorage();
        localStorage.setItem("aria-dash-purchasing-focus", "today");
        stubFetchWithMixedItems();

        render(<PurchasingPanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        await waitFor(() => {
            const orderNowBtn = findFilterButton("Items short within lead time");
            expect(orderNowBtn?.className).toMatch(/red-/);
        });
    });

    it("migrates legacy localStorage 'week' to 30 (active = amber tint)", async () => {
        stubLocalStorage();
        localStorage.setItem("aria-dash-purchasing-focus", "week");
        stubFetchWithMixedItems();

        render(<PurchasingPanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        await waitFor(() => {
            const thirtyBtn = findFilterButton("within 30 days");
            expect(thirtyBtn?.className).toMatch(/amber-/);
        });
    });
});

describe("PurchasingPanel - draft PO state", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps the green draft PO marker but removes drafted items from the needing list", async () => {
        stubLocalStorage();

        const payload = {
            groups: [
                {
                    vendorName: "Colorful Packaging Ltd",
                    vendorPartyId: "10918",
                    urgency: "critical",
                    items: [makeFixtureItem()],
                },
            ],
            cachedAt: "2026-05-05T12:00:00.000Z",
            vendorSummaries: [],
        };
        const empty = { groups: [], cachedAt: "2026-05-05T12:00:00.000Z", vendorSummaries: [] };
        vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes("/api/dashboard/purchasing") && init?.method === "POST") {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ orderId: "124790", finaleUrl: "https://finale.example/po/124790" }),
                });
            }
            let body: any = empty;
            if (url.includes("/api/dashboard/purchasing") && url.includes("urgency=critical")) {
                body = payload;
            } else if (url.includes("/api/dashboard/active-purchases")) {
                body = { activePurchases: [], asOf: "2026-05-05T12:00:00.000Z" };
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        }));

        render(<PurchasingPanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.click(await screen.findByText(/Colorful Packaging Ltd/i));
        await waitFor(() => expect(screen.getByText(/Colorful printed label/i)).toBeTruthy());
        fireEvent.click(screen.getByText(/Draft PO \(1\)/i));

        await waitFor(() => expect(screen.getAllByText(/PO #124790/i).length).toBeGreaterThan(0));
        expect(screen.queryByText(/Colorful printed label/i)).toBeNull();
    });
});
