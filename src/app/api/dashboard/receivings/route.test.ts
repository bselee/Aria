import { beforeEach, describe, expect, it, vi } from "vitest";

/** A row from the PostgREST stand-in — column names are dynamic. */
type Row = Record<string, unknown>;

/**
 * The fluent PostgREST chain the route awaits. Typed rather than `any` so a
 * filter the route grows but this stub lacks shows up as a type error.
 */
type MockBuilder = {
    select: () => MockBuilder;
    eq: (col: string, val: unknown) => MockBuilder;
    in: (col: string, vals: unknown[]) => MockBuilder;
    is: (col: string, val: unknown) => MockBuilder;
    not: (col: string, op: string, val: unknown) => MockBuilder;
    gte: () => MockBuilder;
    or: () => MockBuilder;
    order: () => MockBuilder;
    limit: (n: number) => MockBuilder;
    then: (
        resolve: (value: { data: Row[]; error: null }) => unknown,
        reject?: (reason: unknown) => unknown,
    ) => Promise<unknown>;
};

const { getTodaysReceivedPOsMock, fakeTables } = vi.hoisted(() => ({
    getTodaysReceivedPOsMock: vi.fn(),
    fakeTables: {} as Record<string, Row[]>,
}));

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: class {
        getTodaysReceivedPOs = getTodaysReceivedPOsMock;
    },
}));

// The local sqlite invoice cache is a real file on the dev machine — a test
// must not read it (slow, and non-hermetic).
vi.mock("@/lib/storage/purchasing-cache", () => ({
    getUnmatchedInvoices: () => [],
    getInvoiceCacheByVendor: () => [],
}));

/**
 * Minimal PostgREST stand-in. Only the filters this route actually uses on the
 * receivings path are honoured; everything else passes through so a shape
 * assertion never depends on a stub's internals.
 */
vi.mock("@/lib/db", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/db")>();
    const builder = (table: string) => {
        let rows = [...(fakeTables[table] ?? [])];
        const b: MockBuilder = {
            select: () => b,
            eq: (col, val) => {
                rows = rows.filter((r) => r?.[col] === val);
                return b;
            },
            in: (col, vals) => {
                rows = rows.filter((r) => vals.includes(r?.[col]));
                return b;
            },
            is: (col, val) => {
                rows = rows.filter((r) => (val === null ? r?.[col] == null : r?.[col] === val));
                return b;
            },
            not: (col, op, val) => {
                if (op === "is" && val === null) rows = rows.filter((r) => r?.[col] != null);
                return b;
            },
            gte: () => b,
            or: () => b,
            order: () => b,
            limit: (n) => {
                rows = rows.slice(0, n);
                return b;
            },
            then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
        };
        return b;
    };
    return { ...actual, createClient: () => ({ from: builder }) };
});

import { GET, getDenverWeekStart } from "./route";

/** A received PO with per-line unitPrice — the bulk GraphQL bulk shape. */
function receivedPO(overrides: Record<string, unknown> = {}) {
    return {
        orderId: "125429",
        orderDate: "2026-10-21",
        receiveDate: "2026-10-27",
        receiveDateTime: "2026-10-27T10:00:00-06:00",
        supplier: "Uline",
        total: 175,
        subtotal: 175,
        items: [
            { productId: "S-17888", quantity: 14, orderedQuantity: 14, receivedQuantity: 14, unitPrice: 12.5 },
        ],
        finaleUrl: "https://example.com/po",
        ...overrides,
    };
}

/** A matched vendor_invoices row carrying OCR line items. */
function matchedInvoice(overrides: Record<string, unknown> = {}) {
    return {
        po_number: "125429",
        id: "inv-1",
        invoice_number: "215047605",
        subtotal: 175,
        freight: 0,
        tax: 0,
        total: 175,
        status: "matched",
        created_at: "2026-10-28T00:00:00.000Z",
        pdf_storage_path: null,
        source_ref: null,
        line_items: JSON.stringify([{ sku: "S-17888", qty: 14, unit_price: 12.5 }]),
        ...overrides,
    };
}

function resetTables() {
    for (const key of Object.keys(fakeTables)) delete fakeTables[key];
    fakeTables.vendor_invoices = [];
    fakeTables.reconciliation_outcomes = [];
    fakeTables.overbill_disputes = [];
    fakeTables.ap_activity_log = [];
    fakeTables.bill_po_links = [];
}

describe("dashboard receivings route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        resetTables();
    });

    it("defaults to Denver week-to-date receipts", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-03T18:00:00.000Z"));
        getTodaysReceivedPOsMock.mockResolvedValue([]);

        const response = await GET(new Request("http://localhost/api/dashboard/receivings"));

        expect(response.status).toBe(200);
        // NOTE(2026-07-28): Product changed from week-to-date to rolling 30d window
        // (commit that introduced DEFAULT_RECEIVINGS_DAYS). Test updated to match.
        expect(getTodaysReceivedPOsMock).toHaveBeenCalledWith("2026-03-04", "2026-04-04");

        const body = await response.json();
        expect(body).toMatchObject({
            received: [],
            days: 30,
            range: "rolling_30d",
            startDate: "2026-03-04",
            asOf: "2026-04-03",
        });
    });

    it("keeps rolling-day override when days is provided", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-03T18:00:00.000Z"));
        getTodaysReceivedPOsMock.mockResolvedValue([]);

        const response = await GET(new Request("http://localhost/api/dashboard/receivings?days=7"));

        expect(response.status).toBe(200);
        expect(getTodaysReceivedPOsMock).toHaveBeenCalledWith("2026-03-27", "2026-04-04");

        const body = await response.json();
        expect(body).toMatchObject({
            days: 7,
            range: "rolling_days",
        });
    });

    it("computes Monday week start in Denver time", () => {
        expect(getDenverWeekStart(new Date("2026-04-03T18:00:00.000Z"))).toBe("2026-03-30");
    });

    // ── WS4: the payload carries a verdict, not just "invoice matched" ───────
    it("stamps a clean 3-way verdict on a received PO whose bill agrees", async () => {
        getTodaysReceivedPOsMock.mockResolvedValue([receivedPO()]);
        fakeTables.vendor_invoices = [matchedInvoice()];

        const response = await GET(new Request("http://localhost/api/dashboard/receivings?bust=1"));
        const body = await response.json();

        expect(response.status).toBe(200);
        const threeWay = body.received[0]._reconciliation.threeWay;
        expect(threeWay.verdict).toBe("matched");
        expect(threeWay.canComplete).toBe(true);
        expect(threeWay.variances).toEqual([]);
        expect(threeWay.incompleteReason).toBeNull();
        expect(threeWay.lines[0]).toMatchObject({
            productId: "S-17888",
            poQty: 14,
            receivedQty: 14,
            invoiceQty: 14,
            poUnitPrice: 12.5,
            invoiceUnitPrice: 12.5,
        });
    });

    it("names a blocking price variance when the bill dwarfs the PO (125341 shape)", async () => {
        getTodaysReceivedPOsMock.mockResolvedValue([
            receivedPO({
                orderId: "125341",
                total: 163,
                subtotal: 163,
                items: [{ productId: "OMP102", quantity: 1, orderedQuantity: 1, receivedQuantity: 1, unitPrice: 163 }],
            }),
        ]);
        fakeTables.vendor_invoices = [
            matchedInvoice({
                po_number: "125341",
                invoice_number: "1105-A",
                subtotal: 1105,
                total: 1105,
                line_items: JSON.stringify([{ sku: "OMP102", qty: 1, unit_price: 1105 }]),
            }),
        ];

        const response = await GET(new Request("http://localhost/api/dashboard/receivings?bust=1"));
        const body = await response.json();

        const threeWay = body.received[0]._reconciliation.threeWay;
        expect(threeWay.verdict).toBe("exception");
        expect(threeWay.canComplete).toBe(false);
        expect(threeWay.bucket).toEqual(["price"]);
        expect(threeWay.variances[0]).toMatchObject({ bucket: "price", blocking: true, count: 1 });
        expect(Math.round(threeWay.variances[0].dollarImpact)).toBe(942);
    });

    // Plan Pitfall: a "matched" invoice whose PO price side is all zeros must
    // never read matched — there is nothing to compare, so it is incomplete.
    it("never reads matched when the PO carries no unit prices", async () => {
        getTodaysReceivedPOsMock.mockResolvedValue([
            receivedPO({
                items: [{ productId: "S-17888", quantity: 14, orderedQuantity: 14, receivedQuantity: 14 }],
            }),
        ]);
        fakeTables.vendor_invoices = [matchedInvoice()];

        const response = await GET(new Request("http://localhost/api/dashboard/receivings?bust=1"));
        const body = await response.json();

        const threeWay = body.received[0]._reconciliation.threeWay;
        expect(threeWay.verdict).not.toBe("matched");
        expect(threeWay.verdict).toBe("incomplete");
        expect(threeWay.incompleteReason).toBe("po_prices_missing");
        expect(threeWay.canComplete).toBe(false);
    });

    it("leaves threeWay off a received PO with no matched invoice", async () => {
        getTodaysReceivedPOsMock.mockResolvedValue([receivedPO()]);
        fakeTables.vendor_invoices = [];

        const response = await GET(new Request("http://localhost/api/dashboard/receivings?bust=1"));
        const body = await response.json();

        expect(body.received[0]._reconciliation.threeWay).toBeUndefined();
    });

    // ── Gap 24: one bill, several POs ────────────────────────────────────────
    it("names a multi-PO bill on every PO it covers, and reports coversPos", async () => {
        getTodaysReceivedPOsMock.mockResolvedValue([
            receivedPO({
                orderId: "125429",
                supplier: "Miles",
                total: 1344,
                subtotal: 1344,
                items: [{ productId: "S-17888", quantity: 14, orderedQuantity: 14, receivedQuantity: 14, unitPrice: 96 }],
            }),
            receivedPO({
                orderId: "125430",
                supplier: "Miles",
                total: 1344,
                subtotal: 1344,
                items: [{ productId: "S-17900", quantity: 10, orderedQuantity: 10, receivedQuantity: 10, unitPrice: 134.4 }],
            }),
        ]);
        // The bill's legacy po_number names PO 125429 only — exactly the bug.
        fakeTables.vendor_invoices = [
            matchedInvoice({
                id: "inv-multi",
                po_number: "125429",
                invoice_number: "M-100",
                subtotal: 2688,
                total: 2688,
                line_items: JSON.stringify([
                    { sku: "S-17888", qty: 14, unit_price: 96 },
                    { sku: "S-17900", qty: 10, unit_price: 134.4 },
                ]),
            }),
        ];
        fakeTables.bill_po_links = [
            { vendor_invoice_id: "inv-multi", po_number: "125429" },
            { vendor_invoice_id: "inv-multi", po_number: "125430" },
        ];

        const response = await GET(new Request("http://localhost/api/dashboard/receivings?bust=1"));
        const body = await response.json();

        const [first, second] = body.received;
        // The sibling PO is NOT awaiting an invoice any more.
        expect(second._reconciliation.matchedInvoice).toBeTruthy();
        expect(second._reconciliation.matchedInvoice.invoice_number).toBe("M-100");
        // Both rows name every covered PO.
        for (const row of [first, second]) {
            expect(row._reconciliation.matchedInvoice.coversPos).toEqual(["125429", "125430"]);
            expect(row._reconciliation.coversPos).toEqual(["125429", "125430"]);
        }
    });

    it("leaves a single-PO bill without coversPos (no note for the normal case)", async () => {
        getTodaysReceivedPOsMock.mockResolvedValue([receivedPO()]);
        fakeTables.vendor_invoices = [matchedInvoice()];
        fakeTables.bill_po_links = [{ vendor_invoice_id: "inv-1", po_number: "125429" }];

        const response = await GET(new Request("http://localhost/api/dashboard/receivings?bust=1"));
        const body = await response.json();

        const rec = body.received[0]._reconciliation;
        expect(rec.matchedInvoice.invoice_number).toBe("215047605");
        expect(rec.matchedInvoice.coversPos).toBeUndefined();
        expect(rec.coversPos).toBeUndefined();
    });
});
