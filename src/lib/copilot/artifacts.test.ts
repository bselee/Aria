import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({
    createMock: vi.fn(),
}));

vi.mock("openai", () => ({
    default: class OpenAI {
        chat = {
            completions: {
                create: createMock,
            },
        };
    },
}));

import { describeImageArtifact, normalizeArtifact } from "./artifacts";

describe("normalizeArtifact", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.OPENAI_API_KEY = "test-key";
    });

    it("normalizes Telegram photos into shared artifact records", async () => {
        const artifact = normalizeArtifact({
            threadId: "chat-1",
            channel: "telegram",
            sourceType: "telegram_photo",
            mimeType: "image/jpeg",
            filename: "photo.jpg",
        });

        expect(artifact.sourceType).toBe("telegram_photo");
        expect(artifact.channel).toBe("telegram");
        expect(artifact.threadId).toBe("chat-1");
        expect(artifact.artifactId).toBeTruthy();
    });

    it("describes image artifacts for screenshot follow-ups", async () => {
        createMock.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: "ULINE cart screenshot with box and tape line items ready for PO drafting.",
                    },
                },
            ],
        });

        const summary = await describeImageArtifact({
            mimeType: "image/jpeg",
            base64: Buffer.from("fake-image").toString("base64"),
        });

        expect(summary).toContain("ULINE cart screenshot");
    });
});
