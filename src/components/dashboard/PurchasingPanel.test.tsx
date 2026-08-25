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
        commitGuard: {
            productId: "CP-LABEL-1",
            decision: "draft_only",
            targetCoverDays: 75,
            minimumPostLeadCoverageDays: 30,
            recommendedQty: 200,
            dailyRate: 1,
            leadTimeDays: 45,
            projectedCoverageDays: 244,
            projectedPostReceiptCoverageDays: 199,
            blockReasons: ["recommendation_requires_review", "moq_warn_only"],
            summary: "Draft only: recommendation_requires_review, moq_warn_only",
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
        if (url.includes("/api/dashboard/purchasing") && (url.includes("urgency=critical") || url.includes("mode=all"))) {
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
        if (url.includes("/api/dashboard/purchasing") && (url.includes("urgency=critical") || url.includes("mode=all"))) {
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

    it("expands a vendor that includes watch items without crashing", async () => {
        stubLocalStorage();

        const payload = {
            groups: [
                {
                    vendorName: "Colorful Packaging Ltd",
                    vendorPartyId: "10918",
                    urgency: "critical",
                    items: [
                        makeFixtureItem(),
                        makeWatchItem({
                            productId: "CP-LABEL-WATCH",
                            productName: "Colorful replenishment watch SKU",
                            supplierName: "Colorful Packaging Ltd",
                            supplierPartyId: "10918",
                        }),
                    ],
                },
            ],
            cachedAt: "2026-05-05T12:00:00.000Z",
            vendorSummaries: [],
        };
        const emptyPayload = { groups: [], cachedAt: "2026-05-05T12:00:00.000Z", vendorSummaries: [] };
        vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
            const url = String(input);
            let body: any = emptyPayload;
            if (url.includes("/api/dashboard/purchasing") && (url.includes("urgency=critical") || url.includes("mode=all"))) {
                body = payload;
            } else if (url.includes("/api/dashboard/active-purchases")) {
                body = { activePurchases: [], asOf: "2026-05-05T12:00:00.000Z" };
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        }));

        render(<PurchasingPanel />);
                await waitFor(() => expect(fetch).toHaveBeenCalled());

                // Default window is TODAY (order_now) — watch SKUs live under ALL.
                                const allChip = await screen.findByTitle("Every actionable item");
                                fireEvent.click(allChip);

                // NOTE(2026-07-28): commit 5f1de32 replaced the vendor tab strip with
                // a searchable combobox dropdown. Clicking the vendor name no longer
                // expands items — must click the ▾ button instead.
                fireEvent.click(await screen.findByText("▾"));

                await waitFor(() => expect(screen.getByText(/Colorful replenishment watch SKU/i)).toBeTruthy());
            });

    it("keeps Ordering lean: no cover/MOQ/Review badges", async () => {
            stubLocalStorage();
            stubFetch();

            render(<PurchasingPanel />);

            await waitFor(() => expect(fetch).toHaveBeenCalled());
            await waitFor(() => expect(screen.getByText(/Colorful Packaging/i)).toBeTruthy());
            expect(screen.queryByText("180d cover")).toBeNull();
            expect(screen.queryByText("MOQ warn")).toBeNull();
            expect(screen.queryByText("Draft only")).toBeNull();
        });

        // NOTE(2026-07-28): vendorCycleBadge is still computed (PurchasingPanel.tsx:2120)
        // and passed into the item flyout payload, but is no longer rendered on the
        // vendor card header after the simplified-row refactor. Assert the group
        // still loads under a routine_locked cycle instead of a header badge.
        it("renders vendor group when vendor cycle is routine_locked", async () => {
            stubLocalStorage();
            const payload = {
                groups: [
                    {
                        vendorName: "Colorful Packaging Ltd",
                        vendorPartyId: "10918",
                        urgency: "warning",
                        vendorCycle: {
                            decision: "routine_locked",
                            cycleDays: 30,
                            lockedUntil: "2026-06-18",
                            blockingPO: {
                                orderId: "124832",
                                vendorName: "Colorful Packaging Ltd",
                                vendorPartyId: "10918",
                                status: "Committed",
                                orderDate: "2026-05-19",
                                receiveDate: null,
                                skus: ["CP-LABEL-OLD"],
                            },
                            ignoredPOs: [],
                            exceptionEvidence: [],
                            summary: "Routine cycle locked by PO 124832 until 2026-06-18.",
                        },
                        items: [makeFixtureItem()],
                    },
                ],
                cachedAt: "2026-05-05T12:00:00.000Z",
                vendorSummaries: [],
            };
            const emptyPayload = { groups: [], cachedAt: "2026-05-05T12:00:00.000Z", vendorSummaries: [] };
            vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
                const url = String(input);
                let body: any = emptyPayload;
                if (url.includes("/api/dashboard/purchasing") && (url.includes("urgency=critical") || url.includes("mode=all"))) {
                    body = payload;
                } else if (url.includes("/api/dashboard/active-purchases")) {
                    body = { activePurchases: [], asOf: "2026-05-05T12:00:00.000Z" };
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
            }));

            render(<PurchasingPanel />);

            expect(await screen.findByText(/Colorful Packaging Ltd/i)).toBeTruthy();
            fireEvent.click(await screen.findByText("▾"));
            await waitFor(() => expect(screen.getByText(/Colorful printed label/i)).toBeTruthy());
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
            if (url.includes("/api/dashboard/purchasing") && (url.includes("urgency=critical") || url.includes("mode=all"))) {
                body = payload;
            } else if (url.includes("/api/dashboard/active-purchases")) {
                body = { activePurchases: [], asOf: "2026-05-05T12:00:00.000Z" };
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        }));

        render(<PurchasingPanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        // Vendor groups render collapsed by default — click ▾ to expand items.
        // NOTE(2026-07-28): commit 5f1de32 replaced tab strip with dropdown;
        // vendor name no longer toggles expansion.
        fireEvent.click(await screen.findByText("▾"));

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

        // v2 (2026-05-06): the 'today' / 'week' focus KEYS are gone, but the
        // button labels can still use human-friendly text like "TODAY" for the
        // order_now filter. Assert that the legacy 'WEEK' label is removed.
        const allBtns = Array.from(document.querySelectorAll("button"));
        expect(allBtns.some(b => b.textContent?.includes("WEEK"))).toBe(false);
    });

    it("counts use item count, not vendor count, and 'All' totals every actionable item", async () => {
        stubLocalStorage();
        stubFetchWithMixedItems();

        render(<PurchasingPanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        // Two actionable items total → All count = 2
        // NOTE(2026-07-24): label/count order flipped from "{count} {LABEL}" to
        // "{LABEL} {count}" when this row migrated onto the shared <FilterChip>
        // primitive (audit backlog item 12) — FilterChip always renders label
        // first, count second, matching ActionChip's "ORDER ALL (2)" convention.
        // Assertions below match content regardless of exact order via a
        // non-order-sensitive regex, so future chip layout tweaks don't retrigger
        // this test unnecessarily.
        await waitFor(() => {
            const allBtn = findFilterButton("Every actionable item");
            expect(allBtn?.textContent).toMatch(/ALL/);
            expect(allBtn?.textContent).toMatch(/2/);
        });
        // 90-day window includes both critical (12d) AND watch (75d)
        const ninetyBtn = findFilterButton("within 90 days");
        expect(ninetyBtn?.textContent).toMatch(/90/);
        expect(ninetyBtn?.textContent).toMatch(/2/);
        // 30-day window includes ONLY critical (12d ≤ 30; watch's 75d > 30)
        const thirtyBtn = findFilterButton("within 30 days");
        expect(thirtyBtn?.textContent).toMatch(/30/);
        expect(thirtyBtn?.textContent).toMatch(/1/);
    });

    it("shows same-vendor 30-day add-ons when Order Now triggers that vendor", async () => {
        stubLocalStorage();
        localStorage.setItem("aria-dash-purchasing-focus", "order_now");

        const immediate = makeWatchItem({
            productId: "BLM212",
            productName: "Blumat Digital Moisture Meter",
            supplierName: "Sustainable Village",
            supplierPartyId: "10809",
            runwayDays: 13,
            adjustedRunwayDays: 13,
            finaleStockoutDays: 13,
            leadTimeDays: 14,
            urgency: "critical",
        });
        const addOn = makeWatchItem({
            productId: "BLM219",
            productName: "Blumat 9 inch Pre-set Carrot",
            supplierName: "Sustainable Village",
            supplierPartyId: "10809",
            urgency: "warning",
            runwayDays: 24,
            adjustedRunwayDays: 24,
            finaleStockoutDays: null,
            leadTimeDays: 14,
            suggestedQty: 100,
        });
        const payload = {
            groups: [
                {
                    vendorName: "Sustainable Village",
                    vendorPartyId: "10809",
                    urgency: "critical",
                    items: [immediate, addOn],
                },
            ],
            cachedAt: "2026-05-05T12:00:00.000Z",
            vendorSummaries: [],
        };
        const emptyPayload = { groups: [], cachedAt: "2026-05-05T12:00:00.000Z", vendorSummaries: [] };
        vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
            const url = String(input);
            let body: any = emptyPayload;
            if (url.includes("/api/dashboard/purchasing") && (url.includes("urgency=critical") || url.includes("mode=all"))) {
                body = payload;
            } else if (url.includes("/api/dashboard/active-purchases")) {
                body = { activePurchases: [], asOf: "2026-05-05T12:00:00.000Z" };
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        }));

        render(<PurchasingPanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.click(await screen.findByText("▾")); // 5f1de32: expand via ▾, not vendor name

        expect(await screen.findByText(/Blumat Digital Moisture Meter/i)).toBeTruthy();
        expect(await screen.findByText(/Blumat 9 inch Pre-set Carrot/i)).toBeTruthy();
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
            if (url.includes("/api/dashboard/purchasing/commit")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        sendId: "send-123",
                        review: {
                            orderId: "124790",
                            vendorName: "Colorful Packaging Ltd",
                            vendorPartyId: "10918",
                            total: 2800,
                            orderDate: "2026-05-05",
                            items: [
                                { productId: "CP-LABEL-1", productName: "Colorful printed label", quantity: 200, unitPrice: 14, lineTotal: 2800 }
                            ],
                            finaleUrl: "https://finale.example/po/124790"
                        },
                        email: "vendor@colorful.com",
                        emailSource: "vendor policy override",
                        warning: ""
                    }),
                });
            }
            if (url.includes("/api/dashboard/purchasing") && init?.method === "POST") {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ orderId: "124790", finaleUrl: "https://finale.example/po/124790" }),
                });
            }
            let body: any = empty;
            if (url.includes("/api/dashboard/purchasing") && (url.includes("urgency=critical") || url.includes("mode=all"))) {
                body = payload;
            } else if (url.includes("/api/dashboard/active-purchases")) {
                body = { activePurchases: [], asOf: "2026-05-05T12:00:00.000Z" };
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        }));

        render(<PurchasingPanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        // Expand so the Order button is draft-only (inspected path).
                // NOTE(2026-07-28): button label is "Order" (was "Draft PO (N)");
                // commit modal / Keep Draft is no longer auto-opened after create
                // (Bill rule 2026-06-23: one click → one draft).
                // HERMIA(2026-08-06): vendor leaves Ordering immediately on draft —
                // no 2s PO# flash (Bill: once PO is generated it must disappear).
                fireEvent.click(await screen.findByText("▾"));
                await waitFor(() => expect(screen.getByText(/Colorful printed label/i)).toBeTruthy());
                fireEvent.click(screen.getByText(/^Order$/i));

                await waitFor(
                    () => expect(screen.queryByText(/Colorful printed label/i)).toBeNull(),
                    { timeout: 3000 },
                );
            });
        });
