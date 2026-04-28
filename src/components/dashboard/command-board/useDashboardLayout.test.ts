// @vitest-environment node

import { describe, it, expect } from "vitest";

import {
    ALL_COLUMNS,
    ALL_PANEL_IDS,
    DEFAULT_LAYOUT,
    migrateDashboardLayout,
    serialiseDashboardLayout,
    type DashboardLayout,
} from "./useDashboardLayout";

function flatten(layout: DashboardLayout): string[] {
    return ALL_COLUMNS.flatMap(c => layout[c]);
}

describe("migrateDashboardLayout", () => {
    it("returns defaults for empty / null / non-object input", () => {
        const expected = JSON.stringify(DEFAULT_LAYOUT);
        expect(JSON.stringify(migrateDashboardLayout(null))).toBe(expected);
        expect(JSON.stringify(migrateDashboardLayout(undefined))).toBe(expected);
        expect(JSON.stringify(migrateDashboardLayout("not-an-object"))).toBe(expected);
        expect(JSON.stringify(migrateDashboardLayout([]))).toBe(expected);
        expect(JSON.stringify(migrateDashboardLayout({}))).toBe(expected);
    });

    it("returns a layout containing every current panel id", () => {
        const result = migrateDashboardLayout(null);
        const flat = flatten(result);
        for (const id of ALL_PANEL_IDS) {
            expect(flat).toContain(id);
        }
    });

    it("preserves a saved subset and appends missing panels", () => {
        // Saved state with only build-risk in left, nothing else.
        const saved = {
            left: ["build-risk"],
            midLeft: [],
            midRight: [],
            right: [],
        };

        const result = migrateDashboardLayout(saved);
        const flat = flatten(result);

        // Saved entry preserved in its column.
        expect(result.left).toContain("build-risk");
        // Every other current panel id has been appended somewhere.
        for (const id of ALL_PANEL_IDS) {
            expect(flat).toContain(id);
        }
        // No duplicates.
        expect(new Set(flat).size).toBe(flat.length);
    });

    it("does not duplicate ids on round-trip", () => {
        const once = migrateDashboardLayout(DEFAULT_LAYOUT);
        const serialised = serialiseDashboardLayout(once);
        const twice = migrateDashboardLayout(JSON.parse(serialised));
        const flat = flatten(twice);
        expect(new Set(flat).size).toBe(flat.length);
        // Round trip is stable.
        expect(serialiseDashboardLayout(twice)).toBe(serialised);
    });

    it("drops unknown panel ids silently", () => {
        const saved = {
            left: ["build-risk", "totally-fake-panel"],
            midLeft: ["another-bogus-id"],
            midRight: [],
            right: [],
        };
        const result = migrateDashboardLayout(saved);
        const flat = flatten(result);
        expect(flat).not.toContain("totally-fake-panel");
        expect(flat).not.toContain("another-bogus-id");
        // Only the valid known ids are present.
        for (const id of flat) {
            expect(ALL_PANEL_IDS).toContain(id as (typeof ALL_PANEL_IDS)[number]);
        }
    });

    it("strips retired panels (chat-mirror, reorder, axiom-queue)", () => {
        const saved = {
            left: ["chat-mirror", "build-risk"],
            midLeft: ["reorder", "invoice-queue"],
            midRight: ["axiom-queue", "purchasing"],
            right: ["activity"],
        };
        const flat = flatten(migrateDashboardLayout(saved));
        expect(flat).not.toContain("chat-mirror");
        expect(flat).not.toContain("reorder");
        expect(flat).not.toContain("axiom-queue");
        expect(flat).toContain("build-risk");
    });

    it("migrates the legacy 3-column 'mid' shape", () => {
        const saved = {
            left: ["build-risk", "receivings"],
            mid: [
                "invoice-queue",
                "statement-reconciliation",
                "purchasing",
                "purchasing-calendar",
            ],
            right: ["activity"],
        };
        const result = migrateDashboardLayout(saved);
        const flat = flatten(result);
        // No `mid` column survives.
        expect(Object.keys(result).sort()).toEqual([
            "left",
            "midLeft",
            "midRight",
            "right",
        ]);
        for (const id of [
            "invoice-queue",
            "statement-reconciliation",
            "purchasing",
            "purchasing-calendar",
            "build-risk",
            "activity",
        ]) {
            expect(flat).toContain(id);
        }
        expect(new Set(flat).size).toBe(flat.length);
    });

    it("migrates the legacy 5-column 'farRight' shape", () => {
        const saved = {
            left: ["build-risk"],
            midLeft: ["invoice-queue"],
            midRight: ["purchasing"],
            right: ["activity"],
            farRight: ["build-schedule", "tracking-board"],
        };
        const result = migrateDashboardLayout(saved);
        const flat = flatten(result);
        expect("farRight" in result).toBe(false);
        expect(flat).toContain("build-schedule");
        expect(flat).toContain("tracking-board");
        expect(new Set(flat).size).toBe(flat.length);
    });

    it("deduplicates ids that appear in multiple columns (first wins)", () => {
        const saved = {
            left: ["build-risk", "purchasing"],
            midLeft: ["invoice-queue"],
            midRight: ["purchasing"], // duplicate
            right: ["activity"],
        };
        const result = migrateDashboardLayout(saved);
        expect(result.left).toContain("purchasing");
        expect(result.midRight).not.toContain("purchasing");
        const flat = flatten(result);
        expect(new Set(flat).size).toBe(flat.length);
    });
});
