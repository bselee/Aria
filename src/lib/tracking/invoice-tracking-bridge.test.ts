/**
 * @file    invoice-tracking-bridge.test.ts
 * @purpose Workstream 2 acceptance tests: bridge invoice OCR tracking → shipments
 *          with upsertShipmentEvidence mocked at the edge.
 *
 *          Covers the plan's acceptance criteria:
 *           - OCR text with UPS + PO# → upsert called with that PO (conf 0.92)
 *           - OCR with tracking but no PO → upsert with null PO (conf 0.75)
 *           - no tracking in OCR → no upsert
 *           - LTL carrier + PRO number → Carrier:::PRO encoding
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs before vi.mock factories (vitest hoists vi.mock above all
// top-level consts — a plain `const mock = vi.fn()` would be in the TDZ when
// the factory executes). See skill: vitest-mock-patterns.
const { upsertShipmentEvidenceMock, validatePoRefMock, poRefExistsMock } = vi.hoisted(() => ({
    upsertShipmentEvidenceMock: vi.fn(),
    validatePoRefMock: vi.fn(),
    poRefExistsMock: vi.fn(),
}));

vi.mock("@/lib/tracking/shipment-intelligence", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/tracking/shipment-intelligence")>();
    return {
        ...actual,
        upsertShipmentEvidence: upsertShipmentEvidenceMock,
    };
});

vi.mock("@/lib/purchasing/po-ref-validator", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/purchasing/po-ref-validator")>();
    return {
        ...actual,
        validatePoRef: validatePoRefMock,
        poRefExistsInPurchaseOrders: poRefExistsMock,
    };
});

import {
    bridgeInvoiceTrackingToShipments,
    extractPONumberFromText,
    isLtlShapedNumber,
} from "./invoice-tracking-bridge";

function makeArgs(overrides: Partial<Parameters<typeof bridgeInvoiceTrackingToShipments>[0]> = {}) {
    return {
        ocrText: "",
        poNumber: null,
        vendorName: null,
        invoiceNumber: null,
        source: "ap_invoice" as const,
        sourceRef: "gmail:abc123",
        ...overrides,
    };
}

describe("extractPONumberFromText", () => {
    it("extracts standard PO references", () => {
        expect(extractPONumberFromText("Invoice #2026 PO #124833 total $1,200")).toBe("124833");
        expect(extractPONumberFromText("P.O. 124833")).toBe("124833");
        expect(extractPONumberFromText("Purchase Order 124833 dated 08/05")).toBe("124833");
        expect(extractPONumberFromText("PO-124833")).toBe("124833");
    });

    it("extracts Finale vendor-ref format (last 6 digits after dash)", () => {
        expect(extractPONumberFromText("Ref: 71473626-124833")).toBe("124833");
    });

    it("extracts a labeled 8-digit dropship PO", () => {
        expect(extractPONumberFromText("PO 23581487")).toBe("23581487");
        expect(extractPONumberFromText("P.O. 23578097A")).toBe("23578097A");
        expect(extractPONumberFromText("Purchase Order 23320587 dated 10/26")).toBe("23320587");
    });

    it("does NOT extract a bare 8-digit ref with no PO label", () => {
        expect(extractPONumberFromText("View and pay 23581487")).toBeNull();
    });

    it("extracts across a Number/No. connector, including a newline", () => {
        expect(extractPONumberFromText("PO Number\n125257")).toBe("125257");
        expect(extractPONumberFromText("P.O. Number 125333")).toBe("125333");
        expect(extractPONumberFromText("Approval CodeP.O. NO.\n23576187")).toBe("23576187");
    });

    it("does NOT treat ORDER as a PO label", () => {
        expect(extractPONumberFromText("REF# ORDER 23566017")).toBeNull();
        expect(extractPONumberFromText("ORDER #: 59853790")).toBeNull();
    });

    it("does NOT match PO Box (digits must follow the label, not a word)", () => {
        expect(extractPONumberFromText("PO Box 88741")).toBeNull();
    });

    it("returns null when no PO reference exists", () => {
        expect(extractPONumberFromText("Invoice #20260805 amount due $1,234.56")).toBeNull();
        expect(extractPONumberFromText("")).toBeNull();
    });
});

describe("isLtlShapedNumber", () => {
    it("accepts PRO-style digits and dash-suffixed PROs", () => {
        expect(isLtlShapedNumber("64471684")).toBe(true);
        expect(isLtlShapedNumber("71473626-1")).toBe(true);
        expect(isLtlShapedNumber("123456789012345")).toBe(true);
    });

    it("rejects parcel tracking numbers and short strings", () => {
        expect(isLtlShapedNumber("1Z999AA10123456784")).toBe(false);
        expect(isLtlShapedNumber("123456")).toBe(false);
        expect(isLtlShapedNumber("JD123456789012345678")).toBe(false);
    });
});

describe("bridgeInvoiceTrackingToShipments", () => {
    beforeEach(() => {
        upsertShipmentEvidenceMock.mockReset();
        validatePoRefMock.mockReset();
        poRefExistsMock.mockReset();
        // Default: the PO row lookup misses, so the bridge stores whatever the
        // validator returned. Tests that care about canonicalisation set this.
        poRefExistsMock.mockResolvedValue(null);
        // Identity: validatePoRef accepts whatever it is given (the validator's
        // own correctness is covered in po-ref-validator.test.ts).
        validatePoRefMock.mockImplementation(async (ref: string | null) => ref);
        // Echo the input tracking number so result.trackingNumbers reflects
        // what was actually upserted (mirrors upsertShipmentEvidence return).
        upsertShipmentEvidenceMock.mockImplementation(async (input: { trackingNumber: string }) => ({
            id: "ship-1",
            tracking_number: input.trackingNumber,
        }));
    });

    it("upserts with the invoice PO when OCR has UPS tracking + PO#", async () => {
        const result = await bridgeInvoiceTrackingToShipments(
            makeArgs({
                ocrText:
                    "INVOICE NO. 88231 PO #124833\nUPS Ground Tracking: 1Z999AA10123456784\nTotal: $412.50",
                source: "ap_invoice",
            }),
        );

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledTimes(1);
        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(
            expect.objectContaining({
                trackingNumber: "1Z999AA10123456784",
                poNumber: "124833",
                source: "ap_invoice",
                sourceRef: "gmail:abc123",
                confidence: 0.92,
            }),
        );
        expect(result.upserted).toBe(1);
        expect(result.trackingNumbers).toEqual(["1Z999AA10123456784"]);
    });

    it("prefers the parsed invoice poNumber over OCR-extracted PO", async () => {
        await bridgeInvoiceTrackingToShipments(
            makeArgs({
                ocrText: "UPS 1Z999AA10123456784 PO #124833",
                poNumber: "PO-55555",
            }),
        );

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(
            expect.objectContaining({ poNumber: "55555" }),
        );
    });

    it("falls back to OCR-extracted PO when invoice poNumber is null", async () => {
        await bridgeInvoiceTrackingToShipments(
            makeArgs({
                ocrText: "Freight invoice PO# 98765\nFedEx: 123456789012",
                poNumber: null,
            }),
        );

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(
            expect.objectContaining({ poNumber: "98765", confidence: 0.92 }),
        );
    });

    it("nulls a PO ref rejected by the validator and stores an orphan at 0.75", async () => {
        validatePoRefMock.mockResolvedValue(null);

        const result = await bridgeInvoiceTrackingToShipments(
            makeArgs({
                ocrText: "ADV ORDER 4798\nUPS Ground Tracking: 1Z999AA10123456784",
                poNumber: "4798",
            }),
        );

        expect(validatePoRefMock).toHaveBeenCalledWith("4798", expect.any(String));
        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(
            expect.objectContaining({ poNumber: null, confidence: 0.75 }),
        );
        expect(result.upserted).toBe(1);
    });

    it("hands the validator the caller's spelling, never an upper-cased copy", async () => {
        // Regression: the bridge used to run normalizePoString() on args.poNumber
        // before validating. That is a *comparison* normalizer — it upper-cases and
        // strips labels — so the value it wrote into shipments.po_numbers was
        // "23591647-S-DROPSHIPPO", which no longer joins purchase_orders
        // ("23591647-S-DropshipPO"). Nine live rows, every one carrying an
        // ap_invoice @0.92 ref. The bridge must not change case on its own; label
        // stripping belongs to the validator.
        await bridgeInvoiceTrackingToShipments(
            makeArgs({
                ocrText: "FedEx 520484910873",
                poNumber: "23591647-S-DropshipPO",
            }),
        );

        expect(validatePoRefMock).toHaveBeenCalledWith(
            "23591647-S-DropshipPO",
            expect.any(String),
        );
    });

    it("stores the purchase_orders spelling even when handed a differently-cased ref", async () => {
        validatePoRefMock.mockResolvedValue("23591917-DROPSHIPPO");
        poRefExistsMock.mockResolvedValue("23591917-DropshipPO");

        await bridgeInvoiceTrackingToShipments(
            makeArgs({ ocrText: "FedEx 520484910862", poNumber: "23591917-DROPSHIPPO" }),
        );

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(
            expect.objectContaining({ poNumber: "23591917-DropshipPO", confidence: 0.92 }),
        );
    });

    it("fails open to the validated ref when the PO row is not found", async () => {
        // A freshly created PO may not be in purchase_orders yet; storing the
        // validated ref beats storing nothing.
        validatePoRefMock.mockResolvedValue("23590001-DropshipPO");
        poRefExistsMock.mockResolvedValue(null);

        await bridgeInvoiceTrackingToShipments(
            makeArgs({ ocrText: "FedEx 520484910899", poNumber: "23590001-DropshipPO" }),
        );

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(
            expect.objectContaining({ poNumber: "23590001-DropshipPO", confidence: 0.92 }),
        );
    });

    it("stores tracking with null PO at 0.75 confidence when no PO anywhere", async () => {
        const result = await bridgeInvoiceTrackingToShipments(
            makeArgs({
                ocrText: "FedEx Ground shipment 123456789012 invoice total $88.00",
                source: "default_paid_invoice",
            }),
        );

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledTimes(1);
        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(
            expect.objectContaining({
                poNumber: null,
                confidence: 0.75,
                source: "default_paid_invoice",
            }),
        );
        expect(result.upserted).toBe(1);
    });

    it("encodes LTL PRO numbers with the detected carrier", async () => {
        await bridgeInvoiceTrackingToShipments(
            makeArgs({
                ocrText: "AAA Cooper Transportation Invoice Stmt PRO# 64471684",
                vendorName: "AAA Cooper",
            }),
        );

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(
            expect.objectContaining({
                trackingNumber: "AAA Cooper:::64471684",
                vendorName: "AAA Cooper",
            }),
        );
    });

    it("does not encode parcel numbers with an LTL carrier", async () => {
        await bridgeInvoiceTrackingToShipments(
            makeArgs({
                ocrText: "AAA Cooper Invoice 1Z999AA10123456784",
            }),
        );

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(
            expect.objectContaining({ trackingNumber: "1Z999AA10123456784" }),
        );
    });

    it("does not upsert when OCR contains no tracking numbers", async () => {
        const result = await bridgeInvoiceTrackingToShipments(
            makeArgs({
                ocrText:
                    "INVOICE NO. 20260805 AMOUNT DUE $1,234.56 SUBTOTAL $1,000.00 BALANCE $0.00",
            }),
        );

        expect(upsertShipmentEvidenceMock).not.toHaveBeenCalled();
        expect(result).toEqual({ upserted: 0, trackingNumbers: [] });
    });

    it("does nothing for empty OCR text", async () => {
        const result = await bridgeInvoiceTrackingToShipments(makeArgs({ ocrText: "" }));

        expect(upsertShipmentEvidenceMock).not.toHaveBeenCalled();
        expect(result).toEqual({ upserted: 0, trackingNumbers: [] });
    });

    it("continues to other hits when one upsert throws (best-effort)", async () => {
        upsertShipmentEvidenceMock
            .mockResolvedValueOnce(null) // first hit: upsert returns null (db down)
            .mockResolvedValueOnce({ id: "ship-2", tracking_number: "1Z999AA10123456784" });

        const result = await bridgeInvoiceTrackingToShipments(
            makeArgs({
                ocrText:
                    "Shipment 1: FedEx 123456789012\nShipment 2: UPS 1Z999AA10123456784 PO #124833",
            }),
        );

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledTimes(2);
        expect(result.upserted).toBe(1);
    });
});
