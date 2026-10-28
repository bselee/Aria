/**
 * @file    src/lib/tracking/accuracy-report.test.ts
 * @purpose Pure computation for the weekly tracking accuracy report.
 * @author  Hermia
 * @created 2026-10-28
 */
import { describe, expect, it } from "vitest";
import { buildAccuracyReport, type TrackingAccuracySnapshot } from "./accuracy-report";

const base: TrackingAccuracySnapshot = {
    deliveredLast7d: 100,
    deliveredWithEta: 40,
    etaSameDay: 30,
    etaLate: 8,
    etaEarly: 2,
    nonDelivered: 200,
    nonDeliveredStale24h: 50,
    ofdCount: 3,
};

describe("buildAccuracyReport", () => {
    it("computes coverage, on-time and staleness percentages", () => {
        const r = buildAccuracyReport(base);
        expect(r.etaCoveragePct).toBe(40);
        expect(r.onTimePct).toBe(75); // 30 of 40 ETA rows
        expect(r.stalePct).toBe(25); // 50 of 200
    });

    it("returns null on-time when no ETA rows exist", () => {
        const r = buildAccuracyReport({ ...base, deliveredWithEta: 0, etaSameDay: 0, etaLate: 0, etaEarly: 0 });
        expect(r.onTimePct).toBeNull();
    });

    it("handles an empty week without division errors", () => {
        const r = buildAccuracyReport({
            deliveredLast7d: 0,
            deliveredWithEta: 0,
            etaSameDay: 0,
            etaLate: 0,
            etaEarly: 0,
            nonDelivered: 0,
            nonDeliveredStale24h: 0,
            ofdCount: 0,
        });
        expect(r.etaCoveragePct).toBe(0);
        expect(r.stalePct).toBe(0);
        expect(r.summary).toContain("tracking accuracy");
    });
});
