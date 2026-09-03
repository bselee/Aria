/**
 * @file    src/lib/purchasing/lifecycle-backfill.test.ts
 * @purpose Unit tests for the pure lifecycle corruption-backfill logic.
 * @author  aria-coder
 * @created 2026-08-12
 */
import { describe, expect, it } from "vitest";

import {
    determineCorrectStage,
    type LifecycleBackfillRow,
} from "./lifecycle-backfill";
import { statusForLifecycleStage } from "./po-lifecycle";

function row(overrides: Partial<LifecycleBackfillRow> = {}): LifecycleBackfillRow {
    return {
        poNumber: "PO-001",
        status: null,
        lifecycleState: null,
        lifecycleStage: null,
        lifecycleStageLegacy: null,
        hasReceiptEvidence: false,
        hasInvoice: false,
        vendorAcknowledged: false,
        wasSent: false,
        ...overrides,
    };
}

describe("statusForLifecycleStage", () => {
    it("maps RECEIVED -> received", () => {
        expect(statusForLifecycleStage("RECEIVED")).toBe("received");
    });
    it("maps CANCELLED and COMPLETED -> closed", () => {
        expect(statusForLifecycleStage("CANCELLED")).toBe("closed");
        expect(statusForLifecycleStage("COMPLETED")).toBe("closed");
    });
    it("maps everything else -> open", () => {
        for (const s of ["REVIEW", "SENT", "ACKNOWLEDGED", "INVOICED", "RECONCILED"]) {
            expect(statusForLifecycleStage(s)).toBe("open");
        }
    });
});

describe("determineCorrectStage — receipt evidence", () => {
    it("keeps RECEIVED when receipt evidence exists", () => {
        const d = determineCorrectStage(row({ lifecycleState: "RECEIVED", hasReceiptEvidence: true }));
        expect(d.stage).toBe("RECEIVED");
        expect(d.changed).toBe(false);
        expect(d.isCorruptionFix).toBe(false);
    });

    it("raises a non-RECEIVED row to RECEIVED when receipt evidence exists", () => {
        const d = determineCorrectStage(row({ lifecycleState: "SENT", hasReceiptEvidence: true }));
        expect(d.stage).toBe("RECEIVED");
        expect(d.changed).toBe(true);
    });
});

describe("determineCorrectStage — cancelled", () => {
    it("treats Finale status='closed' as CANCELLED (no receipt)", () => {
        const d = determineCorrectStage(row({ status: "closed", lifecycleState: "RECEIVED" }));
        expect(d.stage).toBe("CANCELLED");
    });

    it("treats lifecycle_stage=CANCELLED as CANCELLED", () => {
        const d = determineCorrectStage(row({ lifecycleStage: "CANCELLED", lifecycleState: "RECEIVED" }));
        expect(d.stage).toBe("CANCELLED");
    });

    it("Finale-closed wins over receipt evidence (closed is terminal)", () => {
        const d = determineCorrectStage(row({ status: "closed", hasReceiptEvidence: true }));
        expect(d.stage).toBe("CANCELLED");
    });
});

describe("determineCorrectStage — corruption un-stamp", () => {
    it("restores from lifecycle_stage_legacy (l3_escalated -> SENT)", () => {
        const d = determineCorrectStage(
            row({ lifecycleState: "RECEIVED", lifecycleStageLegacy: "l3_escalated" })
        );
        expect(d.stage).toBe("SENT");
        expect(d.isCorruptionFix).toBe(true);
        expect(d.changed).toBe(true);
    });

    it("restores from lifecycle_stage when legacy is NULL", () => {
        const d = determineCorrectStage(
            row({ lifecycleState: "RECEIVED", lifecycleStage: "ACKNOWLEDGED" })
        );
        expect(d.stage).toBe("ACKNOWLEDGED");
        expect(d.isCorruptionFix).toBe(true);
    });

    it("falls back to INVOICED when both snapshots are RECEIVED (double-stamped)", () => {
        const d = determineCorrectStage(
            row({ lifecycleState: "RECEIVED", lifecycleStage: "RECEIVED", hasInvoice: true })
        );
        expect(d.stage).toBe("INVOICED");
        expect(d.isCorruptionFix).toBe(true);
    });

    it("falls back to REVIEW when no evidence at all", () => {
        const d = determineCorrectStage(
            row({ lifecycleState: "RECEIVED", lifecycleStage: "RECEIVED" })
        );
        expect(d.stage).toBe("REVIEW");
        expect(d.isCorruptionFix).toBe(true);
    });
});

describe("determineCorrectStage — normal path", () => {
    it("keeps a canonical non-RECEIVED lifecycle_state", () => {
        const d = determineCorrectStage(row({ lifecycleState: "INVOICED" }));
        expect(d.stage).toBe("INVOICED");
        expect(d.changed).toBe(false);
    });

    it("keeps terminal COMPLETED even with receipt evidence (sticky)", () => {
        const d = determineCorrectStage(row({ lifecycleState: "COMPLETED", hasReceiptEvidence: true, status: "received" }));
        expect(d.stage).toBe("COMPLETED");
        expect(d.changed).toBe(false);
    });

    it("keeps terminal CANCELLED even with receipt evidence (sticky)", () => {
        const d = determineCorrectStage(row({ lifecycleState: "CANCELLED", hasReceiptEvidence: true }));
        expect(d.stage).toBe("CANCELLED");
        expect(d.changed).toBe(false);
    });

    it("uses lifecycle_stage when lifecycle_state is NULL", () => {
        const d = determineCorrectStage(row({ lifecycleStage: "SENT" }));
        expect(d.stage).toBe("SENT");
    });

    it("normalizes a non-canonical lifecycle_stage (moving_with_tracking -> SENT)", () => {
        const d = determineCorrectStage(row({ lifecycleStage: "moving_with_tracking" }));
        expect(d.stage).toBe("SENT");
    });

    it("defaults to REVIEW when nothing is present", () => {
        const d = determineCorrectStage(row());
        expect(d.stage).toBe("REVIEW");
    });
});
