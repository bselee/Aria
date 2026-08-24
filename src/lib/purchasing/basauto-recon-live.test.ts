/**
 * @file    src/lib/purchasing/basauto-recon-live.test.ts
 * @purpose Contract tests for the live verdict recompute — proves the row
 *          badge re-assesses against the row's CURRENT Aria state instead of
 *          trusting the 07:00 crawl snapshot (the drift bug: a PO drafted at
 *          10 AM left the morning verdict wrong all afternoon).
 *
 * @author  Hermia
 * @created 2026-08-24
 */

import { describe, it, expect } from "vitest";
import { recomputeBasautoBadge } from "./basauto-recon-live";
import type { ReconBadge } from "./basauto-recon-lookup";

const CRAWLED_AT = "2026-08-24T13:00:00.000Z";

function badge(overrides: Partial<ReconBadge> = {}): ReconBadge {
    return {
        basautoQty: 277,
        basautoUrgency: "Overdue",
        verdict: "QTY_MISMATCH",
        severity: "medium",
        reason: "snapshot reason",
        crawledAt: CRAWLED_AT,
        basauto: {
            urgency: "Overdue",
            stockDaysLeft: 5,
            reorderQty: 277,
            reorderDate: "2026-08-26",
            velocity: 3,
            onOrder: 0,
        },
        ...overrides,
    };
}

function liveAria(overrides: Partial<Parameters<typeof recomputeBasautoBadge>[1]> = {}): Parameters<typeof recomputeBasautoBadge>[1] {
    return {
        productId: "ALK101",
        urgency: "warning",
        stockOnHand: 40,
        stockOnOrder: 0,
        dailyRate: 2,
        dailyRateSource: "demand",
        leadTimeDays: 21,
        effectiveLeadTimeDays: 21,
        adjustedRunwayDays: 20,
        runwayDays: 20,
        openPOs: [],
        suggestedQty: 80,
        ...overrides,
    };
}

describe("recomputeBasautoBadge", () => {
    it("flips QTY_MISMATCH to OVERBUY_RISK when a PO drafted since the crawl covers the need", () => {
        // Morning crawl: no PO, both flagged, quantities disagreed.
        // Live: PO committed (150 inbound) + 101 on hand covers the 30-day
        // need (2/day × 30 = 60) — do not re-buy.
        const out = recomputeBasautoBadge(
            badge(),
            liveAria({
                urgency: "ok",
                stockOnHand: 101,
                stockOnOrder: 150,
                openPOs: [{ orderId: "125215", quantity: 150, orderDate: "2026-08-24" }],
                suggestedQty: 0,
            }),
            CRAWLED_AT,
        );
        expect(out).not.toBeNull();
        expect(out!.verdict).toBe("OVERBUY_RISK");
        expect(out!.severity).toBe("high");
        expect(out!.live).toBe(true);
        expect(out!.reason).toContain("Do not re-buy");
    });

    it("drops the badge entirely when both systems are calm against live numbers", () => {
        // Snapshot said ARIA_ONLY (basauto OK, Aria flagged). Live Aria is now
        // calm too — nothing to show.
        const snap = badge({
            verdict: "ARIA_ONLY",
            severity: "medium",
            basautoUrgency: "OK",
            basauto: { urgency: "OK", stockDaysLeft: 90, reorderQty: 0, reorderDate: null, velocity: 0.5, onOrder: 0 },
        });
        const out = recomputeBasautoBadge(snap, liveAria({ urgency: "ok" }), CRAWLED_AT);
        expect(out).toBeNull();
    });

    it("keeps a real disagreement but stamps it live with a fresh reason", () => {
        // Both systems still flag against live numbers, quantities disagree
        // (>50%) — the verdict legitimately stays QTY_MISMATCH, but the reason
        // is re-derived from the live row rather than the snapshot text.
        const out = recomputeBasautoBadge(badge(), liveAria(), CRAWLED_AT);
        expect(out).not.toBeNull();
        expect(out!.live).toBe(true);
        expect(out!.crawledAt).toBe(CRAWLED_AT);
        expect(out!.verdict).toBe("QTY_MISMATCH");
        expect(out!.reason).toContain("quantities disagree");
        expect(out!.reason).toContain("Aria 80");
    });

    it("re-verdicts to BORDERLINE when Aria is calm but runway sits inside 2× lead", () => {
        // basauto Overdue, Aria ok with runway 30d vs 21d lead (inside 2×), no
        // PO, velocity within gap — the morning QTY_MISMATCH is gone because
        // live Aria no longer flags; what remains is a manual-review call.
        const out = recomputeBasautoBadge(
            badge(),
            liveAria({
                urgency: "ok",
                stockOnHand: 40,
                stockOnOrder: 0,
                openPOs: [],
                adjustedRunwayDays: 30,
                runwayDays: 30,
                suggestedQty: 80,
            }),
            CRAWLED_AT,
        );
        expect(out).not.toBeNull();
        expect(out!.verdict).toBe("BORDERLINE");
        expect(out!.live).toBe(true);
        expect(out!.reason).toContain("Review manually");
    });

    it("keeps ARIA_ONLY with a live reason when Aria still flags and basauto is calm", () => {
        const snap = badge({
            verdict: "ARIA_ONLY",
            basautoUrgency: "OK",
            basauto: { urgency: "OK", stockDaysLeft: 90, reorderQty: 0, reorderDate: null, velocity: 0.5, onOrder: 0 },
        });
        const out = recomputeBasautoBadge(snap, liveAria({ urgency: "critical" }), CRAWLED_AT);
        expect(out!.verdict).toBe("ARIA_ONLY");
        expect(out!.live).toBe(true);
        expect(out!.reason).toContain("BOM/FG-traceback demand");
    });

    it("returns the snapshot badge unchanged when the basauto side is missing", () => {
        const snap = badge({ basauto: null });
        expect(recomputeBasautoBadge(snap, liveAria(), CRAWLED_AT)).toBe(snap);
    });
});
