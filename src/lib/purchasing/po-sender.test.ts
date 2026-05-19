import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    commitDraftPOMock,
    sendPurchaseOrderEmailMock,
    sendPOViaGmailMock,
    fromMock,
    updateBySourceMock,
    upsertFromSourceMock,
} = vi.hoisted(() => ({
    commitDraftPOMock: vi.fn(),
    sendPurchaseOrderEmailMock: vi.fn(),
    sendPOViaGmailMock: vi.fn(),
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

vi.mock("./po-gmail-fallback", () => ({
    sendPOViaGmail: sendPOViaGmailMock,
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

    it("returns partial success only when BOTH Finale native AND Gmail fallback fail", async () => {
        sendPurchaseOrderEmailMock.mockRejectedValue(new Error("native email action missing"));
        sendPOViaGmailMock.mockRejectedValue(new Error("Gmail token missing"));
        const sendId = await storePendingPOSend("124790", makeReview(), "orders@example.com", "test", {
            channel: "dashboard",
        });

        const result = await commitAndSendPO(sendId, "dashboard", false);

        expect(commitDraftPOMock).toHaveBeenCalledWith("124790");
        expect(sendPOViaGmailMock).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            orderId: "124790",
            emailSent: false,
            finaleEmailSent: false,
            emailVia: null,
            pdfAttached: false,
            emailSkipped: false,
        });
        expect(result.emailError).toMatch(/native email action missing/);
        expect(result.emailError).toMatch(/Gmail token missing/);
    });

    it("falls back to Gmail when Finale native email action is unavailable", async () => {
        sendPurchaseOrderEmailMock.mockRejectedValue(new Error("Finale native PO email action was not available"));
        sendPOViaGmailMock.mockResolvedValue({
            sent: true,
            pdfAttached: true,
            messageId: "gmail-msg-77",
            threadId: "gmail-thread-77",
            via: "gmail-fallback",
            fromAddress: "bill.selee@buildasoil.com",
        });
        const sendId = await storePendingPOSend("124790", makeReview(), "orders@example.com", "test", {
            channel: "dashboard",
        });

        const result = await commitAndSendPO(sendId, "dashboard", false);

        expect(sendPurchaseOrderEmailMock).toHaveBeenCalledOnce();
        expect(sendPOViaGmailMock).toHaveBeenCalledWith(expect.objectContaining({
            toEmail: "orders@example.com",
            review: expect.objectContaining({ orderId: "124790" }),
        }));
        expect(result).toMatchObject({
            orderId: "124790",
            emailSent: true,
            finaleEmailSent: false,
            emailVia: "gmail-fallback",
            pdfAttached: true,
            sentTo: "orders@example.com",
            gmailMessageId: "gmail-msg-77",
            emailSkipped: false,
        });
        expect(result.emailError).toBeUndefined();
        // The fallback path appends a "sent via Gmail" note to verification issues
        // so the dashboard's commitIssues panel surfaces that the path differed.
        expect(result.verification.issues).toEqual(
            expect.arrayContaining([expect.stringMatching(/Finale native email unavailable.*Gmail fallback/i)]),
        );
        expect(result.verification.emailSent).toBe(true);
        expect(result.verification.emailVerified).toBe(true);
    });
});
