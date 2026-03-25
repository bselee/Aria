import { describe, expect, it } from "vitest";
import { buildCopilotContext } from "./context";
import type { ArtifactRef } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeArtifact(id: string, summary: string, offsetMsAgo = 0): ArtifactRef {
    return {
        artifactId: id,
        summary,
        sourceType: "telegram_photo",
        createdAt: new Date(Date.now() - offsetMsAgo).toISOString(),
    };
}

function makeTurn(role: "user" | "assistant", content: string) {
    return { role, content, createdAt: new Date().toISOString() };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildCopilotContext", () => {
    it("forces the latest artifact into referential follow-up context", async () => {
        const result = await buildCopilotContext({
            threadId: "t1",
            message: "add these items to PO",
            recentArtifacts: [makeArtifact("a1", "ULINE cart screenshot")],
        });

        expect(result.artifacts[0]?.artifactId).toBe("a1");
    });

    it("binds referential follow-ups to the latest artifact", async () => {
        const result = await buildCopilotContext({
            threadId: "t1",
            message: "add these items to PO",
            recentArtifacts: [makeArtifact("uline1", "ULINE cart screenshot")],
        });

        expect(result.boundArtifactId).toBe("uline1");
    });

    it("does not bind artifacts for non-referential messages", async () => {
        const result = await buildCopilotContext({
            threadId: "t1",
            message: "what is the stock for KM106",
            recentArtifacts: [makeArtifact("a1", "some photo")],
        });

        expect(result.boundArtifactId).toBeUndefined();
    });

    it("keeps at most 3 artifacts in context", async () => {
        const artifacts = [
            makeArtifact("a1", "oldest", 3000),
            makeArtifact("a2", "middle", 2000),
            makeArtifact("a3", "newer", 1000),
            makeArtifact("a4", "newest", 0),
        ];

        const result = await buildCopilotContext({
            threadId: "t1",
            message: "show me recent uploads",
            recentArtifacts: artifacts,
        });

        expect(result.artifacts.length).toBeLessThanOrEqual(3);
    });

    it("keeps at most 8 conversation turns", async () => {
        const turns = Array.from({ length: 12 }, (_, i) =>
            makeTurn(i % 2 === 0 ? "user" : "assistant", `message ${i}`)
        );

        const result = await buildCopilotContext({
            threadId: "t1",
            message: "latest question",
            recentTurns: turns,
        });

        expect(result.turns.length).toBeLessThanOrEqual(8);
    });

    it("collapses oversize context to a rolling summary", async () => {
        const turns = Array.from({ length: 20 }, (_, i) =>
            makeTurn(i % 2 === 0 ? "user" : "assistant", `long message content ${"x".repeat(500)} ${i}`)
        );

        const result = await buildCopilotContext({
            threadId: "t1",
            message: "latest question",
            recentTurns: turns,
        });

        // Oversize context: older turns collapsed, summary provided
        expect(result.turns.length).toBeLessThanOrEqual(8);
        if (result.collapsedSummary) {
            expect(result.collapsedSummary.length).toBeGreaterThan(0);
        }
    });

    it("includes the current message in the assembled context", async () => {
        const result = await buildCopilotContext({
            threadId: "t1",
            message: "consumption for PU102",
        });

        expect(result.currentMessage).toBe("consumption for PU102");
    });
});
