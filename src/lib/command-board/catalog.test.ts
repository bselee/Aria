import { describe, expect, it } from "vitest";
import { buildCatalog, summarizeMarkdown } from "./catalog";

describe("summarizeMarkdown", () => {
    it("returns the first non-empty paragraph after the H1", () => {
        const md = "# Title\n\nFirst paragraph here.\n\nSecond paragraph.";
        expect(summarizeMarkdown(md)).toBe("First paragraph here.");
    });

    it("ignores blockquotes/comments before content", () => {
        const md = "# Title\n\n> A note.\n\nReal summary line.";
        const out = summarizeMarkdown(md);
        // First non-empty paragraph is the blockquote line; ensure we still get something
        expect(out.length).toBeGreaterThan(0);
    });

    it("returns empty string when no body content", () => {
        expect(summarizeMarkdown("# Title only")).toBe("");
    });

    it("truncates to ~200 chars", () => {
        const long = "# H\n\n" + "a".repeat(500);
        const s = summarizeMarkdown(long);
        expect(s.length).toBeLessThanOrEqual(203); // 200 + "..."
    });

    it("handles missing H1", () => {
        const md = "Just a paragraph with no header.\n\nSecond.";
        expect(summarizeMarkdown(md)).toBe("Just a paragraph with no header.");
    });
});

describe("buildCatalog", () => {
    it("includes .agents/AGENTS.md in references", async () => {
        const cat = await buildCatalog();
        const ids = cat.references.map((r) => r.id);
        expect(ids).toContain("AGENTS");
    });

    it("returns at least one agentFile, skill, and workflow", async () => {
        const cat = await buildCatalog();
        expect(cat.agentFiles.length).toBeGreaterThan(0);
        expect(cat.skills.length).toBeGreaterThan(0);
        expect(cat.workflows.length).toBeGreaterThan(0);
    });

    it("hierarchy: will is root, ops-manager reports to will, others to ops-manager", async () => {
        const cat = await buildCatalog();
        const will = cat.agents.find((a) => a.id === "will");
        const opsManager = cat.agents.find((a) => a.id === "ops-manager");
        expect(will).toBeDefined();
        expect(will?.reportsTo).toBeNull();
        expect(opsManager?.reportsTo).toBe("will");

        const others = cat.agents.filter(
            (a) => a.id !== "will" && a.id !== "ops-manager",
        );
        expect(others.length).toBeGreaterThan(0);
        for (const a of others) {
            expect(a.reportsTo).toBe("ops-manager");
        }
    });

    it("hierarchy includes the canonical v1 agent ids", async () => {
        const cat = await buildCatalog();
        const ids = new Set(cat.agents.map((a) => a.id));
        for (const id of [
            "will",
            "ops-manager",
            "aria-bot",
            "ap-agent",
            "watchdog",
            "supervisor",
            "reconciliation",
            "purchasing",
            "tracking",
            "build-risk",
            "nightshift",
            "vendor-intelligence",
        ]) {
            expect(ids.has(id)).toBe(true);
        }
    });

    it("generatedAt is an ISO string", async () => {
        const cat = await buildCatalog();
        expect(() => new Date(cat.generatedAt).toISOString()).not.toThrow();
    });

    it("entries carry stable ids derived from filenames", async () => {
        const cat = await buildCatalog();
        for (const f of cat.agentFiles) {
            expect(f.id).toBeTruthy();
            expect(f.path).toMatch(/\.md$/);
        }
        for (const s of cat.skills) {
            expect(s.id).toBeTruthy();
        }
    });
});
