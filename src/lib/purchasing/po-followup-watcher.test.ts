/**
 * @file    src/lib/purchasing/po-followup-watcher.test.ts
 * @purpose Unit tests for decideFollowupLevel — the L1/L2/L3 escalation
 *          ladder decision (pure, DB-free). Bill spec 2026-08-20:
 *          L1 at 48h (polite receipt check) → L2 at 5d (request tracking /
 *          ship date) → L3 at 7d (firmer escalation, alternate sourcing).
 * @author  Hermia
 * @created 2026-08-20
 */
import { describe, expect, it } from "vitest";
import { decideFollowupLevel, type FollowupLevelPO } from "./po-followup-watcher";

const NOW = new Date("2026-08-20T15:00:00Z").getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function basePo(overrides: Partial<FollowupLevelPO> = {}): FollowupLevelPO {
    return {
        tracking_requested_at: null,
        po_sent_verified_at: new Date(NOW - 2 * DAY).toISOString(), // sent 2d ago
        lifecycle_stage: null,
        ...overrides,
    };
}

describe("decideFollowupLevel", () => {
    // ── Pre-L1: 48h polite receipt check ─────────────────────────────────
    it("skips POs sent less than 48h ago", () => {
        const v = decideFollowupLevel(
            basePo({ po_sent_verified_at: new Date(NOW - 47 * HOUR).toISOString() }),
            NOW,
        );
        expect(v).toEqual({ level: "skip", reason: "recent" });
    });

    it("fires L1 at exactly 48h", () => {
        const v = decideFollowupLevel(
            basePo({ po_sent_verified_at: new Date(NOW - 48 * HOUR).toISOString() }),
            NOW,
        );
        expect(v).toEqual({ level: "l1" });
    });

    it("fires L1 for unstamped POs older than 48h", () => {
        const v = decideFollowupLevel(
            basePo({ po_sent_verified_at: new Date(NOW - 3 * DAY).toISOString() }),
            NOW,
        );
        expect(v).toEqual({ level: "l1" });
    });

    // ── Post-L1: tracking_requested_at set → L2/L3 ladder ────────────────
    it("drafts L2 at day 5 after L1 done", () => {
        const v = decideFollowupLevel(
            basePo({
                tracking_requested_at: new Date(NOW - 3 * DAY).toISOString(), // L1 stamped at day 2
                po_sent_verified_at: new Date(NOW - 5 * DAY).toISOString(),
            }),
            NOW,
        );
        expect(v).toEqual({ level: "l2" });
    });

    it("drafts L2 at day 6 after L1 done", () => {
        const v = decideFollowupLevel(
            basePo({
                tracking_requested_at: new Date(NOW - 4 * DAY).toISOString(),
                po_sent_verified_at: new Date(NOW - 6 * DAY).toISOString(),
            }),
            NOW,
        );
        expect(v).toEqual({ level: "l2" });
    });

    it("drafts L3 at day 7 after L1 done", () => {
        const v = decideFollowupLevel(
            basePo({
                tracking_requested_at: new Date(NOW - 5 * DAY).toISOString(),
                po_sent_verified_at: new Date(NOW - 7 * DAY).toISOString(),
            }),
            NOW,
        );
        expect(v).toEqual({ level: "l3" });
    });

    it("drafts L3 at day 8 after L1 done", () => {
        const v = decideFollowupLevel(
            basePo({
                tracking_requested_at: new Date(NOW - 6 * DAY).toISOString(),
                po_sent_verified_at: new Date(NOW - 8 * DAY).toISOString(),
            }),
            NOW,
        );
        expect(v).toEqual({ level: "l3" });
    });

    it("escalates an L2-stamped PO to L3 at day 7 (real ladder path)", () => {
        // The watcher stamped 'l2_escalated' at day 5-6; L3 must still fire.
        const v = decideFollowupLevel(
            basePo({
                tracking_requested_at: new Date(NOW - 5 * DAY).toISOString(),
                po_sent_verified_at: new Date(NOW - 7 * DAY).toISOString(),
                lifecycle_stage: "l2_escalated",
            }),
            NOW,
        );
        expect(v).toEqual({ level: "l3" });
    });

    it("skips a PO already staged l2 inside the L2 window (no re-draft)", () => {
        const v = decideFollowupLevel(
            basePo({
                tracking_requested_at: new Date(NOW - 4 * DAY).toISOString(),
                po_sent_verified_at: new Date(NOW - 6 * DAY).toISOString(),
                lifecycle_stage: "l2_escalated",
            }),
            NOW,
        );
        expect(v).toEqual({ level: "skip", reason: "too_early_for_l2" });
    });

    it("skips a PO already staged l3 regardless of age", () => {
        const v = decideFollowupLevel(
            basePo({
                tracking_requested_at: new Date(NOW - 6 * DAY).toISOString(),
                po_sent_verified_at: new Date(NOW - 8 * DAY).toISOString(),
                lifecycle_stage: "l3_escalated",
            }),
            NOW,
        );
        expect(v).toEqual({ level: "skip", reason: "already_escalated" });
    });

    it("skips a PO with L1 done but too early for L2", () => {
        const v = decideFollowupLevel(
            basePo({
                tracking_requested_at: new Date(NOW - 2 * DAY).toISOString(),
                po_sent_verified_at: new Date(NOW - 3 * DAY).toISOString(),
            }),
            NOW,
        );
        expect(v).toEqual({ level: "skip", reason: "too_early_for_l2" });
    });

    // ── Defensive: null/invalid dates ────────────────────────────────────
    it("skips POs with no sent date", () => {
        const v = decideFollowupLevel(basePo({ po_sent_verified_at: null }), NOW);
        expect(v).toEqual({ level: "skip", reason: "invalid_sent_date" });
    });

    it("skips POs with an unparseable sent date", () => {
        const v = decideFollowupLevel(basePo({ po_sent_verified_at: "not-a-date" }), NOW);
        expect(v).toEqual({ level: "skip", reason: "invalid_sent_date" });
    });

    it("skips a stamped PO whose sent date is unparseable", () => {
        const v = decideFollowupLevel(
            basePo({
                tracking_requested_at: new Date(NOW - 2 * DAY).toISOString(),
                po_sent_verified_at: "not-a-date",
            }),
            NOW,
        );
        expect(v).toEqual({ level: "skip", reason: "invalid_sent_date" });
    });

    it("skips a PO sent in the future (negative hours)", () => {
        const v = decideFollowupLevel(
            basePo({ po_sent_verified_at: new Date(NOW + HOUR).toISOString() }),
            NOW,
        );
        expect(v).toEqual({ level: "skip", reason: "recent" });
    });
});
