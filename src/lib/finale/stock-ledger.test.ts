/**
 * @file    src/lib/finale/stock-ledger.test.ts
 * @purpose Unit tests for the stock-ledger consumption aggregation — the
 *          determination source that does not depend on Finale's per-product
 *          reorder configuration.
 *
 *          Covers the 2026-10-13 MFG-audit rule: a manual correction
 *          (Stock change or take / Return shipment) changes the stock position
 *          but is not demand, so it may set a rate only when it is recurring and
 *          the SKU has no Build/Sale movement.
 *
 * @author  Hermia
 * @created 2026-09-30
 * @deps    vitest
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    LEDGER_ADJUST_TYPES,
    LEDGER_CONSUME_TYPES,
    LEDGER_DEMAND_TYPES,
    LEDGER_MIN_ADJUST_DAYS,
    LEDGER_SNAPSHOT_VERSION,
    deriveLedgerRate,
    fetchLedgerSnapshot,
    ledgerNetFor,
    ledgerRateFor,
    type LedgerSnapshot,
    type LedgerSku,
} from "./stock-ledger";

const TEST_DEPS = {
    apiBase: "https://example.invalid",
    accountPath: "testaccount",
    authHeader: "Basic dGVzdDp0ZXN0",
};

function ledgerPage(nodes: LedgerRowNode[], hasNextPage = false, endCursor = "c1") {
    return {
        data: {
            stockHistoryViewConnection: {
                pageInfo: { hasNextPage, endCursor },
                edges: nodes.map(node => ({ node })),
            },
        },
    };
}

interface LedgerRowNode {
    transactionType: string;
    recordDate: string;
    unitsIn: number | string | null;
    unitsOut: number | string | null;
    product: { productId?: string | null } | null;
}

function mockFetchSequence(pages: unknown[]) {
    let call = 0;
    const spy = vi.fn(async () => {
        const body = pages[Math.min(call, pages.length - 1)];
        call++;
        return { json: async () => body } as unknown as Response;
    });
    vi.stubGlobal("fetch", spy);
    return spy;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ledger movement type sets", () => {
    it("separates demand from manual correction", () => {
        // Demand is the only kind of movement allowed to set a rate.
        expect(LEDGER_DEMAND_TYPES.has("Build")).toBe(true);
        expect(LEDGER_DEMAND_TYPES.has("Sale shipment")).toBe(true);
        expect(LEDGER_DEMAND_TYPES.has("Stock change or take")).toBe(false);
        expect(LEDGER_DEMAND_TYPES.has("Return shipment")).toBe(false);

        // Manual corrections move stock but are not demand.
        expect(LEDGER_ADJUST_TYPES.has("Stock change or take")).toBe(true);
        expect(LEDGER_ADJUST_TYPES.has("Return shipment")).toBe(true);
        expect(LEDGER_ADJUST_TYPES.has("Build")).toBe(false);
    });

    it("keeps the union for callers asking what left the building", () => {
        expect(LEDGER_CONSUME_TYPES.has("Build")).toBe(true);
        expect(LEDGER_CONSUME_TYPES.has("Stock change or take")).toBe(true);
        expect(LEDGER_CONSUME_TYPES.has("Sale shipment")).toBe(true);
        expect(LEDGER_CONSUME_TYPES.has("Return shipment")).toBe(true);
        // Internal movement between facilities is not consumption.
        expect(LEDGER_CONSUME_TYPES.has("Transfer")).toBe(false);
        // Receipts measure what we bought, not what we need.
        expect(LEDGER_CONSUME_TYPES.has("Purchase shipment")).toBe(false);
    });
});

describe("deriveLedgerRate", () => {
    it("lets demand set the rate and ignores manual corrections", () => {
        // Build 900 over 90d = 10/day. A 900-unit correction must not make it 20.
        expect(deriveLedgerRate({ demandNet: 900, adjustNet: 900, adjustDays: 1 }, 90)).toBeCloseTo(10, 6);
    });

    it("refuses to annualize a single write-off", () => {
        expect(deriveLedgerRate({ demandNet: 0, adjustNet: 3003, adjustDays: 1 }, 90)).toBe(0);
    });

    it("accepts a recurring manual correction as consumption", () => {
        // Tape and boxes get taken repeatedly; that is real usage.
        expect(deriveLedgerRate({ demandNet: 0, adjustNet: 450, adjustDays: 5 }, 90)).toBeCloseTo(5, 6);
    });

    it("requires at least the minimum number of distinct days", () => {
        expect(deriveLedgerRate({ demandNet: 0, adjustNet: 90, adjustDays: LEDGER_MIN_ADJUST_DAYS }, 90)).toBeCloseTo(1, 6);
        expect(deriveLedgerRate({ demandNet: 0, adjustNet: 90, adjustDays: LEDGER_MIN_ADJUST_DAYS - 1 }, 90)).toBe(0);
    });

    it("ignores a net-negative correction with no demand", () => {
        expect(deriveLedgerRate({ demandNet: 0, adjustNet: -40, adjustDays: 4 }, 90)).toBe(0);
    });

    it("returns 0 for a non-positive window", () => {
        expect(deriveLedgerRate({ demandNet: 900, adjustNet: 0, adjustDays: 0 }, 0)).toBe(0);
    });
});

describe("fetchLedgerSnapshot", () => {
    it("splits demand from adjustment and rates off demand", async () => {
        mockFetchSequence([
            ledgerPage([
                { transactionType: "Build", recordDate: "2026-09-01", unitsIn: 6909, unitsOut: 13818, product: { productId: "BLANKBAGCF" } },
                { transactionType: "Stock change or take", recordDate: "2026-09-02", unitsIn: 0, unitsOut: 424, product: { productId: "BLANKBAGCF" } },
                { transactionType: "Transfer", recordDate: "2026-09-03", unitsIn: 17915, unitsOut: 17915, product: { productId: "BLANKBAGCF" } },
                { transactionType: "Purchase shipment", recordDate: "2026-09-04", unitsIn: 12750, unitsOut: 0, product: { productId: "BLANKBAGCF" } },
            ]),
        ]);

        const snap = await fetchLedgerSnapshot(90, TEST_DEPS);
        const row = snap.bySku["BLANKBAGCF"];

        // 13818 - 6909 = 6909 from the build, + 424 from the take = 7333 total.
        // Transfer and Purchase shipment are excluded.
        expect(row.net).toBe(7333);
        expect(row.gross).toBe(14242);
        expect(row.rows).toBe(2);
        expect(row.lastDate).toBe("2026-09-02");

        // The split is recorded for auditability...
        expect(row.demandNet).toBe(6909);
        expect(row.adjustNet).toBe(424);
        expect(row.adjustRows).toBe(1);
        expect(row.adjustDays).toBe(1);
        expect(row.adjustRate).toBeCloseTo(424 / 90, 6);

        // ...and the rate comes from demand alone, not demand + correction.
        expect(row.dailyRate).toBeCloseTo(6909 / 90, 6);
    });

    it("counts distinct correction days, not correction rows", async () => {
        mockFetchSequence([
            ledgerPage([
                // Three corrections, but two of them share a date.
                { transactionType: "Stock change or take", recordDate: "2026-09-01", unitsIn: 0, unitsOut: 100, product: { productId: "TAPE" } },
                { transactionType: "Stock change or take", recordDate: "2026-09-01", unitsIn: 0, unitsOut: 100, product: { productId: "TAPE" } },
                { transactionType: "Stock change or take", recordDate: "2026-09-20", unitsIn: 0, unitsOut: 100, product: { productId: "TAPE" } },
            ]),
        ]);

        const snap = await fetchLedgerSnapshot(90, TEST_DEPS);
        const row = snap.bySku["TAPE"];
        expect(row.adjustRows).toBe(3);
        expect(row.adjustDays).toBe(2);
        expect(row.dailyRate).toBeCloseTo(300 / 90, 6);
    });

    it("gives a lone write-off no rate at all", async () => {
        mockFetchSequence([
            ledgerPage([
                { transactionType: "Stock change or take", recordDate: "2026-10-09", unitsIn: 0, unitsOut: 3003, product: { productId: "S-12230" } },
            ]),
        ]);
        const snap = await fetchLedgerSnapshot(90, TEST_DEPS);
        const row = snap.bySku["S-12230"];
        expect(row.net).toBe(3003);
        expect(row.demandNet).toBe(0);
        expect(row.adjustDays).toBe(1);
        expect(row.dailyRate).toBe(0);
    });

    it("stamps the aggregation version so a stale cache refetches", async () => {
        mockFetchSequence([
            ledgerPage([
                { transactionType: "Sale shipment", recordDate: "2026-09-01", unitsIn: 0, unitsOut: 9, product: { productId: "AAA" } },
            ]),
        ]);
        const snap = await fetchLedgerSnapshot(90, TEST_DEPS);
        expect(snap.version).toBe(LEDGER_SNAPSHOT_VERSION);
    });

    it("follows pagination across pages", async () => {
        const spy = mockFetchSequence([
            ledgerPage(
                [{ transactionType: "Sale shipment", recordDate: "2026-09-01", unitsIn: 0, unitsOut: 100, product: { productId: "AAA" } }],
                true,
                "cursor1",
            ),
            ledgerPage([
                { transactionType: "Sale shipment", recordDate: "2026-09-05", unitsIn: 0, unitsOut: 50, product: { productId: "BBB" } },
            ]),
        ]);

        const snap = await fetchLedgerSnapshot(30, TEST_DEPS);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(snap.pages).toBe(2);
        expect(snap.ledgerRows).toBe(2);
        expect(snap.bySku["AAA"].net).toBe(100);
        expect(snap.bySku["AAA"].dailyRate).toBeCloseTo(100 / 30, 6);
        expect(snap.bySku["BBB"].net).toBe(50);
    });

    it("ignores rows with no resolvable product id", async () => {
        mockFetchSequence([
            ledgerPage([
                { transactionType: "Build", recordDate: "2026-09-01", unitsIn: 0, unitsOut: 10, product: {} },
                { transactionType: "Build", recordDate: "2026-09-01", unitsIn: 0, unitsOut: 10, product: null },
            ]),
        ]);
        const snap = await fetchLedgerSnapshot(90, TEST_DEPS);
        expect(Object.keys(snap.bySku)).toHaveLength(0);
        expect(snap.ledgerRows).toBe(2);
    });

    it("handles Finale's numeric strings and '--' placeholders", async () => {
        mockFetchSequence([
            ledgerPage([
                { transactionType: "Build", recordDate: "2026-09-01", unitsIn: "--", unitsOut: "1512", product: { productId: "STICKER12" } },
            ]),
        ]);
        const snap = await fetchLedgerSnapshot(90, TEST_DEPS);
        const row = snap.bySku["STICKER12"];
        expect(Number.isFinite(row.net)).toBe(true);
        expect(Number.isFinite(row.dailyRate)).toBe(true);
        expect(row.demandNet).toBe(1512);
    });

    it("throws with the Finale error message when the query fails", async () => {
        mockFetchSequence([
            { errors: [{ message: "Cannot query field \"unitsOut\"" }] },
        ]);
        await expect(fetchLedgerSnapshot(90, TEST_DEPS)).rejects.toThrow(/unitsOut/);
    });
});

describe("ledger lookup helpers", () => {
    function entry(over: Partial<LedgerSku>): LedgerSku {
        return {
            sku: "X", net: 0, gross: 0, rows: 0, lastDate: "", dailyRate: 0,
            demandNet: 0, adjustNet: 0, adjustRows: 0, adjustDays: 0, adjustRate: 0,
            ...over,
        };
    }

    const snapshot: LedgerSnapshot = {
        generatedAt: "2026-09-30T00:00:00.000Z",
        version: LEDGER_SNAPSHOT_VERSION,
        days: 90,
        pages: 1,
        ledgerRows: 2,
        bySku: {
            STICKER12: entry({
                sku: "STICKER12", net: 1497, gross: 3024, rows: 5, lastDate: "2026-08-26",
                demandNet: 1512, adjustNet: -15, adjustRows: 1, adjustDays: 1, adjustRate: -15 / 90,
                dailyRate: 1512 / 90,
            }),
            ZEROED: entry({ sku: "ZEROED" }),
            // Emptied by one correction: a write-off.
            WRITEOFF: entry({
                sku: "WRITEOFF", net: 3003, gross: 3003, rows: 1, lastDate: "2026-10-09",
                demandNet: 0, adjustNet: 3003, adjustRows: 1, adjustDays: 1, adjustRate: 3003 / 90,
            }),
            // One take that left stock on the shelf.
            LEFTOVER: entry({
                sku: "LEFTOVER", net: 500, gross: 500, rows: 1, lastDate: "2026-09-21",
                demandNet: 0, adjustNet: 500, adjustRows: 1, adjustDays: 1, adjustRate: 500 / 90,
            }),
        },
    };

    it("returns the rate for a consuming SKU", () => {
        expect(ledgerRateFor(snapshot, "STICKER12")).toBeCloseTo(1512 / 90, 3);
        expect(ledgerNetFor(snapshot, "STICKER12")).toBe(1512);
    });

    it("returns 0 for a zero-consumption SKU", () => {
        expect(ledgerRateFor(snapshot, "ZEROED")).toBe(0);
        expect(ledgerNetFor(snapshot, "ZEROED")).toBe(0);
    });

    it("gives a lone write-off no rate and no admission", () => {
        expect(ledgerRateFor(snapshot, "WRITEOFF")).toBe(0);
        expect(ledgerRateFor(snapshot, "WRITEOFF", { stockOnHand: 0 })).toBe(0);
        expect(ledgerNetFor(snapshot, "WRITEOFF")).toBe(0);
    });

    it("keeps a single-day take alive while stock remains", () => {
        expect(ledgerRateFor(snapshot, "LEFTOVER", { stockOnHand: 350 })).toBeCloseTo(500 / 90, 6);
        // Same SKU with an empty shelf stays excluded.
        expect(ledgerRateFor(snapshot, "LEFTOVER", { stockOnHand: 0 })).toBe(0);
        // And with no stock information the conservative answer wins.
        expect(ledgerRateFor(snapshot, "LEFTOVER")).toBe(0);
    });

    it("returns 0 for an unknown SKU and for a null snapshot", () => {
        expect(ledgerRateFor(snapshot, "NOPE")).toBe(0);
        expect(ledgerNetFor(snapshot, "NOPE")).toBe(0);
        expect(ledgerRateFor(null, "STICKER12")).toBe(0);
        expect(ledgerNetFor(undefined, "STICKER12")).toBe(0);
    });
});
