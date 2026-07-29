/**
 * @file    src/lib/builds/po-arrival-risk.test.ts
 * @purpose Unit tests for writeAtRiskActivityRows dedup guards.
 *          HERMIA(2026-07-29): Verifies the two-layer dedup fix that prevents
 *          duplicate PO_ARRIVAL_AT_RISK rows in ap_activity_log during rapid
 *          bursts (observed: 939 rows for PO 125126 with 0.007s median gaps).
 *
 *          Mocks @/lib/db — never touches a live database.
 * @author  Hermia
 * @created 2026-07-29
 */
import { describe, expect, it, vi } from "vitest";
import type { AtRiskPO } from "./po-arrival-risk";

// ---------------------------------------------------------------------------
// Mock @/lib/db at the top level so vitest hoists it before module imports.
// The factory returns a mutable `__mockClient` that each test can reassign.
// ---------------------------------------------------------------------------
let __mockClient: any = null;
vi.mock("@/lib/db", () => ({
    createClient: vi.fn(() => __mockClient),
}));

// Import AFTER the mock (vitest hoists vi.mock to the top)
const { writeAtRiskActivityRows } = await import("./po-arrival-risk");

// ---------------------------------------------------------------------------
// Mock QueryBuilder — returns `this` for every chainable method, and its
// `then()` resolves to a configurable response.
// ---------------------------------------------------------------------------
interface MockQueryBuilder {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    neq: ReturnType<typeof vi.fn>;
    filter: ReturnType<typeof vi.fn>;
    gte: ReturnType<typeof vi.fn>;
    lte: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    then: (resolve?: any) => Promise<any>;
}

/**
 * Query-aware mock builder.
 *
 * HERMIA(2026-07-29): the original harness returned the SAME fixture for every
 * query, so the snooze pre-pass fixture also satisfied the per-PO dedup SELECT —
 * making a non-snoozed PO take the UPDATE path and never INSERT. That was a test
 * artifact, not a product defect. `snoozeData` and `dedupData` are now served
 * separately: the snooze pre-pass is the query that calls `.filter(...)` with
 * `metadata->>snoozed_until`, everything else is a dedup lookup.
 */
function makeQueryBuilder(data: any, error: any = null, dedupData?: any): MockQueryBuilder {
    const builder: any = {
        _data: data,
        _error: error,
        _isSnoozeQuery: false,
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        neq: vi.fn(() => builder),
        filter: vi.fn((col: string) => {
            // The snooze pre-pass filters on metadata->>snoozed_until;
            // the dedup lookup filters on metadata->>poId.
            if (typeof col === "string" && col.includes("snoozed_until")) {
                builder._isSnoozeQuery = true;
            }
            return builder;
        }),
        gte: vi.fn(() => builder),
        lte: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        insert: vi.fn(() => builder),
        update: vi.fn(() => builder),
        insertCalled: false,
        then(resolve?: any) {
            const isSnooze = this._isSnoozeQuery;
            // Reset so the next chained query is classified independently.
            this._isSnoozeQuery = false;
            const payload = isSnooze
                ? this._data
                : (dedupData !== undefined ? dedupData : this._data);
            const val = { data: payload, error: this._error };
            return resolve ? Promise.resolve(resolve(val)) : Promise.resolve(val);
        },
    };
    return builder;
}

// ---------------------------------------------------------------------------
// AtRiskPO factory
// ---------------------------------------------------------------------------
function makeRisk(poId: string, overrides: Partial<AtRiskPO> = {}): AtRiskPO {
    return {
        poId,
        vendorName: "Test Vendor",
        vendorPartyId: null,
        severity: "at_risk",
        orderDate: "2026-07-01",
        expectedArrival: "2026-08-15",
        leadProvenance: "14d (Finale)",
        commState: "none",
        facts: {
            poSentAt: null,
            vendorAcknowledgedAt: null,
            humanReplyDetectedAt: null,
            vendorStatedEta: null,
            trackingNumbers: [],
            lastMovementSummary: null,
            lifecycleStage: null,
        },
        atRiskItems: [
            {
                sku: "TEST-SKU-001",
                productName: "Test Product",
                stockOnHand: 50,
                dailyRate: 10,
                runwayDays: 5,
                stockoutDate: "2026-07-20",
                daysShort: 10,
                affectedFGs: ["FG-001"],
            },
        ],
        worstDaysShort: 10,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("writeAtRiskActivityRows — dedup guards", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    /**
     * Test (a): A risks array containing the same poId 5 times results in
     * exactly ONE insert and zero updates. The pre-dedup collapses all five
     * entries into one, and the in-loop guard reinforces it.
     */
    it("dedupes duplicate poIds in risks array — only one INSERT", async () => {
        // snooze pre-pass returns nothing + risk SELECT returns no existing row
        const builder = makeQueryBuilder([]);                     // snooze: empty
        __mockClient = { from: vi.fn(() => builder) };

        const risks: AtRiskPO[] = [
            makeRisk("PO-125126"),
            makeRisk("PO-125126"),
            makeRisk("PO-125126"),
            makeRisk("PO-125126"),
            makeRisk("PO-125126"),
            makeRisk("PO-99999"),
        ];

        const result = await writeAtRiskActivityRows(risks);

        // Exactly 2 INSERTs — the 5 copies of PO-125126 become 1, plus PO-99999
        expect(result.inserted).toBe(2);
        expect(result.updated).toBe(0);
        expect(result.failed).toBe(0);

        // Verify at least one insert for PO-125126
        const insertCalls = builder.insert.mock.calls;
        expect(insertCalls.length).toBe(2);
        const insertedPoIds = insertCalls.map((args: any[]) => args[0].metadata.poId).sort();
        expect(insertedPoIds).toEqual(["PO-125126", "PO-99999"]);
    });

    /**
     * Test (b): An existing same-day row triggers the UPDATE path.
     */
    it("existing same-day row takes UPDATE path", async () => {
        // snooze: empty; risk SELECT: returns existing row → UPDATE path
        const builder = makeQueryBuilder([{ id: "existing-uuid-123" }]);
        __mockClient = { from: vi.fn(() => builder) };

        const risks: AtRiskPO[] = [makeRisk("PO-UPDATE-TEST")];

        const result = await writeAtRiskActivityRows(risks);

        expect(result.inserted).toBe(0);
        expect(result.updated).toBe(1);
        expect(result.failed).toBe(0);

        // update() was called (not insert)
        expect(builder.update).toHaveBeenCalledTimes(1);
        expect(builder.insert).toHaveBeenCalledTimes(0);

        const updatePayload = builder.update.mock.calls[0][0];
        expect(updatePayload.metadata.poId).toBe("PO-UPDATE-TEST");
    });

    /**
     * Test (c): Snoozed POs are skipped entirely.
     * The snooze pre-pass finds a snoozed row → that PO is skipped.
     */
    it("snoozed POs are skipped", async () => {
        // snooze pre-pass returns a snoozed row; the per-PO dedup SELECT returns
        // [] so the non-snoozed PO correctly takes the INSERT path.
        const builder = makeQueryBuilder([{ metadata: { poId: "PO-SNOOZED-001" } }], null, []);
        __mockClient = { from: vi.fn(() => builder) };

        const risks: AtRiskPO[] = [
            makeRisk("PO-SNOOZED-001"),
            makeRisk("PO-NOT-SNOOZED"),
        ];

        const result = await writeAtRiskActivityRows(risks);

        // Only the non-snoozed PO should be processed
        expect(result.inserted).toBe(1);
        expect(result.updated).toBe(0);
        expect(result.failed).toBe(0);

        // The snoozed PO should NOT have triggered a SELECT for the dedup check
        // The builder's select count: 1 (snooze query) + 1 (for PO-NOT-SNOOZED's dedup) = 2
        // Since the same builder is used for all queries, we can check that
        // only one non-snooze select happened
        const insertCalls = builder.insert.mock.calls;
        expect(insertCalls.length).toBe(1);
        expect(insertCalls[0][0].metadata.poId).toBe("PO-NOT-SNOOZED");
    });

    /**
     * Defence-in-depth: verify that the pre-dedup keeps the FIRST (most severe)
     * entry when multiple copies of the same poId exist with different data.
     */
    it("pre-dedup keeps first occurrence (most severe)", async () => {
        const builder = makeQueryBuilder([]); // snooze: empty, SELECT: no existing
        __mockClient = { from: vi.fn(() => builder) };

        const risks: AtRiskPO[] = Array.from({ length: 5 }, (_, i) =>
            makeRisk("PO-DEDUP-001", { worstDaysShort: 10 - i }),
        );

        const result = await writeAtRiskActivityRows(risks);

        expect(result.inserted).toBe(1);
        expect(result.updated).toBe(0);
        expect(result.failed).toBe(0);

        // The pre-dedup keeps the FIRST entry (worstDaysShort=10)
        const insertPayload = builder.insert.mock.calls[0][0];
        expect(insertPayload.metadata.worstDaysShort).toBe(10);
    });
});
