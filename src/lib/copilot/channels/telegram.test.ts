import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../intelligence/chat-logger", () => ({
    logChatMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core", () => ({
    runCopilotTurn: vi.fn().mockResolvedValue({
        reply: "Stock for PU102 is healthy.",
        providerUsed: "test-provider",
        toolCalls: [],
        actionRefs: [],
    }),
}));

vi.mock("../artifacts", () => ({
    saveArtifact: vi.fn().mockResolvedValue({
        artifactId: "artifact-1",
        threadId: "1",
        channel: "telegram",
        sourceType: "telegram_photo",
        filename: "telegram-photo.jpg",
        mimeType: "image/jpeg",
        status: "ready",
        summary: "Recent Telegram screenshot",
        createdAt: "2026-03-25T00:00:00.000Z",
    }),
}));

import { runCopilotTurn } from "../core";
import { saveArtifact } from "../artifacts";
import { handleTelegramDocument, handleTelegramPhoto, handleTelegramText } from "./telegram";

describe("handleTelegramText", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("routes Telegram text messages into the shared copilot core", async () => {
        const result = await handleTelegramText({
            chatId: 1,
            text: "what is consumption for PU102",
        });

        expect(runCopilotTurn).toHaveBeenCalledWith({
            channel: "telegram",
            text: "what is consumption for PU102",
            threadId: "1",
        });
        expect(result.reply).toBeTruthy();
    });

    it("stores Telegram photos as shared artifacts", async () => {
        const artifact = await handleTelegramPhoto({
            chatId: 1,
            fileId: "abc123",
            url: "https://example.com/photo.jpg",
            mimeType: "image/jpeg",
        });

        expect(saveArtifact).toHaveBeenCalledWith({
            threadId: "1",
            channel: "telegram",
            sourceType: "telegram_photo",
            filename: "telegram-photo.jpg",
            mimeType: "image/jpeg",
            rawText: "https://example.com/photo.jpg",
            summary: "Telegram photo uploaded for copilot follow-up.",
            structuredData: {
                fileId: "abc123",
                url: "https://example.com/photo.jpg",
            },
            tags: ["telegram", "photo"],
        });
        expect(artifact.artifactId).toBe("artifact-1");
    });

    it("stores analyzed Telegram photo summaries when available", async () => {
        await handleTelegramPhoto({
            chatId: 1,
            fileId: "abc123",
            url: "https://example.com/photo.jpg",
            mimeType: "image/jpeg",
            summary: "ULINE cart screenshot with packing supplies.",
        });

        expect(saveArtifact).toHaveBeenCalledWith(
            expect.objectContaining({
                summary: "ULINE cart screenshot with packing supplies.",
            }),
        );
    });

    it("stores Telegram documents as shared artifacts", async () => {
        const artifact = await handleTelegramDocument({
            chatId: 1,
            fileId: "doc123",
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            rawText: "Invoice 1001 for ULINE",
        });

        expect(saveArtifact).toHaveBeenCalledWith({
            threadId: "1",
            channel: "telegram",
            sourceType: "telegram_document",
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            rawText: "Invoice 1001 for ULINE",
            structuredData: {
                fileId: "doc123",
            },
            tags: ["telegram", "document"],
        });
        expect(artifact.artifactId).toBe("artifact-1");
    });
});
