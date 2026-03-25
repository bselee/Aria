import { describe, expect, it } from "vitest";
import type {
    ArtifactStatus,
    ArtifactSourceType,
    ActionStatus,
    ActionSessionStatus,
    CopilotArtifact,
    CopilotActionSession,
} from "./types";

describe("copilot persistence types", () => {
    it("requires durable artifact/session status enums", () => {
        const artifactStatuses: ArtifactStatus[] = ["pending", "ready", "expired"];
        expect(artifactStatuses).toContain("ready");
    });

    it("requires all artifact source types", () => {
        const sources: ArtifactSourceType[] = [
            "telegram_photo",
            "telegram_document",
            "dashboard_upload",
        ];
        expect(sources.length).toBeGreaterThan(0);
    });

    it("requires all action result statuses", () => {
        const statuses: ActionStatus[] = [
            "success",
            "needs_confirmation",
            "failed",
            "partial_success",
        ];
        expect(statuses).toContain("needs_confirmation");
    });

    it("requires all action session statuses", () => {
        const statuses: ActionSessionStatus[] = ["pending", "confirmed", "cancelled", "expired"];
        expect(statuses).toContain("pending");
    });

    it("CopilotArtifact has required shape", () => {
        const a: CopilotArtifact = {
            artifactId: "test-id",
            threadId:   "thread-1",
            channel:    "telegram",
            sourceType: "telegram_photo",
            filename:   "photo.jpg",
            mimeType:   "image/jpeg",
            status:     "ready",
            createdAt:  new Date().toISOString(),
        };
        expect(a.artifactId).toBe("test-id");
    });

    it("CopilotActionSession has required shape", () => {
        const s: CopilotActionSession = {
            sessionId:  "session-1",
            channel:    "telegram",
            actionType: "po_send",
            payload:    { orderId: "123" },
            status:     "pending",
            createdAt:  new Date().toISOString(),
            expiresAt:  new Date(Date.now() + 3600_000).toISOString(),
        };
        expect(s.sessionId).toBe("session-1");
    });
});
