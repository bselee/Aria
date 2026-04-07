import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    finaleCtorMock,
    storePendingPOSendMock,
    getPendingPOSendMock,
    lookupVendorOrderEmailMock,
    executePOSendActionMock,
} = vi.hoisted(() => ({
    finaleCtorMock: vi.fn(),
    storePendingPOSendMock: vi.fn(),
    getPendingPOSendMock: vi.fn(),
    lookupVendorOrderEmailMock: vi.fn(),
    executePOSendActionMock: vi.fn(),
}));

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: finaleCtorMock,
}));

vi.mock("@/lib/purchasing/po-sender", () => ({
    storePendingPOSend: storePendingPOSendMock,
    getPendingPOSend: getPendingPOSendMock,
    lookupVendorOrderEmail: lookupVendorOrderEmailMock,
}));

vi.mock("@/lib/copilot/actions", () => ({
    executePOSendAction: executePOSendActionMock,
}));

import { POST } from "./route";

describe("dashboard purchasing commit route", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        finaleCtorMock.mockImplementation(function MockFinaleClient(this: any) {
            this.getDraftPOForReview = vi.fn().mockResolvedValue({
                orderId: "PO-1001",
                vendorName: "ULINE",
                vendorPartyId: "party-1",
                canCommit: true,
            });
        });

        getPendingPOSendMock.mockResolvedValue({
            orderId: "PO-1001",
            review: { finaleUrl: "https://finale.example/po/PO-1001" },
            vendorEmail: "vendor@example.com",
        });

        lookupVendorOrderEmailMock.mockResolvedValue({
            email: "vendor@example.com",
            source: "vendor_profiles",
        });

        storePendingPOSendMock.mockResolvedValue("send-1");
        executePOSendActionMock.mockResolvedValue({
            status: "success",
            userMessage: "ok",
        });
    });

    it("passes the dashboard trigger when sending a reviewed PO", async () => {
        const response = await POST({
            json: async () => ({
                action: "send",
                sendId: "send-1",
            }),
        } as any);

        expect(response.status).toBe(200);
        expect(executePOSendActionMock).toHaveBeenCalledWith({
            sendId: "send-1",
            triggeredBy: "dashboard",
            skipEmail: false,
        });
    });
});
