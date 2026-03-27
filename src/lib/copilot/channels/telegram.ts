import { logChatMessage } from "../../intelligence/chat-logger";
import { describeImageArtifact, saveArtifact } from "../artifacts";
import { runCopilotTurn, type CopilotTurnResult } from "../core";

export interface TelegramTextInput {
    chatId: number | string;
    text: string;
}

export interface TelegramPhotoInput {
    chatId: number | string;
    fileId: string;
    url: string;
    mimeType?: string;
    base64?: string;
    summary?: string;
}

export interface TelegramDocumentInput {
    chatId: number | string;
    fileId: string;
    filename: string;
    mimeType: string;
    rawText?: string;
    summary?: string;
}

export async function handleTelegramText(input: TelegramTextInput): Promise<CopilotTurnResult> {
    const threadId = String(input.chatId);

    await logChatMessage({
        source: "telegram",
        role: "user",
        content: input.text,
        threadId,
    });

    const result = await runCopilotTurn({
        channel: "telegram",
        text: input.text,
        threadId,
    });

    await logChatMessage({
        source: "telegram",
        role: "assistant",
        content: result.reply,
        threadId,
    });

    return result;
}

export async function handleTelegramPhoto(input: TelegramPhotoInput) {
    const mimeType = input.mimeType ?? "image/jpeg";
    const summary = input.summary
        ?? (input.base64 ? await describeImageArtifact({ mimeType, base64: input.base64 }) : undefined)
        ?? "Telegram photo uploaded for copilot follow-up.";

    return saveArtifact({
        threadId: String(input.chatId),
        channel: "telegram",
        sourceType: "telegram_photo",
        filename: "telegram-photo.jpg",
        mimeType,
        rawText: input.url,
        summary,
        structuredData: {
            fileId: input.fileId,
            url: input.url,
        },
        tags: ["telegram", "photo"],
    });
}

export async function handleTelegramDocument(input: TelegramDocumentInput) {
    return saveArtifact({
        threadId: String(input.chatId),
        channel: "telegram",
        sourceType: "telegram_document",
        filename: input.filename,
        mimeType: input.mimeType,
        rawText: input.rawText,
        summary: input.summary,
        structuredData: {
            fileId: input.fileId,
        },
        tags: ["telegram", "document"],
    });
}
