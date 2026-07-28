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

function defaultIds(): string[] {
    return flatten(DEFAULT_LAYOUT);
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

    it("returns a lean default layout (action panels only)", () => {
        const result = migrateDashboardLayout(null);
        const flat = flatten(result);
        for (const id of defaultIds()) {
            expect(flat).toContain(id);
        }
        // Status wallpaper stays off the default mount list.
        expect(flat).not.toContain("purchasing-calendar");
        expect(flat).not.toContain("vendor-scorecard");
        expect(flat).not.toContain("oversight");
        expect(flat).not.toContain("dedup-activity");
    });

    it("preserves a saved subset and appends missing default panels only", () => {
        const saved = {
            left: ["build-risk"],
            midLeft: [],
            midRight: [],
            right: [],
        };

        const result = migrateDashboardLayout(saved);
        const flat = flatten(result);

        expect(result.left).toContain("build-risk");
        for (const id of defaultIds()) {
            expect(flat).toContain(id);
        }
        expect(new Set(flat).size).toBe(flat.length);
    });

    it("does not duplicate ids on round-trip", () => {
        const once = migrateDashboardLayout(DEFAULT_LAYOUT);
        const serialised = serialiseDashboardLayout(once);
        const twice = migrateDashboardLayout(JSON.parse(serialised));
        const flat = flatten(twice);
        expect(new Set(flat).size).toBe(flat.length);
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
        for (const id of flat) {
            expect(ALL_PANEL_IDS).toContain(id as (typeof ALL_PANEL_IDS)[number]);
        }
    });

    it("strips retired panels including status wallpaper", () => {
        const saved = {
            left: ["chat-mirror", "build-risk", "oversight"],
            midLeft: ["reorder", "invoice-queue", "purchasing-calendar"],
            midRight: ["axiom-queue", "purchasing", "vendor-scorecard"],
            right: ["activity", "dedup-activity"],
        };
        const flat = flatten(migrateDashboardLayout(saved));
        expect(flat).not.toContain("chat-mirror");
        expect(flat).not.toContain("reorder");
        expect(flat).not.toContain("axiom-queue");
        expect(flat).not.toContain("purchasing-calendar");
        expect(flat).not.toContain("oversight");
        expect(flat).not.toContain("vendor-scorecard");
        expect(flat).not.toContain("dedup-activity");
        expect(flat).toContain("build-risk");
        expect(flat).toContain("invoice-queue");
        expect(flat).toContain("purchasing");
        expect(flat).toContain("activity");
    });

    it("migrates the legacy 3-column 'mid' shape and drops retired mid panels", () => {
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
        expect(Object.keys(result).sort()).toEqual([
            "left",
            "midLeft",
            "midRight",
            "right",
        ]);
        for (const id of ["invoice-queue", "purchasing", "build-risk", "activity", "receivings"]) {
            expect(flat).toContain(id);
        }
        expect(flat).not.toContain("purchasing-calendar");
        expect(flat).not.toContain("statement-reconciliation");
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
        // build-schedule is still a known panel (Builds tab); tracking-board is retired wallpaper
        expect(flat).toContain("build-schedule");
        expect(flat).not.toContain("tracking-board");
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
