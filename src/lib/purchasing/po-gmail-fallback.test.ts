import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildPOEmailMime } from "./po-gmail-fallback";

const {
    getAuthenticatedClientMock,
    gmailSendMock,
    getProfileMock,
} = vi.hoisted(() => ({
    getAuthenticatedClientMock: vi.fn(),
    gmailSendMock: vi.fn(),
    getProfileMock: vi.fn(),
}));

vi.mock("../gmail/auth", () => ({
    getAuthenticatedClient: getAuthenticatedClientMock,
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: vi.fn(() => ({
        users: {
            messages: { send: gmailSendMock },
            getProfile: getProfileMock,
        },
    })),
}));

vi.mock("./po-pdf", () => ({
    renderPurchaseOrderPDF: vi.fn(async () => Buffer.from("%PDF-1.4 fake test pdf bytes")),
}));

import { sendPOViaGmail } from "./po-gmail-fallback";

const review = {
    orderId: "124832",
    vendorName: "Compost Tea Lab",
    vendorPartyId: "10999",
    orderDate: "2026-05-19",
    total: 412.5,
    items: [
        { productId: "CTL-1", productName: "Compost Tea Brewer", quantity: 5, unitPrice: 82.5, lineTotal: 412.5 },
    ],
    finaleUrl: "https://finale.example/po/124832",
    canCommit: false,
};

describe("buildPOEmailMime", () => {
    it("produces a base64url multipart/mixed payload with a PDF attachment", () => {
        const raw = buildPOEmailMime({
            from: "bill.selee@buildasoil.com",
            to: "info@composttealab.com",
            subject: "BuildASoil PO # 124832",
            body: "Please see attached PO.",
            pdf: Buffer.from("%PDF-1.4 test"),
            pdfFilename: "BuildASoil-PO-124832.pdf",
        });

        // Gmail accepts base64url — make sure we produced that, not standard base64
        expect(raw).not.toContain("+");
        expect(raw).not.toContain("/");
        expect(raw).not.toContain("=");

        const decoded = Buffer.from(raw, "base64url").toString("utf8");
        expect(decoded).toContain("From: bill.selee@buildasoil.com");
        expect(decoded).toContain("To: info@composttealab.com");
        expect(decoded).toContain("Subject: BuildASoil PO # 124832");
        expect(decoded).toContain('Content-Type: multipart/mixed; boundary="b_aria_po_');
        expect(decoded).toContain('Content-Type: application/pdf; name="BuildASoil-PO-124832.pdf"');
        expect(decoded).toContain("Content-Transfer-Encoding: base64");
        expect(decoded).toContain('Content-Disposition: attachment; filename="BuildASoil-PO-124832.pdf"');
        expect(decoded).toContain("Please see attached PO.");
    });
});

describe("sendPOViaGmail", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthenticatedClientMock.mockResolvedValue({});
        getProfileMock.mockResolvedValue({ data: { emailAddress: "bill.selee@buildasoil.com" } });
        gmailSendMock.mockResolvedValue({ data: { id: "gmail-msg-77", threadId: "gmail-thread-77" } });
    });

    it("sends the PO via Gmail with the rendered PDF attached", async () => {
        const result = await sendPOViaGmail({
            review,
            toEmail: "info@composttealab.com",
            subject: "BuildASoil PO #124832",
            body: "Hi, please see attached PO #124832.",
        });

        expect(result).toEqual({
            sent: true,
            pdfAttached: true,
            messageId: "gmail-msg-77",
            threadId: "gmail-thread-77",
            via: "gmail-fallback",
            fromAddress: "bill.selee@buildasoil.com",
        });

        expect(gmailSendMock).toHaveBeenCalledOnce();
        const sendArg = gmailSendMock.mock.calls[0][0];
        expect(sendArg.userId).toBe("me");
        const decoded = Buffer.from(sendArg.requestBody.raw, "base64url").toString("utf8");
        expect(decoded).toContain("To: info@composttealab.com");
        expect(decoded).toContain('Content-Type: application/pdf; name="BuildASoil-PO-124832.pdf"');
    });

    it("propagates the underlying error when Gmail rejects the send", async () => {
        gmailSendMock.mockRejectedValueOnce(new Error("invalid_grant"));
        await expect(sendPOViaGmail({
            review,
            toEmail: "info@composttealab.com",
            subject: "BuildASoil PO #124832",
            body: "Hi.",
        })).rejects.toThrow(/invalid_grant/);
    });

    it("throws when Gmail accepts but returns no message id", async () => {
        gmailSendMock.mockResolvedValueOnce({ data: {} });
        await expect(sendPOViaGmail({
            review,
            toEmail: "info@composttealab.com",
            subject: "x",
            body: "y",
        })).rejects.toThrow(/no message id/i);
    });
});
