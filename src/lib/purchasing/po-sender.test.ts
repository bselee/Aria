import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    commitDraftPOMock,
    sendPurchaseOrderEmailMock,
    fromMock,
    updateBySourceMock,
    upsertFromSourceMock,
} = vi.hoisted(() => ({
    commitDraftPOMock: vi.fn(),
    sendPurchaseOrderEmailMock: vi.fn(),
    fromMock: vi.fn(),
    updateBySourceMock: vi.fn(),
    upsertFromSourceMock: vi.fn(),
}));

vi.mock("../finale/client", () => ({
    FinaleClient: vi.fn().mockImplementation(function () {
        return {
        commitDraftPO: commitDraftPOMock,
        sendPurchaseOrderEmail: sendPurchaseOrderEmailMock,
        };
    }),
}));

vi.mock("../supabase", () => ({
    createClient: vi.fn(() => ({
        from: fromMock,
    })),
}));

vi.mock("../intelligence/agent-task", () => ({
    updateBySource: updateBySourceMock,
    upsertFromSource: upsertFromSourceMock,
}));

import {
    clearPendingPOSendCache,
    commitAndSendPO,
    storePendingPOSend,
} from "./po-sender";

function makeTableMock() {
    return {
        select: vi.fn().mockReturnThis(),
        upsert: vi.fn().mockResolvedValue({ error: null }),
        insert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    };
}

function makeReview() {
    return {
        orderId: "124790",
        vendorName: "Colorful Packaging Ltd",
        vendorPartyId: "10918",
        orderDate: "2026-05-06",
        total: 250,
        items: [
            { productId: "BAG-1", productName: "Bag", quantity: 10, unitPrice: 25, lineTotal: 250 },
        ],
        finaleUrl: "https://finale.example/po/124790",
        canCommit: true,
    };
}

describe("commitAndSendPO", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearPendingPOSendCache();
        commitDraftPOMock.mockResolvedValue({ orderId: "124790", committed: true, finalStatus: "ORDER_LOCKED" });
        sendPurchaseOrderEmailMock.mockResolvedValue({
            orderId: "124790",
            sent: true,
            pdfAttached: true,
            actionUrl: "/email",
        });
        updateBySourceMock.mockResolvedValue(undefined);
        upsertFromSourceMock.mockResolvedValue(null);
        fromMock.mockImplementation(() => makeTableMock());
    });

    it("returns partial success when Finale commits but native vendor email fails", async () => {
        sendPurchaseOrderEmailMock.mockRejectedValue(new Error("native email action missing"));
        const sendId = await storePendingPOSend("124790", makeReview(), "orders@example.com", "test", {
            channel: "dashboard",
        });

        const result = await commitAndSendPO(sendId, "dashboard", false);

        expect(commitDraftPOMock).toHaveBeenCalledWith("124790");
        expect(result).toMatchObject({
            orderId: "124790",
            finaleEmailSent: false,
            pdfAttached: false,
            emailSkipped: false,
            emailError: "native email action missing",
        });
    });
});
