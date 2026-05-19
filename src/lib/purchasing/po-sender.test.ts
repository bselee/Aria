import { beforeEach, describe, expect, it, vi } from "vitest";

// commitAndSendPO contains a real 8s setTimeout for post-send Finale verification.
vi.setConfig({ testTimeout: 15000 });

const {
    commitDraftPOMock,
    sendPurchaseOrderEmailMock,
    getOrderDetailsMock,
    fromMock,
    updateBySourceMock,
    upsertFromSourceMock,
} = vi.hoisted(() => ({
    commitDraftPOMock: vi.fn(),
    sendPurchaseOrderEmailMock: vi.fn(),
    getOrderDetailsMock: vi.fn(),
    fromMock: vi.fn(),
    updateBySourceMock: vi.fn(),
    upsertFromSourceMock: vi.fn(),
}));

vi.mock("../finale/client", () => ({
    FinaleClient: vi.fn().mockImplementation(function () {
        return {
            commitDraftPO: commitDraftPOMock,
            sendPurchaseOrderEmail: sendPurchaseOrderEmailMock,
            getOrderDetails: getOrderDetailsMock,
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
        getOrderDetailsMock.mockResolvedValue({ statusId: "ORDER_LOCKED", lastEmailedAt: new Date().toISOString() });
        updateBySourceMock.mockResolvedValue(undefined);
        upsertFromSourceMock.mockResolvedValue(null);
        fromMock.mockImplementation(() => makeTableMock());
    });

    // Will's rule (2026-05-19): "no funky format" — if Finale-native fails the
    // PO stays committed-but-unsent, the session is parked for retry, and Aria
    // does NOT fall back to a self-rendered PDF over Gmail. Better a clear
    // surfaced failure than the vendor receiving a worse-quality PO.
    it("parks the session for retry when Finale-native email fails — never falls back to Gmail with a homemade PDF", async () => {
        sendPurchaseOrderEmailMock.mockRejectedValue(new Error("Finale native PO email action was not available"));
        const sendId = await storePendingPOSend("124790", makeReview(), "orders@example.com", "test", {
            channel: "dashboard",
        });

        const result = await commitAndSendPO(sendId, "dashboard", false);

        expect(commitDraftPOMock).toHaveBeenCalledWith("124790");
        expect(sendPurchaseOrderEmailMock).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            orderId: "124790",
            emailSent: false,
            finaleEmailSent: false,
            emailVia: null,
            pdfAttached: false,
            emailSkipped: false,
            retryable: true,
        });
        expect(result.emailError).toMatch(/Finale native PO email action was not available/);
        // The verification issue list spells out what Will should do
        expect(result.verification.issues).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/Finale native email unavailable.*send manually from there/i),
            ]),
        );
    });

    it("returns success when Finale native send works", async () => {
        const sendId = await storePendingPOSend("124790", makeReview(), "orders@example.com", "test", {
            channel: "dashboard",
        });

        const result = await commitAndSendPO(sendId, "dashboard", false);

        expect(result).toMatchObject({
            orderId: "124790",
            emailSent: true,
            finaleEmailSent: true,
            emailVia: "finale-native",
            pdfAttached: true,
            sentTo: "orders@example.com",
            emailSkipped: false,
            retryable: false,
        });
        expect(result.emailError).toBeUndefined();
    });

    it("refuses an empty PO outright", async () => {
        const sendId = await storePendingPOSend(
            "124791",
            { ...makeReview(), orderId: "124791", items: [] },
            "orders@example.com",
            "test",
            { channel: "dashboard" },
        );

        await expect(commitAndSendPO(sendId, "dashboard", false))
            .rejects.toThrow(/no line items/i);
        expect(commitDraftPOMock).not.toHaveBeenCalled();
    });
});
