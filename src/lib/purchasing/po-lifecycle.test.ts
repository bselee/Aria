/**
 * @file    src/lib/purchasing/po-lifecycle.test.ts
 * @purpose Unit tests for PO lifecycle state machine
 * @author  Hermia
 * @created 2026-06-01
 * @updated 2026-06-01 (added dispatch stage tests: REVIEW, SENT, ACKNOWLEDGED, CANCELLED)
 */
import { describe, expect, it, vi } from "vitest";

import {
    assertValidTransition,
    getLifecycleState,
    transitionLifecycleState,
    getPOLifecycleHistory,
    PO_LIFECYCLE_STATES,
    INITIAL_LIFECYCLE_STATE,
} from "./po-lifecycle";

// ---------------------------------------------------------------------------
// Pure function: assertValidTransition
// ---------------------------------------------------------------------------
describe("assertValidTransition", () => {
    // --- Dispatch stages (NEW) ---
    it("allows REVIEW → SENT (draft dispatched)", () => {
        expect(() => assertValidTransition("REVIEW", "SENT")).not.toThrow();
    });

    it("allows REVIEW → INVOICED (invoice arrives before dispatch)", () => {
        expect(() => assertValidTransition("REVIEW", "INVOICED")).not.toThrow();
    });

    it("allows REVIEW → RECEIVED (goods arrive before dispatch)", () => {
        expect(() => assertValidTransition("REVIEW", "RECEIVED")).not.toThrow();
    });

    it("allows REVIEW → CANCELLED (draft cancelled)", () => {
        expect(() => assertValidTransition("REVIEW", "CANCELLED")).not.toThrow();
    });

    it("allows SENT → ACKNOWLEDGED (vendor confirmed)", () => {
        expect(() => assertValidTransition("SENT", "ACKNOWLEDGED")).not.toThrow();
    });

    it("allows SENT → INVOICED (invoice arrives before ack)", () => {
        expect(() => assertValidTransition("SENT", "INVOICED")).not.toThrow();
    });

    it("allows SENT → RECEIVED (goods arrive before ack)", () => {
        expect(() => assertValidTransition("SENT", "RECEIVED")).not.toThrow();
    });

    it("allows ACKNOWLEDGED → INVOICED", () => {
        expect(() => assertValidTransition("ACKNOWLEDGED", "INVOICED")).not.toThrow();
    });

    it("allows ACKNOWLEDGED → RECEIVED", () => {
        expect(() => assertValidTransition("ACKNOWLEDGED", "RECEIVED")).not.toThrow();
    });

    // --- Legacy backward compat ---
    it("allows ORDERED → INVOICED (legacy compat)", () => {
        expect(() => assertValidTransition("ORDERED", "INVOICED")).not.toThrow();
    });

    it("allows ORDERED → RECEIVED (legacy drop-ship shortcut)", () => {
        expect(() => assertValidTransition("ORDERED", "RECEIVED")).not.toThrow();
    });

    it("allows ORDERED → CANCELLED (legacy cancel)", () => {
        expect(() => assertValidTransition("ORDERED", "CANCELLED")).not.toThrow();
    });

    // --- Existing pipeline ---
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

    // --- Terminal states ---
    it("blocks COMPLETED → anything (terminal state)", () => {
        const allStates = [...PO_LIFECYCLE_STATES];
        for (const state of allStates) {
            if (state === "COMPLETED") continue;
            expect(() => assertValidTransition("COMPLETED", state)).toThrow(
                /Invalid PO lifecycle transition/
            );
        }
    });

    it("blocks CANCELLED → anything (terminal state)", () => {
        const allStates = [...PO_LIFECYCLE_STATES];
        for (const state of allStates) {
            if (state === "CANCELLED") continue;
            expect(() => assertValidTransition("CANCELLED", state)).toThrow(
                /Invalid PO lifecycle transition/
            );
        }
    });

    // --- Invalid transitions ---
    it("blocks REVIEW → COMPLETED (skip)", () => {
        expect(() => assertValidTransition("REVIEW", "COMPLETED")).toThrow(
            /Invalid PO lifecycle transition/
        );
    });

    it("blocks SENT → COMPLETED (skip)", () => {
        expect(() => assertValidTransition("SENT", "COMPLETED")).toThrow(
            /Invalid PO lifecycle transition/
        );
    });

    it("blocks ACKNOWLEDGED → COMPLETED (skip)", () => {
        expect(() => assertValidTransition("ACKNOWLEDGED", "COMPLETED")).toThrow(
            /Invalid PO lifecycle transition/
        );
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

    it("handles null initial state as REVIEW", () => {
        expect(() => assertValidTransition(null, "INVOICED")).not.toThrow();
        expect(() => assertValidTransition(null, "SENT")).not.toThrow();
        expect(() => assertValidTransition(null, "CANCELLED")).not.toThrow();
        expect(() => assertValidTransition(null, "COMPLETED")).toThrow();
    });

    it("throws with descriptive message including allowed transitions", () => {
        try {
            assertValidTransition("REVIEW", "COMPLETED");
        } catch (e: any) {
            expect(e.message).toContain("REVIEW");
            expect(e.message).toContain("SENT");
            expect(e.message).toContain("INVOICED");
        }
    });

    it("allows every expected valid transition", () => {
        const valid: Array<[string, string]> = [
            // Dispatch stages
            ["REVIEW", "SENT"],
            ["REVIEW", "INVOICED"],
            ["REVIEW", "RECEIVED"],
            ["REVIEW", "CANCELLED"],
            ["SENT", "ACKNOWLEDGED"],
            ["SENT", "INVOICED"],
            ["SENT", "RECEIVED"],
            ["ACKNOWLEDGED", "INVOICED"],
            ["ACKNOWLEDGED", "RECEIVED"],
            // Legacy compat
            ["ORDERED", "INVOICED"],
            ["ORDERED", "RECEIVED"],
            ["ORDERED", "CANCELLED"],
            // Invoice / fulfillment pipeline
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
        expect(() => assertValidTransition("REVIEW", "UNKNOWN_STATE")).toThrow(
            /Invalid PO lifecycle transition/
        );
    });
});

// ---------------------------------------------------------------------------
// Best-effort functions (never throw)
// ---------------------------------------------------------------------------
describe("getLifecycleState (best-effort)", () => {
    it("returns null or a valid state string without throwing", async () => {
        const result = await getLifecycleState("PO-001");
        const validStates = [...PO_LIFECYCLE_STATES, null];
        expect(validStates).toContain(result);
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
            transitionLifecycleState("PO-001", "REVIEW", "test")
        ).resolves.toBeUndefined();
    });

    it("handles invalid transitions by silently returning", async () => {
        await expect(
            transitionLifecycleState("PO-001", "CANCELLED", "test")
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
    it("has exactly 9 states in correct order", () => {
        expect(PO_LIFECYCLE_STATES).toEqual([
            "ORDERED",        // legacy — kept for backward-compat
            "REVIEW",         // draft awaiting review
            "SENT",           // dispatched to vendor
            "ACKNOWLEDGED",   // vendor confirmed
            "INVOICED",       // invoice matched
            "RECONCILED",     // invoice reconciled
            "RECEIVED",       // goods received
            "COMPLETED",      // all done
            "CANCELLED",      // cancelled
        ]);
    });

    it("each state is a non-empty string", () => {
        for (const state of PO_LIFECYCLE_STATES) {
            expect(typeof state).toBe("string");
            expect(state.length).toBeGreaterThan(0);
        }
    });

    it("INITIAL_LIFECYCLE_STATE is REVIEW", () => {
        expect(INITIAL_LIFECYCLE_STATE).toBe("REVIEW");
    });
});