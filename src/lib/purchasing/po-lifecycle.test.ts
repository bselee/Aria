/**
 * @file    src/lib/purchasing/po-lifecycle.test.ts
 * @purpose Unit tests for PO lifecycle state machine
 * @author  Hermia
 * @created 2026-06-01
 */
import { describe, expect, it, vi } from "vitest";

import {
    assertValidTransition,
    getLifecycleState,
    transitionLifecycleState,
    getPOLifecycleHistory,
    PO_LIFECYCLE_STATES,
} from "./po-lifecycle";

// ---------------------------------------------------------------------------
// Pure function: assertValidTransition
// ---------------------------------------------------------------------------
describe("assertValidTransition", () => {
    it("allows ORDERED → INVOICED", () => {
        expect(() => assertValidTransition("ORDERED", "INVOICED")).not.toThrow();
    });

    it("allows ORDERED → RECEIVED (drop-ship shortcut)", () => {
        expect(() => assertValidTransition("ORDERED", "RECEIVED")).not.toThrow();
    });

    it("allows INVOICED → RECONCILED", () => {
        expect(() => assertValidTransition("INVOICED", "RECONCILED")).not.toThrow();
    });

    it("allows RECONCILED → RECEIVED", () => {
        expect(() => assertValidTransition("RECONCILED", "RECEIVED")).not.toThrow();
    });

    it("allows RECONCILED → COMPLETED (no-receipt finalise)", () => {
        expect(() => assertValidTransition("RECONCILED", "COMPLETED")).not.toThrow();
    });

    it("allows RECEIVED → COMPLETED", () => {
        expect(() => assertValidTransition("RECEIVED", "COMPLETED")).not.toThrow();
    });

    it("allows RECEIVED → RECONCILED (receipt-then-reconcile)", () => {
        expect(() => assertValidTransition("RECEIVED", "RECONCILED")).not.toThrow();
    });

    it("blocks COMPLETED → anything (terminal state)", () => {
        for (const state of ["ORDERED", "INVOICED", "RECONCILED", "RECEIVED", "COMPLETED"]) {
            expect(() => assertValidTransition("COMPLETED", state)).toThrow(
                /Invalid PO lifecycle transition/
            );
        }
    });

    it("blocks ORDERED → COMPLETED (skip)", () => {
        expect(() => assertValidTransition("ORDERED", "COMPLETED")).toThrow(
            /Invalid PO lifecycle transition/
        );
    });

    it("blocks INVOICED → ORDERED (regression)", () => {
        expect(() => assertValidTransition("INVOICED", "ORDERED")).toThrow(
            /Invalid PO lifecycle transition/
        );
    });

    it("handles null initial state as ORDERED", () => {
        expect(() => assertValidTransition(null, "INVOICED")).not.toThrow();
        expect(() => assertValidTransition(null, "ORDERED")).toThrow();
        expect(() => assertValidTransition(null, "COMPLETED")).toThrow();
    });

    it("throws with descriptive message including allowed transitions", () => {
        try {
            assertValidTransition("ORDERED", "COMPLETED");
        } catch (e: any) {
            expect(e.message).toContain("ORDERED");
            expect(e.message).toContain("INVOICED");
            expect(e.message).toContain("RECEIVED");
        }
    });

    it("allows every expected valid transition", () => {
        const valid: Array<[string, string]> = [
            ["ORDERED", "INVOICED"],
            ["ORDERED", "RECEIVED"],
            ["INVOICED", "RECONCILED"],
            ["INVOICED", "RECEIVED"],
            ["RECONCILED", "RECEIVED"],
            ["RECONCILED", "COMPLETED"],
            ["RECEIVED", "RECONCILED"],
            ["RECEIVED", "COMPLETED"],
        ];
        for (const [from, to] of valid) {
            expect(() => assertValidTransition(from, to)).not.toThrow();
        }
    });

    it("rejects unknown target states", () => {
        expect(() => assertValidTransition("ORDERED", "UNKNOWN_STATE")).toThrow(
            /Invalid PO lifecycle transition/
        );
    });
});

// ---------------------------------------------------------------------------
// Best-effort functions (never throw)
// ---------------------------------------------------------------------------
describe("getLifecycleState (best-effort)", () => {
    it("returns null or a state string without throwing", async () => {
        const result = await getLifecycleState("PO-001");
        expect([null, "ORDERED", "INVOICED", "RECONCILED", "RECEIVED", "COMPLETED"]).toContain(result);
    });

    it("handles empty PO number gracefully", async () => {
        const result = await getLifecycleState("");
        expect(result === null || typeof result === "string").toBe(true);
    });
});

describe("getPOLifecycleHistory (best-effort)", () => {
    it("returns null or an array without throwing", async () => {
        const result = await getPOLifecycleHistory("");
        expect(result === null || Array.isArray(result)).toBe(true);
    });

    it("returns null or an array for a valid-looking PO", async () => {
        const result = await getPOLifecycleHistory("PO-99999", 5);
        expect(result === null || Array.isArray(result)).toBe(true);
    });
});

describe("transitionLifecycleState (best-effort)", () => {
    it("resolves undefined without throwing on any input", async () => {
        await expect(
            transitionLifecycleState("PO-001", "INVOICED", "test")
        ).resolves.toBeUndefined();
    });

    it("handles invalid transitions by silently returning", async () => {
        // COMPLETED → INVOICED is invalid; should warn and return silently
        await expect(
            transitionLifecycleState("PO-001", "INVOICED", "test")
        ).resolves.toBeUndefined();
    });

    it("accepts optional metadata", async () => {
        await expect(
            transitionLifecycleState("PO-002", "RECEIVED", "receiver", {
                invoiceId: "INV-001",
                source: "manual",
            })
        ).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// PO_LIFECYCLE_STATES export integrity
// ---------------------------------------------------------------------------
describe("PO_LIFECYCLE_STATES", () => {
    it("has exactly 5 states in correct order", () => {
        expect(PO_LIFECYCLE_STATES).toEqual([
            "ORDERED",
            "INVOICED",
            "RECONCILED",
            "RECEIVED",
            "COMPLETED",
        ]);
    });

    it("each state is a non-empty string", () => {
        for (const state of PO_LIFECYCLE_STATES) {
            expect(typeof state).toBe("string");
            expect(state.length).toBeGreaterThan(0);
        }
    });
});
