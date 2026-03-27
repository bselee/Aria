import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPendingPOSendMock, executePOSendActionMock } = vi.hoisted(() => ({
    getPendingPOSendMock: vi.fn(),
    executePOSendActionMock: vi.fn(),
}));

vi.mock("../../purchasing/po-sender", () => ({
    getPendingPOSend: getPendingPOSendMock,
}));

vi.mock("../actions", () => ({
    executePOSendAction: executePOSendActionMock,
}));

import { handleTelegramPOSendCallback } from "./telegram-callbacks";

describe("handleTelegramPOSendCallback", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("handles warm callback success", async () => {
        getPendingPOSendMock.mockResolvedValue({
            review: { finaleUrl: "https://finale.example/po/PO-1" },
        });
        executePOSendActionMock.mockResolvedValue({
            status: "success",
            userMessage: "PO #PO-1 committed in Finale and emailed.",
            logMessage: "success",
            retryAllowed: false,
            safeToRetry: false,
            details: { orderId: "PO-1", sentTo: "vendor@example.com" },
        });

        const result = await handleTelegramPOSendCallback({ sendId: "posend_1" });

        expect(result.action.status).toBe("success");
        expect(result.pending).toBeTruthy();
    });

    it("returns a clean recovery message for stale Telegram callbacks after restart", async () => {
        getPendingPOSendMock.mockResolvedValue(undefined);

        const result = await handleTelegramPOSendCallback({ sendId: "po_confirm_send_dead" });

        expect(result.action.userMessage).toMatch(/expired|re-initiate|review/i);
        expect(result.action.status).toBe("failed");
    });

    it("preserves partial success from the shared send action", async () => {
        getPendingPOSendMock.mockResolvedValue({
            review: { finaleUrl: "https://finale.example/po/PO-2" },
        });
        executePOSendActionMock.mockResolvedValue({
            status: "partial_success",
            userMessage: "PO #PO-2 committed in Finale, but vendor email failed.",
            logMessage: "partial",
            retryAllowed: false,
            safeToRetry: false,
            details: { orderId: "PO-2", emailError: "SMTP offline" },
        });

        const result = await handleTelegramPOSendCallback({ sendId: "posend_2" });

        expect(result.action.status).toBe("partial_success");
        expect(result.action.userMessage).toMatch(/email failed/i);
    });

    it("surfaces action failures without stack traces", async () => {
        getPendingPOSendMock.mockResolvedValue({
            review: { finaleUrl: "https://finale.example/po/PO-3" },
        });
        executePOSendActionMock.mockResolvedValue({
            status: "failed",
            userMessage: "Failed to commit/send PO: vendor email missing",
            logMessage: "failed",
            retryAllowed: true,
            safeToRetry: false,
        });

        const result = await handleTelegramPOSendCallback({ sendId: "posend_3" });

        expect(result.action.userMessage).toMatch(/failed to commit\/send po/i);
    });
});
