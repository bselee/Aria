import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
    purchaseOrders: [] as Array<Record<string, any>>,
    shipments: [] as Array<Record<string, any>>,
    completionSignals: new Map<string, any>(),
    getForVendorMock: vi.fn(),
    warmCacheMock: vi.fn(),
}));

vi.mock("../supabase", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table !== "purchase_orders") {
                throw new Error(`Unexpected table ${table}`);
            }

            return {
                select: () => ({
                    in: async (_column: string, values: string[]) => ({
                        data: mockState.purchaseOrders.filter((row) => values.includes(row.po_number)),
                        error: null,
                    }),
                }),
            };
        },
    })),
}));

vi.mock("../tracking/shipment-intelligence", () => ({
    listShipmentsForPurchaseOrders: vi.fn(async () => mockState.shipments),
}));

vi.mock("./po-completion-loader", () => ({
    loadPOCompletionSignalIndex: vi.fn(async () => new Map(mockState.completionSignals)),
}));

vi.mock("../builds/lead-time-service", () => ({
    leadTimeService: {
        warmCache: mockState.warmCacheMock,
        getForVendor: mockState.getForVendorMock,
    },
}));

import { loadActivePurchases } from "./active-purchases";

describe("loadActivePurchases", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockState.purchaseOrders = [];
        mockState.shipments = [];
        mockState.completionSignals = new Map<string, any>();
        mockState.warmCacheMock.mockResolvedValue(undefined);
        mockState.getForVendorMock.mockResolvedValue({ days: 7, label: "7d vendor" });
    });

    it("returns lifecycle fields from purchase_orders and avoids marking completed POs as received without a receive date", async () => {
        mockState.purchaseOrders = [
            {
                po_number: "PO-100",
                tracking_numbers: ["123456789012"],
                lifecycle_stage: "moving_with_tracking",
                tracking_status_summary: "Out for delivery",
                last_movement_summary: "Out for delivery",
            },
        ];
        mockState.shipments = [
            {
                tracking_number: "123456789012",
                po_numbers: ["PO-100"],
                status_category: "out_for_delivery",
                status_display: "Out for delivery",
                public_tracking_url: "https://example.com/live/123456789012",
                estimated_delivery_at: "2026-04-03T18:00:00.000Z",
            },
        ];

        const finale = {
            getRecentPurchaseOrders: vi.fn().mockResolvedValue([
                {
                    orderId: "PO-100",
                    vendorName: "ULINE",
                    status: "Completed",
                    orderDate: "2026-04-01",
                    receiveDate: null,
                    total: 1500,
                    items: [],
                    finaleUrl: "https://example.com/po/PO-100",
                },
            ]),
        } as any;

        const purchases = await loadActivePurchases(finale, 60);

        expect(purchases).toHaveLength(1);
        expect(purchases[0]).toMatchObject({
            orderId: "PO-100",
            isReceived: false,
            lifecycleStage: "moving_with_tracking",
            lifecycleSummary: "Out for delivery",
        });
    });
});
