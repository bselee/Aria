import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    listTrackedSlackRequestsMock,
    completeTrackedSlackRequestManuallyMock,
    addSlackReactionMock,
} = vi.hoisted(() => ({
    listTrackedSlackRequestsMock: vi.fn(),
    completeTrackedSlackRequestManuallyMock: vi.fn(),
    addSlackReactionMock: vi.fn(),
}));

vi.mock("../../lib/slack/request-tracker", () => ({
    listTrackedSlackRequests: listTrackedSlackRequestsMock,
    completeTrackedSlackRequestManually: completeTrackedSlackRequestManuallyMock,
    addSlackReaction: addSlackReactionMock,
}));

import { operationsCommands } from "./operations";

function makeCtx(text: string) {
    return {
        message: { text },
        sendChatAction: vi.fn(),
        reply: vi.fn(),
    } as any;
}

describe("operationsCommands", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("renders durable tracked requests instead of the in-memory watchdog buffer", async () => {
        listTrackedSlackRequestsMock.mockResolvedValue({
            open: [
                {
                    id: "req-1",
                    requester_name: "Krystal",
                    channel_name: "purchase-orders",
                    original_text: "Need BB106 @Bill",
                    matched_skus: ["BB106"],
                    completion_po_numbers: null,
                },
            ],
            recentCompletedAuto: [
                {
                    id: "req-2",
                    requester_name: "Parker",
                    channel_name: "purchase-orders",
                    original_text: "Need ALK101 @Bill",
                    matched_skus: ["ALK101"],
                    completion_po_numbers: ["PO-44"],
                },
            ],
            recentCompletedManual: [],
        });

        const ctx = makeCtx("/requests");
        const command = operationsCommands.find((cmd) => cmd.name === "requests");

        expect(command).toBeTruthy();
        await command!.handler(ctx, {} as any);

        expect(listTrackedSlackRequestsMock).toHaveBeenCalledOnce();
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining("Open Requests"),
            expect.objectContaining({ parse_mode: "Markdown" }),
        );
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining("PO-44"),
            expect.objectContaining({ parse_mode: "Markdown" }),
        );
    });

    it("marks a tracked request complete manually and adds a check mark reaction", async () => {
        completeTrackedSlackRequestManuallyMock.mockResolvedValue({
            id: "req-1",
            channel_id: "C123",
            message_ts: "1710000000.000100",
            requester_name: "Krystal",
            completion_po_numbers: null,
        });

        const ctx = makeCtx("/requestcomplete req-1");
        const command = operationsCommands.find((cmd) => cmd.name === "requestcomplete");

        expect(command).toBeTruthy();
        await command!.handler(ctx, {} as any);

        expect(completeTrackedSlackRequestManuallyMock).toHaveBeenCalledWith("req-1");
        expect(addSlackReactionMock).toHaveBeenCalledWith({
            channelId: "C123",
            messageTs: "1710000000.000100",
            reaction: "white_check_mark",
        });
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining("marked complete"),
            expect.objectContaining({ parse_mode: "Markdown" }),
        );
    });
});
