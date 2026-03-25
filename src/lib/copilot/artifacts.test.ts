import { describe, expect, it, vi } from "vitest";

vi.mock("../supabase", () => ({
    createClient: vi.fn().mockReturnValue(null),
}));

import { normalizeArtifact } from "./artifacts";

describe("normalizeArtifact", () => {
    it("normalizes Telegram photos into shared artifact records", async () => {
        const artifact = await normalizeArtifact({
            sourceType: "telegram_photo",
            mimeType:   "image/jpeg",
            filename:   "photo.jpg",
            threadId:   "chat-123",
        });

        expect(artifact.sourceType).toBe("telegram_photo");
        expect(artifact.artifactId).toBeTruthy();
        expect(artifact.status).toBe("pending");
    });

    it("normalizes Telegram documents into shared artifact records", async () => {
        const artifact = await normalizeArtifact({
            sourceType: "telegram_document",
            mimeType:   "application/pdf",
            filename:   "invoice.pdf",
            threadId:   "chat-456",
        });

        expect(artifact.sourceType).toBe("telegram_document");
        expect(artifact.mimeType).toBe("application/pdf");
    });

    it("normalizes dashboard uploads into shared artifact records", async () => {
        const artifact = await normalizeArtifact({
            sourceType: "dashboard_upload",
            mimeType:   "image/png",
            filename:   "screenshot.png",
            threadId:   "session-789",
        });

        expect(artifact.sourceType).toBe("dashboard_upload");
        expect(artifact.channel).toBe("dashboard");
    });

    it("sets summary when provided", async () => {
        const artifact = await normalizeArtifact({
            sourceType: "telegram_photo",
            mimeType:   "image/jpeg",
            filename:   "cart.jpg",
            threadId:   "chat-1",
            summary:    "ULINE shopping cart screenshot",
        });

        expect(artifact.summary).toBe("ULINE shopping cart screenshot");
    });
});
