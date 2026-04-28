import { describe, expect, it } from "vitest";
import { detectMigrationDrift } from "./migration-drift";

describe("detectMigrationDrift", () => {
    it("returns ok when on-disk filenames match applied versions", async () => {
        const result = await detectMigrationDrift({
            listOnDisk: async () => ["20260101_a.sql", "20260102_b.sql"],
            listApplied: async () => ["20260101_a.sql", "20260102_b.sql"],
        });
        expect(result.ok).toBe(true);
        expect(result.unapplied).toEqual([]);
    });

    it("returns drift list when on-disk has more than applied", async () => {
        const result = await detectMigrationDrift({
            listOnDisk: async () => ["20260101_a.sql", "20260102_b.sql", "20260103_c.sql"],
            listApplied: async () => ["20260101_a.sql", "20260102_b.sql"],
        });
        expect(result.ok).toBe(false);
        expect(result.unapplied).toEqual(["20260103_c.sql"]);
    });

    it("ignores out-of-order applied set (compares by filename only)", async () => {
        const result = await detectMigrationDrift({
            listOnDisk: async () => ["20260101_a.sql", "20260102_b.sql"],
            listApplied: async () => ["20260102_b.sql", "20260101_a.sql"],
        });
        expect(result.ok).toBe(true);
    });

    it("summary truncates the unapplied list at 3 items with ellipsis", async () => {
        const result = await detectMigrationDrift({
            listOnDisk: async () => ["a.sql", "b.sql", "c.sql", "d.sql", "e.sql"],
            listApplied: async () => [],
        });
        expect(result.summary).toMatch(/5 migration\(s\)/);
        expect(result.summary).toMatch(/…$/);
    });

    it("crashed dependencies surface as a failed result, not a thrown error", async () => {
        const result = await detectMigrationDrift({
            listOnDisk: async () => { throw new Error("disk read failed"); },
            listApplied: async () => [],
        });
        expect(result.ok).toBe(false);
        expect(result.summary).toMatch(/disk read failed/);
    });
});
