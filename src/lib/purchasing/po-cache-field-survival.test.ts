/**
 * @file    src/lib/purchasing/po-cache-field-survival.test.ts
 * @purpose Pin what po-cache does and does not carry (Gap 6 / Gap 13 class).
 *
 *          Two different kinds of field, deliberately tested apart:
 *
 *          1. PO FACTS — must survive the cache round-trip. `unitPrice` (and
 *             `remainingQty`) go into `purchase_orders.line_items` and come back
 *             on `FullPO.items` / `FullPO.itemList`; `expectedDate` is stored as
 *             `required_date` and must be restored. A cache path that drops
 *             them gives confident wrong answers when Finale is down.
 *
 *          2. POLICY fields — `finishedGoodsCoverageDays` / `combinedRunwayDays`
 *             are NOT PO facts and are NOT cached (2026-10-29, verified against
 *             po-cache.ts and the purchasing GET route). They are derived per
 *             scan in policy-candidates.buildPurchasingCandidate from the scan's
 *             `item.feedsFinishedGoods`, then reach the payload as
 *             `item.candidate` because the route rebuilds candidates on EVERY
 *             request via assessPurchasingGroups(). Caching them would serve a
 *             stale coverage number as if the shelf had not moved, so there is
 *             intentionally no `finished_goods_coverage_days` column and this
 *             test pins that absence as well as the payload presence.
 *
 * @author  Hermia
 * @created 2026-10-29
 * @deps    vitest, po-cache, policy-candidates, assessment-service
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { FullPO, PurchasingGroup, PurchasingItem } from "../finale/core-client";

vi.mock("../db", () => ({
    createClient: vi.fn(),
    probePostgrest: vi.fn(),
}));

import { createClient } from "../db";
import { cacheFinalePos, readCachedPos } from "./po-cache";
import { buildPurchasingCandidate } from "./policy-candidates";
import { assessPurchasingGroups } from "./assessment-service";

// ── Mock db: write captures rows, read serves them back ──────────────────

interface MockChain {
    select: (...args: unknown[]) => MockChain;
    in: (...args: unknown[]) => MockChain;
    gte: (...args: unknown[]) => MockChain;
    eq: (...args: unknown[]) => MockChain;
    order: (...args: unknown[]) => MockChain;
    limit: (...args: unknown[]) => MockChain;
    maybeSingle: (...args: unknown[]) => MockChain;
    then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
}

function makeDb(rowsForSelect: Array<Record<string, unknown>> = []) {
    const written: Array<Record<string, unknown>> = [];

    const chain = {} as MockChain;
    const self = () => chain;
    chain.select = vi.fn(self);
    chain.in = vi.fn(self);
    chain.gte = vi.fn(self);
    chain.eq = vi.fn(self);
    chain.order = vi.fn(self);
    chain.limit = vi.fn(self);
    chain.maybeSingle = vi.fn(self);
    // Awaiting the chain resolves to the canned rows, like postgrest-js.
    chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ data: rowsForSelect, error: null }));

    const upsert = vi.fn(async (batch: unknown) => {
        for (const row of Array.isArray(batch) ? batch : [batch]) {
            written.push(row as Record<string, unknown>);
        }
        return { error: null, data: [] };
    });

    const from = vi.fn(() => ({ upsert, select: chain.select, then: chain.then }));
    return { db: { from }, from, upsert, written };
}

function makePo(overrides: Partial<FullPO> = {}): FullPO {
    return {
        orderId: "125410",
        vendorName: "ULINE",
        vendorPartyId: "10083",
        orderDate: "2026-10-01",
        expectedDate: "2026-11-15",
        receiveDate: null,
        status: "Committed",
        total: 250,
        items: [
            { productId: "S-17888", quantity: 100, unitPrice: 2.5, remainingQty: 40 },
            { productId: "S-4738", quantity: 10, unitPrice: 12.75, remainingQty: null },
        ],
        finaleUrl: "",
        shipments: [],
        ...overrides,
    };
}

/** Write a PO through cacheFinalePos, then read it back through readCachedPos. */
async function roundTrip(po: FullPO): Promise<{ rebuilt: FullPO; writtenRow: Record<string, unknown> }> {
    const writeDb = makeDb();
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(writeDb.db);
    await cacheFinalePos([po]);
    expect(writeDb.written).toHaveLength(1);
    const writtenRow = writeDb.written[0];

    // Serve the exact row the cache wrote (PostgREST returns JSONB as an object).
    const readDb = makeDb([{ ...writtenRow, status: "Committed" }]);
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(readDb.db);
    const rebuilt = await readCachedPos(60);
    expect(rebuilt).toHaveLength(1);
    return { rebuilt: rebuilt[0], writtenRow };
}

// ── 1. PO facts: unitPrice / remainingQty / expectedDate ─────────────────

describe("po-cache PO-fact survival (Gap 6 / Gap 13)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("stores unitPrice and remainingQty in line_items", async () => {
        const { writtenRow } = await roundTrip(makePo());
        expect(writtenRow.line_items).toEqual([
            { productId: "S-17888", quantity: 100, unitPrice: 2.5, remainingQty: 40 },
            { productId: "S-4738", quantity: 10, unitPrice: 12.75, remainingQty: null },
        ]);
    });

    it("rebuilds items still carrying unitPrice and remainingQty", async () => {
        const { rebuilt } = await roundTrip(makePo());
        expect(rebuilt.items[0]).toMatchObject({
            productId: "S-17888",
            quantity: 100,
            unitPrice: 2.5,
            remainingQty: 40,
        });
        // Type-level survival too: the reconstruction must be typed as
        // FullPO["items"] so a consumer is allowed to read .unitPrice.
        const priceOnCachedPo: number | undefined = rebuilt.items[1].unitPrice;
        expect(priceOnCachedPo).toBe(12.75);
    });

    it("carries unitPrice into the GraphQL-shaped itemList, not just quantity", async () => {
        const { rebuilt } = await roundTrip(makePo());
        const edges = (rebuilt as unknown as {
            itemList: { edges: Array<{ node: Record<string, unknown> }> };
        }).itemList.edges;
        expect(edges).toHaveLength(2);
        expect(edges[0].node.quantity).toBe(100);
        expect(edges[0].node.unitPrice).toBe(2.5);
        expect(edges[1].node.unitPrice).toBe(12.75);
    });

    it("restores expectedDate from the stored required_date without a UTC day shift", async () => {
        const { rebuilt, writtenRow } = await roundTrip(makePo());
        expect(writtenRow.required_date).toBe("2026-11-15");
        // Naive date through new Date().toISOString() can land a day early in
        // Denver; the cache must slice, not convert.
        expect(rebuilt.expectedDate).toBe("2026-11-15");

        const late = await roundTrip(makePo({ expectedDate: "2026-01-01" }));
        expect(late.rebuilt.expectedDate).toBe("2026-01-01");
    });

    it("returns expectedDate null when the PO has no quoted date", async () => {
        const { rebuilt } = await roundTrip(makePo({ expectedDate: null }));
        expect(rebuilt.expectedDate).toBeNull();
    });
});

// ── 2. Policy fields: derived per scan, never cached ─────────────────────

const FEEDS = [
    { sku: "WDG104", name: "AquaBAC 8oz", dailySalesRate: 0.544, buildsWorth: 25.3, qtyPerUnit: 0.008, stockOnHand: 420 },
    { sku: "WDG204", name: "AquaBAC case", dailySalesRate: 0.133, buildsWorth: 8.6, qtyPerUnit: 0.096, stockOnHand: 11 },
];

function scanItem(overrides: Partial<PurchasingItem> = {}): PurchasingItem {
    return {
        supplierName: "Clarke",
        supplierPartyId: "10325",
        productId: "WDG101",
        productName: "AquaBAC-WDG 3000 - (25lb)",
        unitPrice: 47.5,
        stockOnHand: 8.28,
        stockOnOrder: 0,
        purchaseVelocity: 0,
        salesVelocity: 0,
        demandVelocity: 0.12,
        dailyRate: 0.1867,
        runwayDays: 44.36,
        adjustedRunwayDays: 44.36,
        leadTimeDays: 11,
        effectiveLeadTimeDays: 11,
        leadTimeProvenance: "11d (Finale)",
        openPOs: [],
        urgency: "warning",
        explanation: "Runway under lead time.",
        suggestedQty: 22,
        orderIncrementQty: null,
        isBulkDelivery: false,
        finaleReorderQty: 22,
        finaleStockoutDays: 44,
        finaleConsumptionQty: null,
        finaleDemandQty: null,
        itemType: "resale-bom",
        feedsFinishedGoods: FEEDS,
        ...overrides,
    } as PurchasingItem;
}

describe("purchasing policy fields are scan-derived and reach the payload", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("po-cache never invents a coverage column for derived policy fields", async () => {
        // Documents the 2026-10-29 decision: these fields are computed per scan.
        // If someone later adds a cache column, stale coverage would read as fact.
        const { writtenRow } = await roundTrip(makePo());
        const keys = Object.keys(writtenRow);
        expect(keys).not.toContain("finished_goods_coverage_days");
        expect(keys).not.toContain("combined_runway_days");
        expect(keys).not.toContain("finishedGoodsCoverageDays");
        expect(keys).not.toContain("combinedRunwayDays");
    });

    it("buildPurchasingCandidate computes both fields from feeds that carry stock", () => {
        const candidate = buildPurchasingCandidate(scanItem());
        expect(candidate.finishedGoodsCoverageDays).not.toBeNull();
        expect(Number.isFinite(candidate.finishedGoodsCoverageDays!)).toBe(true);
        expect(candidate.finishedGoodsCoverageDays!).toBeGreaterThan(50);
        expect(candidate.combinedRunwayDays).not.toBeNull();
        expect(Number.isFinite(candidate.combinedRunwayDays!)).toBe(true);
        expect(candidate.combinedRunwayDays!).toBeGreaterThan(40);
        // unitPrice rides the candidate, so a priced row stays priced.
        expect(candidate.unitPrice).toBe(47.5);
    });

    it("serves both fields on the payload the purchasing GET route emits (item.candidate)", () => {
        const group: PurchasingGroup = {
            vendorName: "Clarke",
            vendorPartyId: "10325",
            urgency: "warning",
            items: [scanItem()],
        };
        // This is exactly what route.ts does: assessPurchasingGroups(groups) then
        // `candidate: line.candidate` on each item. The route re-derives them on
        // every GET, so a 60-minute-old scan snapshot still ships current policy
        // numbers rather than a cached copy.
        const assessment = assessPurchasingGroups([group]);
        const line = assessment.groups[0].items[0];
        expect(line.candidate.finishedGoodsCoverageDays).not.toBeNull();
        expect(line.candidate.combinedRunwayDays).not.toBeNull();

        const payload = JSON.parse(JSON.stringify({
            productId: line.item.productId,
            urgency: line.item.urgency,
            candidate: line.candidate,
            assessment: line.assessment,
        }));
        expect(payload.candidate.finishedGoodsCoverageDays).toBeCloseTo(
            line.candidate.finishedGoodsCoverageDays as number,
            6,
        );
        expect(payload.candidate.combinedRunwayDays).toBeCloseTo(
            line.candidate.combinedRunwayDays as number,
            6,
        );
        expect(payload.candidate.unitPrice).toBe(47.5);
    });

    it("keeps both fields null (not stale) when the scan carries no packed-FG stock", () => {
        const group: PurchasingGroup = {
            vendorName: "Clarke",
            vendorPartyId: "10325",
            urgency: "warning",
            items: [scanItem({ productId: "RAP101", feedsFinishedGoods: [] })],
        };
        const line = assessPurchasingGroups([group]).groups[0].items[0];
        expect(line.candidate.finishedGoodsCoverageDays).toBeNull();
        expect(line.candidate.combinedRunwayDays).toBeNull();
    });
});
