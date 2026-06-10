import { beforeEach, describe, expect, it, vi } from "vitest";

// commitAndSendPO verification is now 1 quick round-trip (was 3 × 5s polling).
vi.setConfig({ testTimeout: 10000 });

const {
    commitDraftPOMock,
    sendPurchaseOrderEmailMock,
    getOrderDetailsMock,
    renderPurchaseOrderPdfMock,
    sendGmailPdfEmailMock,
    fromMock,
    updateBySourceMock,
    upsertFromSourceMock,
} = vi.hoisted(() => ({
    commitDraftPOMock: vi.fn(),
    sendPurchaseOrderEmailMock: vi.fn(),
    getOrderDetailsMock: vi.fn(),
    renderPurchaseOrderPdfMock: vi.fn(),
    sendGmailPdfEmailMock: vi.fn(),
    fromMock: vi.fn(),
    updateBySourceMock: vi.fn(),
    upsertFromSourceMock: vi.fn(),
}));

const dbWrites: Array<{ table: string; op: "insert" | "upsert"; payload: any }> = [];

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

vi.mock("./po-email-pdf", () => ({
    renderPurchaseOrderPdf: renderPurchaseOrderPdfMock,
}));

vi.mock("../gmail/send-email", () => ({
    sendGmailPdfEmail: sendGmailPdfEmailMock,
}));

import {
    clearPendingPOSendCache,
    commitAndSendPO,
    storePendingPOSend,
} from "./po-sender";

function makeTableMock(table: string) {
    return {
        select: vi.fn().mockReturnThis(),
        upsert: vi.fn((payload: any) => {
            dbWrites.push({ table, op: "upsert", payload });
            return Promise.resolve({ error: null });
        }),
        insert: vi.fn((payload: any) => {
            dbWrites.push({ table, op: "insert", payload });
            return Promise.resolve({ error: null });
        }),
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
        dbWrites.length = 0;
        clearPendingPOSendCache();
        commitDraftPOMock.mockResolvedValue({ orderId: "124790", committed: true, finalStatus: "ORDER_LOCKED" });
        sendPurchaseOrderEmailMock.mockResolvedValue({
            orderId: "124790",
            sent: true,
            pdfAttached: true,
            actionUrl: "/email",
        });
        getOrderDetailsMock.mockResolvedValue({ statusId: "ORDER_LOCKED", lastEmailedAt: new Date().toISOString() });
        renderPurchaseOrderPdfMock.mockResolvedValue(Buffer.from("%PDF-1.4 test"));
        sendGmailPdfEmailMock.mockResolvedValue({
            messageId: "gmail-po-1",
            threadId: "thread-1",
            fromAddress: "bill.selee@buildasoil.com",
        });
        updateBySourceMock.mockResolvedValue(undefined);
        upsertFromSourceMock.mockResolvedValue(null);
        fromMock.mockImplementation((table: string) => makeTableMock(table));
    });

    it("falls back to Gmail PDF when Finale-native email fails", async () => {
        sendPurchaseOrderEmailMock.mockRejectedValue(new Error("Finale native PO email action was not available"));
        const sendId = await storePendingPOSend("124790", makeReview(), "orders@example.com", "test", {
            channel: "dashboard",
        });

        const result = await commitAndSendPO(sendId, "dashboard", false);

        expect(commitDraftPOMock).toHaveBeenCalledWith("124790");
        expect(sendPurchaseOrderEmailMock).toHaveBeenCalledOnce();
        expect(renderPurchaseOrderPdfMock).toHaveBeenCalledWith(makeReview());
        expect(sendGmailPdfEmailMock).toHaveBeenCalledWith(expect.objectContaining({
            to: "orders@example.com",
            subject: "BuildASoil PO # 124790 - Colorful Packaging Ltd - 5/6/2026",
            pdfFilename: "BuildASoil-PO-124790.pdf",
        }));
        expect(result).toMatchObject({
            orderId: "124790",
            sentTo: "orders@example.com",
            gmailMessageId: "gmail-po-1",
            emailSent: true,
            finaleEmailSent: false,
            emailVia: "gmail-fallback",
            pdfAttached: true,
            emailSkipped: false,
            retryable: false,
        });
        expect(result.emailError).toBeUndefined();
        expect(result.verification.issues).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/Finale native email unavailable/i),
                expect.stringMatching(/Gmail fallback sent/i),
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

    it("writes verified sent evidence to purchase_orders when email send succeeds", async () => {
        const sendId = await storePendingPOSend("124790", makeReview(), "orders@example.com", "test", {
            channel: "dashboard",
        });

        await commitAndSendPO(sendId, "dashboard", false);

        const poUpsert = dbWrites.find((write) =>
            write.table === "purchase_orders" &&
            write.op === "upsert" &&
            write.payload.po_number === "124790" &&
            write.payload.lifecycle_stage === "sent"
        );

        expect(poUpsert?.payload).toMatchObject({
            po_number: "124790",
            po_sent_at: expect.any(String),
            po_sent_verified_at: expect.any(String),
            po_sent_verified_source: "finale-native",
            lifecycle_stage: "sent",
        });
        expect(poUpsert?.payload.po_sent_verified_evidence).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "po_send",
                    detail: expect.stringContaining("finale-native"),
                }),
            ]),
        );
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
