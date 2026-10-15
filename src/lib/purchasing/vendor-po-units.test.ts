/**
 * @file    src/lib/purchasing/vendor-po-units.test.ts
 * @purpose Tests for reading a vendor's own POs and totalling booked units per SKU.
 * @author  Hermia
 * @created 2026-10-15
 * @deps    vitest, ./vendor-po-units
 * @env     none
 */
import { describe, it, expect } from "vitest";
import {
    extractVendorPoLines,
    mergeUnits,
    parsePoNumber,
    poNumberOf,
    sumUnitsBySku,
    type VendorPoLine,
} from "./vendor-po-units";

/** The shape Finale returns for orderViewConnection, quantities as strings. */
function payload(orders: Array<Record<string, unknown>>): unknown {
    return {
        data: {
            orderViewConnection: {
                edges: orders.map((node) => ({ node })),
            },
        },
    };
}

function order(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        orderUrl: "/buildasoilorganics/api/order/124933",
        status: "ORDER_LOCKED",
        orderDate: "2026-06-19T18:00:00",
        supplier: { partyUrl: "/buildasoilorganics/api/party/10154", name: "Amazon" },
        itemList: { edges: [{ node: { product: { productId: "DASH101" }, quantity: "120" } }] },
        ...over,
    };
}

describe("extractVendorPoLines", () => {
    it("reads a PO that carries no Amazon PO number, which the export cannot see", () => {
        const lines = extractVendorPoLines(payload([order()]), "10154");
        expect(lines).toEqual([
            {
                orderUrl: "/buildasoilorganics/api/order/124933",
                status: "ORDER_LOCKED",
                orderDate: "2026-06-19T18:00:00",
                sku: "DASH101",
                quantity: 120,
            },
        ]);
    });

    it("drops cancelled POs and cancelled spellings", () => {
        const lines = extractVendorPoLines(
            payload([
                order({ status: "ORDER_CANCELLED" }),
                order({ status: "Canceled" }),
                order({ status: "ORDER_COMPLETED" }),
            ]),
            "10154",
        );
        expect(lines).toHaveLength(1);
        expect(lines[0].status).toBe("ORDER_COMPLETED");
    });

    it("keeps only the requested supplier party", () => {
        const other = order({ supplier: { partyUrl: "/buildasoilorganics/api/party/10001", name: "Uline" } });
        const lines = extractVendorPoLines(payload([other, order()]), "10154");
        expect(lines).toHaveLength(1);
        expect(lines[0].orderUrl).toContain("124933");
    });

    it("keeps every supplier when no party is given", () => {
        const other = order({ supplier: { partyUrl: "/buildasoilorganics/api/party/10001", name: "Uline" } });
        expect(extractVendorPoLines(payload([other, order()]))).toHaveLength(2);
    });

    it("skips a blank SKU and lines with no product, and tolerates no itemList", () => {
        const messy = order({
            itemList: {
                edges: [
                    { node: { product: { productId: "  " }, quantity: "5" } },
                    { node: { quantity: "5" } },
                    { node: { product: { productId: "FACT101" }, quantity: null } },
                ],
            },
        });
        const lines = extractVendorPoLines(payload([messy, order({ itemList: null })]), "10154");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ sku: "FACT101", quantity: 0 });
    });

    it("returns nothing for an empty or malformed payload rather than throwing", () => {
        expect(extractVendorPoLines(undefined, "10154")).toEqual([]);
        expect(extractVendorPoLines({}, "10154")).toEqual([]);
        expect(extractVendorPoLines({ data: { orderViewConnection: { edges: null } } }, "10154")).toEqual([]);
    });
});

describe("parsePoNumber", () => {
    it("reads strings, numbers and blanks", () => {
        expect(parsePoNumber("120.5")).toBe(120.5);
        expect(parsePoNumber(12)).toBe(12);
        expect(parsePoNumber("")).toBe(0);
        expect(parsePoNumber(null)).toBe(0);
        expect(parsePoNumber(undefined)).toBe(0);
        expect(parsePoNumber("abc")).toBe(0);
    });
});

describe("sumUnitsBySku", () => {
    const lines: VendorPoLine[] = [
        { orderUrl: "a", status: "ORDER_LOCKED", orderDate: "", sku: "DASH101", quantity: 120 },
        { orderUrl: "b", status: "ORDER_COMPLETED", orderDate: "", sku: " DASH101 ", quantity: 40 },
        { orderUrl: "c", status: "ORDER_LOCKED", orderDate: "", sku: "LR44BATT", quantity: 120 },
    ];

    it("totals per SKU and trims keys", () => {
        const totals = sumUnitsBySku(lines);
        expect(totals.get("DASH101")).toBe(160);
        expect(totals.get("LR44BATT")).toBe(120);
        expect(totals.size).toBe(2);
    });

    it("merges two sources into one booked total", () => {
        const booked = sumUnitsBySku(lines);
        mergeUnits(booked, new Map([["DASH101", 160], ["TN830", 2]]));
        expect(booked.get("DASH101")).toBe(320);
        expect(booked.get("TN830")).toBe(2);
    });
});

describe("poNumberOf", () => {
    it("reduces a Finale order url to its PO number", () => {
        expect(poNumberOf("/buildasoilorganics/api/order/124933")).toBe("124933");
        expect(poNumberOf("https://app.finaleinventory.com/buildasoilorganics/api/order/125353")).toBe("125353");
    });

    it("handles the url-encoded form Finale returns for older orders", () => {
        expect(poNumberOf("/buildasoilorganics/api/order/%23125353")).toBe("125353");
    });

    it("accepts a bare PO number and survives junk", () => {
        expect(poNumberOf("124933")).toBe("124933");
        expect(poNumberOf("")).toBe("");
        expect(poNumberOf("   ")).toBe("");
    });
});
