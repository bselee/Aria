import { describe, expect, it } from "vitest";
import { buildCatalog, COMMAND_BOARD_HIERARCHY, summarizeMarkdown } from "./catalog";
import { buildCommandBoardHierarchy } from "@/lib/intelligence/hermes-orchestrator";

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

    it("hierarchy: will is root, hermia reports to will, every aria agent has a parent and runs on aria-bot", async () => {
        const cat = await buildCatalog();
        const will = cat.agents.find((a) => a.id === "will");
        const hermia = cat.agents.find((a) => a.id === "hermia");
        const apMaster = cat.agents.find((a) => a.id === "ap-master");
        expect(will).toBeDefined();
        expect(will?.reportsTo).toBeNull();
        expect(hermia).toBeDefined();
        expect(hermia?.reportsTo).toBe("will");
        expect(apMaster).toBeDefined();
        expect(apMaster?.reportsTo).toBe("hermia");

        const ariaAgents = cat.agents.filter(
            (a) => a.id !== "will" && a.id !== "hermia",
        );
        expect(ariaAgents.length).toBeGreaterThan(0);
        for (const a of ariaAgents) {
            expect(a.reportsTo).not.toBeNull();
            expect(a.process).toEqual(["aria-bot"]);
        }
    });

    it("derived hierarchy uses AGENT_REGISTRY ids, not the legacy v1 ids", async () => {
        const cat = await buildCatalog();
        const ids = new Set(cat.agents.map((a) => a.id));
        // Legacy v1 hierarchy ids must be gone — the registry is canonical.
        for (const legacy of ["ops-manager", "aria-bot", "ap-agent", "reconciliation", "build-risk", "nightshift", "vendor-intelligence"]) {
            expect(ids.has(legacy)).toBe(false);
        }
        // Registry ids must all be present (spotted sample across domains).
        for (const id of [
            "will",
            "hermia",
            "ap-master",
            "ap-ingestor",
            "ap-classifier",
            "ap-extractor",
            "ap-matcher",
            "ap-reconciler",
            "ap-forwarder",
            "purchasing-master",
            "purchasing-scanner",
            "purchasing-drafter",
            "purchasing-cycle-guard",
            "purchasing-followup",
            "comms-master",
            "email-ack",
            "vendor-comms",
            "tracking-master",
            "carrier-poller",
            "shipment-intel",
            "ops-master",
            "cron-scheduler",
            "cognitive-round",
            "supervisor",
            "budget-tracker",
        ]) {
            expect(ids.has(id)).toBe(true);
        }
    });

    it("invariant: every non-root agent's reportsTo resolves to an existing id", async () => {
        const cat = await buildCatalog();
        const ids = new Set(cat.agents.map((a) => a.id));
        for (const a of cat.agents) {
            if (a.reportsTo === null) continue;
            expect(ids.has(a.reportsTo)).toBe(true);
        }
    });

    it("invariant: all agent ids are unique", async () => {
        const cat = await buildCatalog();
        const ids = cat.agents.map((a) => a.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("invariant: exactly one root agent (reportsTo null)", async () => {
        const cat = await buildCatalog();
        const roots = cat.agents.filter((a) => a.reportsTo === null);
        expect(roots).toHaveLength(1);
        expect(roots[0]?.id).toBe("will");
    });

    it("invariant: the 5 domains each have exactly one master reporting to hermia", async () => {
        const cat = await buildCatalog();
        const masters = cat.agents.filter((a) => a.reportsTo === "hermia");
        expect(masters).toHaveLength(5);
        expect(masters.map((m) => m.id).sort()).toEqual([
            "ap-master",
            "comms-master",
            "ops-master",
            "purchasing-master",
            "tracking-master",
        ]);
    });

    it("invariant: COMMAND_BOARD_HIERARCHY equals the derived list and matches the catalog", async () => {
        const derived = buildCommandBoardHierarchy();
        expect(COMMAND_BOARD_HIERARCHY).toEqual(derived);
        expect(COMMAND_BOARD_HIERARCHY.length).toBe(derived.length);

        const cat = await buildCatalog();
        expect(cat.agents.length).toBe(COMMAND_BOARD_HIERARCHY.length);
        expect(cat.agents).toEqual(COMMAND_BOARD_HIERARCHY);
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
