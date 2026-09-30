/**
 * @file    src/lib/finale/stock-ledger.test.ts
 * @purpose Unit tests for the stock-ledger consumption aggregation — the
 *          determination source that does not depend on Finale's per-product
 *          reorder configuration.
 *
 * @author  Hermia
 * @created 2026-09-30
 * @deps    vitest
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    LEDGER_CONSUME_TYPES,
    fetchLedgerSnapshot,
    ledgerNetFor,
    ledgerRateFor,
    type LedgerSnapshot,
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

describe("LEDGER_CONSUME_TYPES", () => {
    it("counts consumption and excludes internal transfers and receipts", () => {
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

describe("fetchLedgerSnapshot", () => {
    it("sums net consumption per SKU and derives a daily rate", async () => {
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

        // 13818 - 6909 = 6909 from the build, + 424 from the take = 7333.
        // Transfer and Purchase shipment are excluded.
        expect(row.net).toBe(7333);
        expect(row.gross).toBe(14242);
        expect(row.rows).toBe(2);
        expect(row.lastDate).toBe("2026-09-02");
        expect(row.dailyRate).toBeCloseTo(7333 / 90, 6);
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
                { transactionType: "Build", recordDate: "2026-09-01", unitsIn: "--", unitsOut: "1,512", product: { productId: "STICKER12" } },
            ]),
        ]);
        const snap = await fetchLedgerSnapshot(90, TEST_DEPS);
        // "1,512" is not a plain number; it must not produce NaN.
        const row = snap.bySku["STICKER12"];
        expect(Number.isFinite(row.net)).toBe(true);
        expect(Number.isFinite(row.dailyRate)).toBe(true);
    });

    it("throws with the Finale error message when the query fails", async () => {
        mockFetchSequence([
            { errors: [{ message: "Cannot query field \"unitsOut\"" }] },
        ]);
        await expect(fetchLedgerSnapshot(90, TEST_DEPS)).rejects.toThrow(/unitsOut/);
    });
});

describe("ledger lookup helpers", () => {
    const snapshot: LedgerSnapshot = {
        generatedAt: "2026-09-30T00:00:00.000Z",
        days: 90,
        pages: 1,
        ledgerRows: 2,
        bySku: {
            STICKER12: { sku: "STICKER12", net: 1497, gross: 3024, rows: 5, lastDate: "2026-08-26", dailyRate: 16.633 },
            ZEROED: { sku: "ZEROED", net: 0, gross: 0, rows: 0, lastDate: "", dailyRate: 0 },
        },
    };

    it("returns the rate for a consuming SKU", () => {
        expect(ledgerRateFor(snapshot, "STICKER12")).toBeCloseTo(16.633, 3);
        expect(ledgerNetFor(snapshot, "STICKER12")).toBe(1497);
    });

    it("returns 0 for a zero-consumption SKU", () => {
        expect(ledgerRateFor(snapshot, "ZEROED")).toBe(0);
        expect(ledgerNetFor(snapshot, "ZEROED")).toBe(0);
    });

    it("returns 0 for an unknown SKU and for a null snapshot", () => {
        expect(ledgerRateFor(snapshot, "NOPE")).toBe(0);
        expect(ledgerNetFor(snapshot, "NOPE")).toBe(0);
        expect(ledgerRateFor(null, "STICKER12")).toBe(0);
        expect(ledgerNetFor(undefined, "STICKER12")).toBe(0);
    });
});
