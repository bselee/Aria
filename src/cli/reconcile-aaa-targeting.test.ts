import { describe, expect, it, vi } from "vitest";

import {
    fetchAAACooperStatements,
    parseReconcileAAAArgs,
    type GmailLike,
} from "./reconcile-aaa-targeting";

function createGmailMock(overrides?: {
    listMessages?: any[];
    getMessage?: (id: string) => any;
    getAttachment?: (messageId: string, attachmentId: string) => any;
}) : GmailLike {
    const listMessages = overrides?.listMessages || [];
    const getMessage = overrides?.getMessage || ((id: string) => ({
        id,
        labelIds: ["INBOX", "UNREAD"],
        payload: {
            headers: [
                { name: "Subject", value: "AAA Cooper Transportation Stmt  (C#: 0001159492)" },
                { name: "From", value: "AAA COOPER TRANSPORTATION <act.statement@aaacooper.com>" },
                { name: "Date", value: "Thu, 2 Apr 2026 23:38:57 -0500" },
            ],
            parts: [
                {
                    filename: "ACT_STMD_ID_2405.PDF",
                    body: { attachmentId: "att-1" },
                },
            ],
        },
    }));
    const getAttachment = overrides?.getAttachment || (() => ({
        data: { data: Buffer.from("pdf").toString("base64url") },
    }));

    return {
        users: {
            messages: {
                list: vi.fn().mockResolvedValue({ data: { messages: listMessages } }),
                get: vi.fn().mockImplementation(async ({ id }: { id: string }) => ({ data: getMessage(id) })),
                attachments: {
                    get: vi.fn().mockImplementation(async ({ messageId, id }: { messageId: string; id: string }) => getAttachment(messageId, id)),
                },
            },
        },
    };
}

describe("parseReconcileAAAArgs", () => {
    it("parses exact-message targeting flags", () => {
        const parsed = parseReconcileAAAArgs([
            "--dry-run",
            "--scrape-only",
            "--message-id",
            "19d51a4a0b514ca5",
            "--inbox-only",
        ]);

        expect(parsed.dryRun).toBe(true);
        expect(parsed.scrapeOnly).toBe(true);
        expect(parsed.messageId).toBe("19d51a4a0b514ca5");
        expect(parsed.inboxOnly).toBe(true);
    });
});

describe("fetchAAACooperStatements", () => {
    it("returns only the requested exact AAA Cooper message id", async () => {
        const gmail = createGmailMock();

        const result = await fetchAAACooperStatements(gmail, {
            messageId: "19d51a4a0b514ca5",
            inboxOnly: true,
        });

        expect(gmail.users.messages.list).not.toHaveBeenCalled();
        expect(gmail.users.messages.get).toHaveBeenCalledWith({
            userId: "me",
            id: "19d51a4a0b514ca5",
            format: "full",
        });
        expect(result).toHaveLength(1);
        expect(result[0].messageId).toBe("19d51a4a0b514ca5");
        expect(result[0].attachments).toHaveLength(1);
    });

    it("rejects the exact target when inbox-only is requested and the message is not in inbox", async () => {
        const gmail = createGmailMock({
            getMessage: (id: string) => ({
                id,
                labelIds: ["UNREAD"],
                payload: {
                    headers: [
                        { name: "Subject", value: "AAA Cooper Transportation Stmt  (C#: 0001159492)" },
                        { name: "From", value: "AAA COOPER TRANSPORTATION <act.statement@aaacooper.com>" },
                        { name: "Date", value: "Thu, 2 Apr 2026 23:38:57 -0500" },
                    ],
                    parts: [
                        {
                            filename: "ACT_STMD_ID_2405.PDF",
                            body: { attachmentId: "att-1" },
                        },
                    ],
                },
            }),
        });

        const result = await fetchAAACooperStatements(gmail, {
            messageId: "19d51a4a0b514ca5",
            inboxOnly: true,
        });

        expect(result).toEqual([]);
        expect(gmail.users.messages.list).not.toHaveBeenCalled();
    });

    it("does not broaden to the search query when an exact message id is provided", async () => {
        const gmail = createGmailMock({
            listMessages: [{ id: "some-other-message" }],
        });

        const result = await fetchAAACooperStatements(gmail, {
            messageId: "19d51a4a0b514ca5",
            inboxOnly: false,
        });

        expect(result).toHaveLength(1);
        expect(gmail.users.messages.list).not.toHaveBeenCalled();
    });
});
