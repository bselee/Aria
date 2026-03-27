import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMessageLabelPolicy } from "./gmail-policy";

describe("applyMessageLabelPolicy", () => {
    const listMock = vi.fn();
    const createMock = vi.fn();
    const modifyMock = vi.fn();

    const gmail = {
        users: {
            labels: {
                list: listMock,
                create: createMock,
            },
            messages: {
                modify: modifyMock,
            },
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        listMock.mockResolvedValue({ data: { labels: [] } });
        createMock.mockImplementation(async ({ requestBody }: { requestBody: { name: string } }) => ({
            data: { id: `${requestBody.name.toLowerCase().replace(/\s+/g, "-")}-id` },
        }));
        modifyMock.mockResolvedValue({ data: {} });
    });

    it("adds user labels without touching inbox visibility when no removals are requested", async () => {
        await applyMessageLabelPolicy({
            gmail,
            gmailMessageId: "gmail-1",
            addLabels: ["Replied"],
        });

        expect(modifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-1",
            requestBody: {
                addLabelIds: ["replied-id"],
            },
        });
    });

    it("can add invoice labels while removing inbox visibility labels on a closed workflow", async () => {
        await applyMessageLabelPolicy({
            gmail,
            gmailMessageId: "gmail-2",
            addLabels: ["Invoices"],
            removeLabels: ["INBOX", "UNREAD"],
        });

        expect(modifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-2",
            requestBody: {
                addLabelIds: ["invoices-id"],
                removeLabelIds: ["INBOX", "UNREAD"],
            },
        });
    });
});
