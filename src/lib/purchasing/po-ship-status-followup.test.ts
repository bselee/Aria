/**
 * @file    src/lib/purchasing/po-ship-status-followup.test.ts
 * @purpose Unit tests for the ship-status candidate filter (pure, DB-free).
 * @author  Hermia
 * @created 2026-08-20
 */
import { describe, expect, it } from "vitest";
import {
    isShipStatusCandidate,
    MAX_DAYS_SINCE_ACK,
    MIN_DAYS_SINCE_ACK,
} from "./po-ship-status-followup";

const NOW = new Date("2026-08-20T15:00:00Z").getTime();
const DAY = 86_400_000;

function basePo(overrides: Record<string, unknown> = {}) {
    return {
        vendor_acknowledged_at: new Date(NOW - 10 * DAY).toISOString(), // acked 10d ago
        tracking_numbers: [],
        tracking_requested_at: null,
        vendor_noncomm_at: null,
        receive_date: null,
        status: "open",
        ...overrides,
    };
}

describe("isShipStatusCandidate", () => {
    it("qualifies an acked PO with no tracking inside the window", () => {
        const v = isShipStatusCandidate(basePo(), NOW);
        expect(v).toEqual({ ok: true });
    });

    it("rejects POs with no vendor acknowledgment", () => {
        const v = isShipStatusCandidate(basePo({ vendor_acknowledged_at: null }), NOW);
        expect(v.ok).toBe(false);
        expect(v.reason).toBe("no_ack");
    });

    it("rejects POs acked too recently", () => {
        const fresh = new Date(NOW - (MIN_DAYS_SINCE_ACK - 1) * DAY).toISOString();
        const v = isShipStatusCandidate(basePo({ vendor_acknowledged_at: fresh }), NOW);
        expect(v.reason).toBe("too_early");
    });

    it("rejects POs aged out of the window", () => {
        const stale = new Date(NOW - (MAX_DAYS_SINCE_ACK + 1) * DAY).toISOString();
        const v = isShipStatusCandidate(basePo({ vendor_acknowledged_at: stale }), NOW);
        expect(v.reason).toBe("aged_out");
    });

    it("rejects POs that already have tracking", () => {
        const v = isShipStatusCandidate(basePo({ tracking_numbers: ["1Z999AA10123456784"] }), NOW);
        expect(v.reason).toBe("has_tracking");
    });

    it("rejects POs where tracking was already requested", () => {
        const v = isShipStatusCandidate(
            basePo({ tracking_requested_at: new Date(NOW - DAY).toISOString() }),
            NOW,
        );
        expect(v.reason).toBe("already_requested");
    });

    // ── tracking_requested_at vs vendor_acknowledged_at semantics ─────────
    // po-followup-watcher's L1 48h receipt check ("just making sure you
    // received PO #X") ALSO stamps tracking_requested_at — and that draft can
    // predate the vendor's ack. The ship-status ask must still fire then;
    // only a stamp that postdates the ack (or a stamp with no ack to compare
    // against) counts as "tracking already requested" (Novelty/125172 case).

    it("allows a PO whose tracking_requested_at stamp predates the ack (L1 receipt check)", () => {
        const ackedAt = new Date(NOW - 10 * DAY).toISOString();
        const v = isShipStatusCandidate(
            basePo({
                vendor_acknowledged_at: ackedAt,
                // L1 receipt-check draft went out 12d ago; vendor acked 10d ago.
                tracking_requested_at: new Date(NOW - 12 * DAY).toISOString(),
            }),
            NOW,
        );
        expect(v).toEqual({ ok: true });
    });

    it("rejects a PO where tracking was requested after the ack", () => {
        const ackedAt = new Date(NOW - 10 * DAY).toISOString();
        const v = isShipStatusCandidate(
            basePo({
                vendor_acknowledged_at: ackedAt,
                // Tracking request drafted 1d after the vendor's ack.
                tracking_requested_at: new Date(NOW - 9 * DAY).toISOString(),
            }),
            NOW,
        );
        expect(v.reason).toBe("already_requested");
    });

    it("rejects a PO with tracking_requested_at set but no ack to compare against", () => {
        const v = isShipStatusCandidate(
            basePo({
                vendor_acknowledged_at: null,
                tracking_requested_at: new Date(NOW - DAY).toISOString(),
            }),
            NOW,
        );
        expect(v.reason).toBe("already_requested");
    });

    it("rejects a PO with an unparseable tracking_requested_at (defensive)", () => {
        const v = isShipStatusCandidate(
            basePo({ tracking_requested_at: "not-a-date" }),
            NOW,
        );
        expect(v.reason).toBe("already_requested");
    });

    it("rejects POs marked vendor noncomm", () => {
        const v = isShipStatusCandidate(
            basePo({ vendor_noncomm_at: new Date(NOW - 2 * DAY).toISOString() }),
            NOW,
        );
        expect(v.reason).toBe("noncomm");
    });

    it("rejects received POs by status", () => {
        const v = isShipStatusCandidate(basePo({ status: "received" }), NOW);
        expect(v.reason).toBe("received");
    });

    it("rejects received POs by past receive_date", () => {
        const v = isShipStatusCandidate(
            basePo({ receive_date: new Date(NOW - DAY).toISOString() }),
            NOW,
        );
        expect(v.reason).toBe("received");
    });

    it("allows a future receive_date (scheduled, not received)", () => {
        const v = isShipStatusCandidate(
            basePo({ receive_date: new Date(NOW + 5 * DAY).toISOString() }),
            NOW,
        );
        expect(v.ok).toBe(true);
    });

    it("rejects a PO with receipt scheduled within 3 days", () => {
        const v = isShipStatusCandidate(
            basePo({ receive_date: new Date(NOW + 2 * DAY).toISOString() }),
            NOW,
        );
        expect(v.reason).toBe("receipt_scheduled_soon");
    });

    // ── Read-then-act race guard semantics ────────────────────────────────
    // runShipStatusFollowup re-runs isShipStatusCandidate with a FRESH clock
    // immediately before drafting. These prove the verdict flips exactly as
    // the guard depends on when a PO loses eligibility mid-scan (PO 125170:
    // RECEIVED + receive_date landed while the slow lookups ran).

    it("flips from candidate to rejected when receive_date passes mid-scan", () => {
        // Snapshot: receive_date is 5 days out — qualifies at run start
        // (outside the 3-day receipt window).
        const po = basePo({ receive_date: new Date(NOW + 5 * DAY).toISOString() });
        expect(isShipStatusCandidate(po, NOW).ok).toBe(true);

        // Fresh re-check: the receive landed while Gmail/email lookups ran.
        const v = isShipStatusCandidate(po, NOW + 6 * DAY);
        expect(v).toEqual({ ok: false, reason: "received" });
    });

    it("flips from candidate to rejected when status flips to received mid-scan", () => {
        const po = basePo(); // status: "open" at snapshot
        expect(isShipStatusCandidate(po, NOW).ok).toBe(true);

        const flipped = { ...po, status: "received" }; // fresh row from DB
        const v = isShipStatusCandidate(flipped, NOW + DAY);
        expect(v).toEqual({ ok: false, reason: "received" });
    });

    it("rejects a receipt scheduled within 3 days under a fresh clock", () => {
        // Snapshot: receive_date 6 days out — still a candidate.
        const po = basePo({ receive_date: new Date(NOW + 6 * DAY).toISOString() });
        expect(isShipStatusCandidate(po, NOW).ok).toBe(true);

        // Fresh re-check: the vendor moved the ETA inside the 3-day window.
        const v = isShipStatusCandidate(po, NOW + 4 * DAY);
        expect(v).toEqual({ ok: false, reason: "receipt_scheduled_soon" });
    });
});
