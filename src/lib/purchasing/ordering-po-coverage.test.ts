/**
 * @file    ordering-po-coverage.test.ts
 * @purpose Unit tests for Ordering recent-PO coverage overlay.
 * @author  Hermia
 * @created 2026-08-06
 */
import { describe, expect, it } from "vitest";
import {
    AGED_PO_BLOCK_DAYS,
    PO_ANOMALY_FLOOR_DAYS,
    agedPoBlockReason,
    anomalousCoverNote,
    buildRecentOpenCoverageByProduct,
    findAgedSilentOpenPo,
    isAgedSilentOpenPo,
    isAnomalousOpenPo,
    isDraftOrderingStatus,
    isOpenOrderingStatus,
    isTerminalOrderingStatus,
    mergeOpenPOsWithRecentCoverage,
    partitionOpenPOsByAnomaly,
    poAgeDays,
    poAnomalyThresholdDays,
} from "./ordering-po-coverage";

describe("ordering-po-coverage status classifiers", () => {
    it("treats cancel/complete as terminal", () => {
        expect(isTerminalOrderingStatus("Cancelled")).toBe(true);
        expect(isTerminalOrderingStatus("ORDER_COMPLETED")).toBe(true);
        expect(isTerminalOrderingStatus("Committed")).toBe(false);
    });

    it("detects drafts", () => {
        expect(isDraftOrderingStatus("Created")).toBe(true);
        expect(isDraftOrderingStatus("ORDER_CREATED")).toBe(true);
        expect(isDraftOrderingStatus("Draft")).toBe(true);
        expect(isDraftOrderingStatus("Committed")).toBe(false);
    });

    it("treats committed/locked/sent as open coverage", () => {
        expect(isOpenOrderingStatus("Committed")).toBe(true);
        expect(isOpenOrderingStatus("ORDER_LOCKED")).toBe(true);
        expect(isOpenOrderingStatus("Sent")).toBe(true);
        expect(isOpenOrderingStatus("Acknowledged")).toBe(true);
        expect(isOpenOrderingStatus("Completed")).toBe(false);
        expect(isOpenOrderingStatus("Cancelled")).toBe(false);
    });
});

describe("buildRecentOpenCoverageByProduct", () => {
    it("indexes draft + committed POs so post-commit SKUs stay covered", () => {
        const map = buildRecentOpenCoverageByProduct([
            {
                orderId: "1001",
                status: "Created",
                orderDate: "2026-08-06",
                vendorName: "Sustainable Village",
                items: [
                    { productId: "BLM221", quantity: 150 },
                    { productId: "ALK101", quantity: 200 },
                ],
            },
            {
                orderId: "1002",
                status: "Committed",
                orderDate: "2026-08-06",
                vendorName: "Sustainable Village",
                items: [
                    { productId: "BLM212", quantity: 70 },
                ],
            },
            {
                orderId: "999",
                status: "Completed",
                orderDate: "2026-01-01",
                items: [{ productId: "BLM221", quantity: 9999 }],
            },
        ]);

        const blm221 = map.get("BLM221");
        expect(blm221?.totalQty).toBe(150);
        expect(blm221?.draft?.orderId).toBe("1001");
        expect(blm221?.openHits).toHaveLength(0);

        const blm212 = map.get("BLM212");
        expect(blm212?.totalQty).toBe(70);
        expect(blm212?.draft).toBeNull();
        expect(blm212?.openHits[0]?.orderId).toBe("1002");

        // Completed PO must not suppress Ordering
        expect(blm221?.totalQty).not.toBe(9999 + 150);
    });

    it("sums multiple open POs for the same SKU", () => {
        const map = buildRecentOpenCoverageByProduct([
            {
                orderId: "A",
                status: "Committed",
                items: [{ productId: "SKU1", quantity: 40 }],
            },
            {
                orderId: "B",
                status: "Locked",
                items: [{ productId: "SKU1", quantity: 60 }],
            },
        ]);
        expect(map.get("SKU1")?.totalQty).toBe(100);
        expect(map.get("SKU1")?.openHits).toHaveLength(2);
    });

    // HERMIA(2026-10-28): BASLCE102 phantom-cover regression. Finale
    // productUnitsRemainingToBeShipped is the receipt truth — coverage must
    // never credit more than the unshipped remainder, or received goods are
    // counted twice and the SKU is held off the board.
    it("credits only the unshipped remainder when remainingQty is present", () => {
        const map = buildRecentOpenCoverageByProduct([
            {
                orderId: "125379",
                status: "Committed",
                items: [{ productId: "BASLCE102", quantity: 20, remainingQty: 0 }],
            },
            {
                orderId: "125408",
                status: "Committed",
                items: [{ productId: "BASLCE103", quantity: 50, remainingQty: 24 }],
            },
        ]);
        // Fully received line on an uncompleted PO credits nothing.
        expect(map.has("BASLCE102")).toBe(false);
        // Partial receipt credits only what is left to ship.
        expect(map.get("BASLCE103")?.totalQty).toBe(24);
        expect(map.get("BASLCE103")?.openHits[0]?.quantity).toBe(24);
    });

    it("fails open to ordered qty when remainingQty is absent", () => {
        const map = buildRecentOpenCoverageByProduct([
            {
                orderId: "X",
                status: "Committed",
                items: [{ productId: "SKU9", quantity: 40 }],
            },
        ]);
        expect(map.get("SKU9")?.totalQty).toBe(40);
    });

    it("caps over-receipt (negative remaining) at zero credit", () => {
        const map = buildRecentOpenCoverageByProduct([
            {
                orderId: "125289",
                status: "Committed",
                items: [{ productId: "RAWWHOLEGNARBAR", quantity: 2000, remainingQty: -39 }],
            },
        ]);
        expect(map.has("RAWWHOLEGNARBAR")).toBe(false);
    });
});

describe("mergeOpenPOsWithRecentCoverage", () => {
    it("merges committed recent hits into empty GraphQL openPOs (stale SWR gap)", () => {
        const coverage = buildRecentOpenCoverageByProduct([
            {
                orderId: "125000",
                status: "Committed",
                orderDate: "2026-08-06",
                items: [{ productId: "BLM221", quantity: 150 }],
            },
        ]).get("BLM221");

        const merged = mergeOpenPOsWithRecentCoverage([], coverage);
        expect(merged).toEqual([
            { orderId: "125000", quantity: 150, orderDate: "2026-08-06" },
        ]);
    });

    it("keeps the larger qty when both sources have the same PO", () => {
        const coverage = buildRecentOpenCoverageByProduct([
            {
                orderId: "1",
                status: "Committed",
                orderDate: "2026-08-01",
                items: [{ productId: "X", quantity: 200 }],
            },
        ]).get("X");

        const merged = mergeOpenPOsWithRecentCoverage(
            [{ orderId: "1", quantity: 50, orderDate: "2026-08-01" }],
            coverage,
        );
        expect(merged).toEqual([{ orderId: "1", quantity: 200, orderDate: "2026-08-01" }]);
    });
});

describe("aged-PO anomaly", () => {
    // Fixed clock: 2026-10-15 12:00Z. Dates are emitted at 00:00Z so an age is
    // exactly n days and the boundary assertions cannot drift with time of day.
    const NOW = Date.parse("2026-10-15T12:00:00Z");
    const daysAgo = (n: number): string =>
        new Date(NOW - n * 86_400_000).toISOString().slice(0, 10) + "T00:00:00";

    it("parses both date shapes this code sees", () => {
        // Finale ISO shape
        expect(poAgeDays("2026-10-14T18:00:00", NOW)).toBe(0);
        expect(poAgeDays("2026-10-15", NOW)).toBe(0);
        // Scan openPOs shape (M/D/YYYY)
        expect(poAgeDays("10/15/2026", NOW)).toBe(0);
        expect(poAgeDays("10/14/2026", NOW)).toBe(1);
        expect(poAgeDays("2/11/2026", NOW)).toBe(246);
        // No evidence about age is not age 0
        expect(poAgeDays("", NOW)).toBeNull();
        expect(poAgeDays(null, NOW)).toBeNull();
        expect(poAgeDays("not a date", NOW)).toBeNull();
    });

    it("flags DASH101's real POs as anomalies", () => {
        // 125349 ordered 2/11/26 against an 11-day lead: 246d open.
        expect(isAnomalousOpenPo("2/11/2026", 11, NOW)).toBe(true);
        expect(isAnomalousOpenPo("6/19/2026", 11, NOW)).toBe(true);
    });

    it("uses the greater of the floor and twice the lead time", () => {
        expect(poAnomalyThresholdDays(0)).toBe(PO_ANOMALY_FLOOR_DAYS);
        expect(poAnomalyThresholdDays(11)).toBe(PO_ANOMALY_FLOOR_DAYS); // 22 < 45
        expect(poAnomalyThresholdDays(60)).toBe(120); // long-lead bulk
        // Gypsum: 120d lead, 154d open. Long lead, still inside its envelope.
        expect(isAnomalousOpenPo(daysAgo(154), 120, NOW)).toBe(false);
        // Same PO on a short-lead product is an anomaly.
        expect(isAnomalousOpenPo(daysAgo(154), 7, NOW)).toBe(true);
    });

    it("does not treat a fresh order as an anomaly", () => {
        expect(isAnomalousOpenPo(daysAgo(10), 21, NOW)).toBe(false);
        expect(isAnomalousOpenPo(daysAgo(44), 0, NOW)).toBe(false); // just inside the floor
        expect(isAnomalousOpenPo(daysAgo(46), 0, NOW)).toBe(true); // just past it
    });

    it("never calls a missing date an anomaly", () => {
        expect(isAnomalousOpenPo("", 0, NOW)).toBe(false);
        expect(isAnomalousOpenPo(undefined, 0, NOW)).toBe(false);
    });

    it("partitions cover into credible and anomalous", () => {
        const { credible, anomalous } = partitionOpenPOsByAnomaly(
            [
                { orderId: "125353", quantity: 160, orderDate: daysAgo(118) },
                { orderId: "125349", quantity: 40, orderDate: daysAgo(246) },
                { orderId: "126001", quantity: 500, orderDate: daysAgo(3) },
            ],
            11,
            NOW,
        );
        expect(credible.map((p) => p.orderId)).toEqual(["126001"]);
        expect(anomalous.map((p) => p.orderId)).toEqual(["125353", "125349"]);
        expect(anomalous.map((p) => p.ageDays)).toEqual([118, 246]);
        // The credible sum is what the decision may use as cover.
        expect(credible.reduce((s, p) => s + p.quantity, 0)).toBe(500);
    });

    it("names the oldest PO and the action in the row note", () => {
        const note = anomalousCoverNote([
            { orderId: "125353", ageDays: 118 },
            { orderId: "125349", ageDays: 246 },
        ]);
        expect(note).toContain("#125349");
        expect(note).toContain("118-246d");
        expect(note).toContain("not counted as cover");
        expect(note).toContain("Assess in Finale");
        // Single PO reads without a span.
        expect(anomalousCoverNote([{ orderId: "125016", ageDays: 112 }]))
            .toBe("Anomaly: PO #125016 open 112d, never received; not counted as cover. Assess in Finale.");
        expect(anomalousCoverNote([])).toBe("");
    });
});

describe("aged silent PO commit blocker (WS6.2)", () => {
    // Fixed clock: 2026-10-29 12:00Z. Ages are exact because the dates are
    // emitted at 00:00Z, so the 14d boundary cannot drift with time of day.
    const NOW = Date.parse("2026-10-29T12:00:00Z");
    const daysAgoIso = (n: number): string =>
        new Date(NOW - n * 86_400_000).toISOString().slice(0, 10) + "T00:00:00";

    const po = (orderId = "125283", orderDate?: string) => ({ orderId, orderDate });

    it("keeps the 14-day bar as a single named constant", () => {
        expect(AGED_PO_BLOCK_DAYS).toBe(14);
    });

    it("does not block at exactly 14 days, blocks at 15", () => {
        // Boundary is strict (> 14), so a PO issued 14 days ago is still in window.
        expect(isAgedSilentOpenPo(po("125283"), { issueDate: daysAgoIso(14) }, NOW)).toBeNull();
        expect(isAgedSilentOpenPo(po("125283"), { issueDate: daysAgoIso(15) }, NOW))
            .toEqual({ orderId: "125283", ageDays: 15 });
    });

    it("blocks the real case: 125283 issued 9/9, no tracking, no receipt", () => {
        // issue_date from purchase_orders: 2026-09-09T00:00:00-06:00
        const hit = isAgedSilentOpenPo(
            po("125283", "9/9/2026"),
            { issueDate: "2026-09-09T00:00:00-06:00", trackingNumbers: [], receiveDate: null },
            NOW,
        );
        expect(hit).toEqual({ orderId: "125283", ageDays: 50 });
        expect(agedPoBlockReason(hit!))
            .toBe("resolve PO 125283 first (open 50d, no tracking): chase or cancel");
    });

    it("treats missing/empty/blank tracking_numbers as still silent", () => {
        for (const trackingNumbers of [null, undefined, [], ["", "   "]]) {
            expect(isAgedSilentOpenPo(
                po(), { issueDate: daysAgoIso(20), trackingNumbers, receiveDate: null }, NOW,
            )).toEqual({ orderId: "125283", ageDays: 20 });
        }
    });

    it("never blocks a PO that has any tracking number", () => {
        expect(isAgedSilentOpenPo(
            po(), { issueDate: daysAgoIso(60), trackingNumbers: ["1Z2914E20328399847"] }, NOW,
        )).toBeNull();
    });

    it("never blocks a PO with a receive date, however old", () => {
        expect(isAgedSilentOpenPo(
            po(), { issueDate: daysAgoIso(120), trackingNumbers: [], receiveDate: "2026-09-30" }, NOW,
        )).toBeNull();
        // A future receive date is still a receipt on the record.
        expect(isAgedSilentOpenPo(
            po(), { issueDate: daysAgoIso(120), receiveDate: "2026-11-15" }, NOW,
        )).toBeNull();
    });

    it("prefers issue_date and falls back to the payload orderDate", () => {
        // issue_date wins: 30d beats a 3d payload date.
        expect(isAgedSilentOpenPo(
            po("125283", daysAgoIso(3)), { issueDate: daysAgoIso(30), trackingNumbers: [] }, NOW,
        )).toEqual({ orderId: "125283", ageDays: 30 });
        // No issue_date on the row → the payload date decides.
        expect(isAgedSilentOpenPo(
            po("125283", daysAgoIso(15)), { issueDate: null, trackingNumbers: [] }, NOW,
        )).toEqual({ orderId: "125283", ageDays: 15 });
    });

    it("fails open on missing evidence (no facts row, no date, no id)", () => {
        // No purchase_orders row for this PO → nothing known → no block.
        expect(isAgedSilentOpenPo(po(), null, NOW)).toBeNull();
        expect(isAgedSilentOpenPo(po(), undefined, NOW)).toBeNull();
        // No parseable date anywhere → age unknown → no block.
        expect(isAgedSilentOpenPo(po(), { trackingNumbers: [] }, NOW)).toBeNull();
        expect(isAgedSilentOpenPo(po("", undefined), { issueDate: daysAgoIso(30) }, NOW)).toBeNull();
        expect(isAgedSilentOpenPo(null, { issueDate: daysAgoIso(30) }, NOW)).toBeNull();
        expect(isAgedSilentOpenPo(po(), { issueDate: "not a date", trackingNumbers: [] }, NOW)).toBeNull();
    });

    it("picks the oldest aged-silent PO on the row (Map and Record lookups)", () => {
        const openPOs = [
            { orderId: "125400", quantity: 100, orderDate: "10/20/2026" },
            { orderId: "125283", quantity: 900, orderDate: "9/9/2026" },
            { orderId: "125500", quantity: 50, orderDate: "10/26/2026" },
        ];
        const facts = {
            "125400": { issueDate: daysAgoIso(9), trackingNumbers: [] as string[] },
            "125283": { issueDate: daysAgoIso(50), trackingNumbers: [] as string[] },
            // fresh, so not aged at all
            "125500": { issueDate: daysAgoIso(3), trackingNumbers: [] as string[] },
        };
        expect(findAgedSilentOpenPo(openPOs, facts, NOW))
            .toEqual({ orderId: "125283", ageDays: 50 });
        expect(findAgedSilentOpenPo(openPOs, new Map(Object.entries(facts)), NOW))
            .toEqual({ orderId: "125283", ageDays: 50 });
    });

    it("returns null when no PO on the row is aged AND silent", () => {
        expect(findAgedSilentOpenPo([], { "125283": {} }, NOW)).toBeNull();
        expect(findAgedSilentOpenPo(null, { "125283": {} }, NOW)).toBeNull();
        expect(findAgedSilentOpenPo([{ orderId: "125283" }], null, NOW)).toBeNull();
        // Aged but tracked.
        expect(findAgedSilentOpenPo(
            [{ orderId: "125283" }],
            { "125283": { issueDate: daysAgoIso(50), trackingNumbers: ["1Z999"] } },
            NOW,
        )).toBeNull();
        // Silent but fresh.
        expect(findAgedSilentOpenPo(
            [{ orderId: "125600" }],
            { "125600": { issueDate: daysAgoIso(2), trackingNumbers: [] } },
            NOW,
        )).toBeNull();
        // No facts row for any open PO → fail open.
        expect(findAgedSilentOpenPo([{ orderId: "125283" }], {}, NOW)).toBeNull();
    });
});
