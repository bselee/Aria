/**
 * @file    gmail-sent-reader.test.ts
 * @purpose Unit tests for the sent-mail gold-sample reader (C2 scaffold).
 *          Gmail client is injected and fully mocked — no auth, no network.
 */
import { describe, expect, it, vi } from "vitest";
import { extractMessageText, findSentRepliesInThread } from "./gmail-sent-reader";

/** Encode plain text the way Gmail does (base64url). */
function b64url(text: string): string {
    return Buffer.from(text, "utf-8").toString("base64url");
}

function makeGmailMock(opts: {
    messages?: Array<{ id: string; threadId: string }>;
    payload?: any;
}) {
    const list = vi.fn().mockResolvedValue({
        data: { messages: opts.messages ?? [] },
    });
    const get = vi.fn().mockResolvedValue({
        data: { payload: opts.payload ?? null },
    });
    return {
        users: {
            messages: {
                list,
                get,
            },
        },
        _list: list,
        _get: get,
    };
}

describe("findSentRepliesInThread", () => {
    it("returns the latest sent reply body for the target thread", async () => {
        const gmail = makeGmailMock({
            // Newest-first list order, as Gmail returns it.
            messages: [
                { id: "sent-3", threadId: "thread-1" },
                { id: "sent-2", threadId: "thread-1" },
                { id: "sent-1", threadId: "other-thread" },
            ],
            payload: {
                mimeType: "text/plain",
                body: { data: b64url("Thanks Jessica — pricing and TDS received. We'll compare.\nThanks!") },
            },
        });

        const result = await findSentRepliesInThread(gmail, "thread-1", "bill@buildasoil.com");

        expect(gmail._list).toHaveBeenCalledWith({
            userId: "me",
            q: "from:bill@buildasoil.com in:sent",
            maxResults: 100,
        });
        expect(gmail._get).toHaveBeenCalledWith({
            userId: "me",
            id: "sent-3",
            format: "full",
        });
        expect(result).toEqual({
            messageId: "sent-3",
            threadId: "thread-1",
            body: "Thanks Jessica — pricing and TDS received. We'll compare.\nThanks!",
        });
    });

    it("returns null when Bill never sent into the thread", async () => {
        const gmail = makeGmailMock({
            messages: [
                { id: "sent-9", threadId: "thread-other" },
                { id: "sent-8", threadId: "thread-other" },
            ],
        });

        const result = await findSentRepliesInThread(gmail, "thread-1", "bill@buildasoil.com");

        expect(result).toBeNull();
        expect(gmail._get).not.toHaveBeenCalled();
    });

    it("returns null when the sent folder has no messages at all", async () => {
        const gmail = makeGmailMock({ messages: [] });

        const result = await findSentRepliesInThread(gmail, "thread-1", "bill@buildasoil.com");

        expect(result).toBeNull();
    });
});

describe("extractMessageText", () => {
    it("extracts text/plain from nested multipart payloads", () => {
        const text = extractMessageText({
            mimeType: "multipart/alternative",
            parts: [
                { mimeType: "text/plain", body: { data: b64url("Plain body") } },
                { mimeType: "text/html", body: { data: b64url("<p>HTML body</p>") } },
            ],
        });
        expect(text).toBe("Plain body");
    });

    it("returns empty string for null payloads", () => {
        expect(extractMessageText(null)).toBe("");
    });
});
