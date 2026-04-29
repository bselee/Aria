import { describe, expect, it, vi } from "vitest";
import { correlatePo } from "./po-resolver";

/**
 * Correlation pipeline tests. Each scenario builds a fake FinaleClient
 * with controlled getOrderDetails / getOrderSummary / listRecentPosByVendor
 * responses and asserts the chosen strategy + confidence + orderId.
 */

type FakePo = {
    orderId: string;
    status: string;
    orderDate: string;
    supplierName: string;
    supplierPartyUrl: string | null;
    total: number;
    skus: string[];
};

function makeClient(opts: {
    /** PO IDs that getOrderDetails resolves successfully. */
    validIds?: string[];
    /** Recent POs returned by listRecentPosByVendor. */
    recent?: FakePo[];
    /** Optional supplier-name overrides for getOrderSummary. */
    suppliersByOrderId?: Record<string, string>;
}) {
    const validIds = opts.validIds ?? [];
    const recent = opts.recent ?? [];
    const suppliers = opts.suppliersByOrderId ?? {};
    return {
        getOrderDetails: vi.fn(async (id: string) => {
            if (validIds.includes(id)) return { orderId: id };
            throw new Error(`PO ${id} not found`);
        }),
        getOrderSummary: vi.fn(async (id: string) => {
            if (validIds.includes(id) || recent.find(p => p.orderId === id)) {
                const fromRecent = recent.find(p => p.orderId === id);
                return {
                    orderId: id,
                    total: fromRecent?.total ?? 0,
                    status: fromRecent?.status ?? "open",
                    supplier: suppliers[id] ?? fromRecent?.supplierName ?? "Unknown",
                };
            }
            return null;
        }),
        listRecentPosByVendor: vi.fn(async () => recent),
    };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

describe("correlatePo — exact strategy", () => {
    it("returns exact match with high confidence when printed PO resolves directly", async () => {
        const client = makeClient({ validIds: ["124302"] });
        const r = await correlatePo({ printedPo: "124302", vendorName: "Riceland", client: client as any });
        expect(r.strategy).toBe("exact");
        expect(r.confidence).toBe("high");
        expect(r.orderId).toBe("124302");
    });

    it("recovers via digit transposition (existing resolveFinalePo behavior)", async () => {
        const client = makeClient({ validIds: ["124302"] });
        const r = await correlatePo({ printedPo: "123402", vendorName: "Riceland", client: client as any });
        expect(r.strategy).toBe("exact");
        expect(r.orderId).toBe("124302");
    });
});

describe("correlatePo — vendor-recent fallback (Will's primary heuristic)", () => {
    it("picks the single recent PO when no SKU/amount signal is available", async () => {
        const client = makeClient({
            validIds: [],
            recent: [
                { orderId: "201", status: "open", orderDate: daysAgo(3), supplierName: "Axiom Print", supplierPartyUrl: null, total: 0, skus: [] },
            ],
        });
        const r = await correlatePo({
            printedPo: "WRONG-PO",
            vendorName: "Axiom",
            client: client as any,
        });
        expect(r.strategy).toBe("vendor-recent");
        expect(r.orderId).toBe("201");
        expect(r.confidence).toBe("medium");
    });

    it("picks the most recent when multiple POs and no signals", async () => {
        const client = makeClient({
            validIds: [],
            recent: [
                { orderId: "older", status: "open", orderDate: daysAgo(30), supplierName: "Axiom", supplierPartyUrl: null, total: 0, skus: [] },
                { orderId: "newer", status: "open", orderDate: daysAgo(2), supplierName: "Axiom", supplierPartyUrl: null, total: 0, skus: [] },
            ],
        });
        const r = await correlatePo({ printedPo: null, vendorName: "Axiom", client: client as any });
        expect(r.strategy).toBe("vendor-recent");
        expect(r.orderId).toBe("newer");
        expect(r.confidence).toBe("low"); // multiple recent w/o signal
    });
});

describe("correlatePo — sku-overlap strategy", () => {
    it("prefers the PO with the most SKU overlap", async () => {
        const client = makeClient({
            recent: [
                { orderId: "PO-A", status: "open", orderDate: daysAgo(5), supplierName: "Axiom", supplierPartyUrl: null, total: 0, skus: ["AX-1", "AX-2"] },
                { orderId: "PO-B", status: "open", orderDate: daysAgo(2), supplierName: "Axiom", supplierPartyUrl: null, total: 0, skus: ["UNRELATED"] },
            ],
        });
        const r = await correlatePo({
            printedPo: null,
            vendorName: "Axiom",
            lineItems: [{ sku: "AX-1" }, { sku: "AX-2" }],
            client: client as any,
        });
        expect(r.strategy).toBe("sku-overlap");
        expect(r.orderId).toBe("PO-A"); // 2/2 overlap beats newer date
        expect(r.confidence).toBe("medium"); // 2 overlaps = medium per rule (≥3 = high)
    });

    it("high confidence when 3+ SKUs overlap", async () => {
        const client = makeClient({
            recent: [
                { orderId: "PO-X", status: "open", orderDate: daysAgo(5), supplierName: "Axiom", supplierPartyUrl: null, total: 0, skus: ["A", "B", "C", "D"] },
            ],
        });
        const r = await correlatePo({
            printedPo: null,
            vendorName: "Axiom",
            lineItems: [{ sku: "A" }, { sku: "B" }, { sku: "C" }],
            client: client as any,
        });
        expect(r.strategy).toBe("sku-overlap");
        expect(r.confidence).toBe("high");
    });
});

describe("correlatePo — amount-proximity strategy", () => {
    it("matches when invoice subtotal is within 5%/$50 of PO total", async () => {
        const client = makeClient({
            recent: [
                { orderId: "PO-CHEAP", status: "open", orderDate: daysAgo(2), supplierName: "Axiom", supplierPartyUrl: null, total: 50.00, skus: [] },
                { orderId: "PO-EXACT", status: "open", orderDate: daysAgo(7), supplierName: "Axiom", supplierPartyUrl: null, total: 1000.00, skus: [] },
            ],
        });
        const r = await correlatePo({
            printedPo: null,
            vendorName: "Axiom",
            invoiceTotal: 1020.00,
            invoiceFreight: 20.00,    // subtotal = 1000.00
            client: client as any,
        });
        expect(r.strategy).toBe("amount-proximity");
        expect(r.orderId).toBe("PO-EXACT");
        expect(r.confidence).toBe("high"); // exact match within tolerance/2
    });

    it("falls through to vendor-recent when no PO is within amount tolerance", async () => {
        const client = makeClient({
            recent: [
                { orderId: "PO-WAY-OFF", status: "open", orderDate: daysAgo(2), supplierName: "Axiom", supplierPartyUrl: null, total: 50.00, skus: [] },
            ],
        });
        const r = await correlatePo({
            printedPo: null,
            vendorName: "Axiom",
            invoiceTotal: 5000.00,
            invoiceFreight: 0,
            client: client as any,
        });
        expect(r.strategy).toBe("vendor-recent");
    });
});

describe("correlatePo — create-draft when nothing correlates", () => {
    it("returns strategy='create-draft' when vendor has no recent POs", async () => {
        const client = makeClient({ recent: [] });
        const r = await correlatePo({
            printedPo: "WRONG",
            vendorName: "Brand New Vendor LLC",
            client: client as any,
        });
        expect(r.strategy).toBe("create-draft");
        expect(r.orderId).toBeNull();
        expect(r.note).toContain("creating a draft");
    });
});

describe("correlatePo — strategy ordering", () => {
    it("exact match wins over SKU overlap (printed PO has authority)", async () => {
        const client = makeClient({
            validIds: ["EXACT"],
            recent: [
                { orderId: "BIGGER-OVERLAP", status: "open", orderDate: daysAgo(2), supplierName: "Axiom", supplierPartyUrl: null, total: 0, skus: ["A", "B", "C", "D"] },
            ],
        });
        const r = await correlatePo({
            printedPo: "EXACT",
            vendorName: "Axiom",
            lineItems: [{ sku: "A" }, { sku: "B" }, { sku: "C" }, { sku: "D" }],
            client: client as any,
        });
        expect(r.strategy).toBe("exact");
        expect(r.orderId).toBe("EXACT");
    });

    it("SKU overlap wins over amount proximity when printed PO misses", async () => {
        const client = makeClient({
            recent: [
                { orderId: "PO-SKU", status: "open", orderDate: daysAgo(7), supplierName: "Axiom", supplierPartyUrl: null, total: 999, skus: ["A", "B", "C"] },
                { orderId: "PO-AMT", status: "open", orderDate: daysAgo(2), supplierName: "Axiom", supplierPartyUrl: null, total: 1000, skus: [] },
            ],
        });
        const r = await correlatePo({
            printedPo: null,
            vendorName: "Axiom",
            invoiceTotal: 1010,
            invoiceFreight: 10,  // subtotal 1000
            lineItems: [{ sku: "A" }, { sku: "B" }, { sku: "C" }],
            client: client as any,
        });
        expect(r.strategy).toBe("sku-overlap");
        expect(r.orderId).toBe("PO-SKU");
    });
});
