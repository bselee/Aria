import { describe, it, expect } from "vitest";
import { buildJitTaskArgs, JIT_SOURCE_TABLE, type JitTrigger } from "./jit-tasks";
import { closesWhenFor } from "./agent-task-closure";
import { inputHash } from "./agent-task-hash";

const base: JitTrigger = {
    sku: "EM-1",
    riskLevel: "WARNING",
    triggerDate: "2026-06-15",
    vendorName: "TeraGanix",
    onHand: 12,
    coverageDays: 9,
    usedIn: ["FG-A", "FG-B"],
};

describe("buildJitTaskArgs", () => {
    it("maps a trigger to a will-owned jit_order_trigger task", () => {
        const args = buildJitTaskArgs(base, "2026-06-11");
        expect(args.type).toBe("jit_order_trigger");
        expect(args.owner).toBe("will");
        expect(args.requiresApproval).toBe(false);
        expect(args.sourceTable).toBe(JIT_SOURCE_TABLE);
        expect(args.sourceId).toBe("jit:EM-1");
        expect(args.goal).toContain("Order EM-1 by 2026-06-15");
        expect(args.goal).toContain("TeraGanix");
        expect(args.goal).toContain("FG-A, FG-B");
    });

    it("prioritizes due-today and CRITICAL triggers above the rest", () => {
        expect(buildJitTaskArgs({ ...base, triggerDate: "2026-06-11" }, "2026-06-11").priority).toBe(1);
        expect(buildJitTaskArgs({ ...base, triggerDate: "2026-06-10" }, "2026-06-11").priority).toBe(1); // overdue
        expect(buildJitTaskArgs({ ...base, riskLevel: "CRITICAL" }, "2026-06-11").priority).toBe(1);
        expect(buildJitTaskArgs(base, "2026-06-11").priority).toBe(2); // future WARNING
    });

    it("keeps volatile telemetry out of the hashed inputs so daily reruns dedup", () => {
        // Same obligation identity (sku + vendor + triggerDate) → same hash even
        // when on-hand / coverage telemetry differs day to day.
        const day1 = buildJitTaskArgs({ ...base, onHand: 12, coverageDays: 9 }, "2026-06-11");
        const day2 = buildJitTaskArgs({ ...base, onHand: 7, coverageDays: 4 }, "2026-06-12");
        expect(inputHash(day1.inputs ?? {})).toBe(inputHash(day2.inputs ?? {}));
        expect(day1.sourceId).toBe(day2.sourceId);
    });

    it("treats a shifted trigger date as a new obligation (different hash)", () => {
        const a = buildJitTaskArgs({ ...base, triggerDate: "2026-06-15" }, "2026-06-11");
        const b = buildJitTaskArgs({ ...base, triggerDate: "2026-06-13" }, "2026-06-11");
        expect(inputHash(a.inputs ?? {})).not.toBe(inputHash(b.inputs ?? {}));
    });

    it("tolerates a missing vendor", () => {
        const args = buildJitTaskArgs({ ...base, vendorName: null }, "2026-06-11");
        expect(args.goal).toContain("unknown vendor");
        expect((args.inputs as any).vendor).toBe("unknown vendor");
    });
});

describe("closesWhenFor(jit_order_trigger)", () => {
    it("returns a 14-day deadline predicate", () => {
        const cw = closesWhenFor({ type: "jit_order_trigger", sourceTable: JIT_SOURCE_TABLE });
        expect(cw).toEqual({ kind: "deadline", max_age_hours: 336 });
    });
});
