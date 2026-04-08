import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    finaleCtorMock,
    loadActivePurchasesMock,
    syncPurchasingCalendarMock,
    opsManagerCtorMock,
} = vi.hoisted(() => ({
    finaleCtorMock: vi.fn(),
    loadActivePurchasesMock: vi.fn(),
    syncPurchasingCalendarMock: vi.fn(),
    opsManagerCtorMock: vi.fn(),
}));

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: finaleCtorMock,
}));

vi.mock("@/lib/purchasing/active-purchases", () => ({
    loadActivePurchases: loadActivePurchasesMock,
}));

vi.mock("@/lib/intelligence/ops-manager", () => ({
    OpsManager: opsManagerCtorMock,
}));

import { GET, POST } from "./route";

describe("dashboard active purchases route", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        finaleCtorMock.mockImplementation(function MockFinaleClient(this: any) {
            this.marker = "finale";
        });

        loadActivePurchasesMock.mockResolvedValue([
            {
                orderId: "PO-100",
                vendorName: "Vendor A",
                status: "committed",
                orderDate: "2026-04-01",
                sentAt: "2026-04-02T10:30:00Z",
                expectedDate: "2026-04-10",
                receiveDate: null,
                total: 100,
                items: [{ productId: "SKU1", quantity: 5 }],
                finaleUrl: "https://finale.example/po/PO-100",
                leadProvenance: "8d median",
                trackingNumbers: [],
                shipments: [],
                isReceived: false,
                completionState: "open",
            },
        ]);

        syncPurchasingCalendarMock.mockResolvedValue({
            created: 3,
            updated: 5,
            skipped: 7,
            cleared: 1,
        });

        opsManagerCtorMock.mockImplementation(function MockOpsManager(this: any) {
            this.syncPurchasingCalendar = syncPurchasingCalendarMock;
        });
    });

    it("returns active purchases including the resolved vendor send timestamp", async () => {
        const response = await GET({} as any);
        expect(response.status).toBe(200);

        const body = await response.json();
        expect(loadActivePurchasesMock).toHaveBeenCalledTimes(1);
        expect(body.purchases[0]).toMatchObject({
            orderId: "PO-100",
            sentAt: "2026-04-02T10:30:00Z",
        });
    });

    it("runs a manual purchasing calendar resync on demand", async () => {
        const response = await POST({
            json: async () => ({
                action: "resync_calendar",
                daysBack: 45,
            }),
        } as any);

        expect(response.status).toBe(200);
        expect(syncPurchasingCalendarMock).toHaveBeenCalledWith(45);

        const body = await response.json();
        expect(body).toMatchObject({
            ok: true,
            daysBack: 45,
            result: {
                updated: 5,
            },
        });
    });

    it("rejects unsupported manual actions", async () => {
        const response = await POST({
            json: async () => ({
                action: "nope",
            }),
        } as any);

        expect(response.status).toBe(400);
    });
});
