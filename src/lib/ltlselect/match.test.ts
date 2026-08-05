/**
 * @file    match.test.ts
 * @purpose Unit tests for the pure LTL Select matching logic. No network,
 *          no DB — fixtures mirror the live API shape (probed 2026-08-05).
 * @author  Hermia
 * @created 2026-08-05
 * @deps    vitest, match.ts, types.ts
 */

import { describe, expect, it } from "vitest";
import {
    buildFreightLabel,
    businessDaysBetween,
    computeVariance,
    entryHasScannedAmount,
    extractFinalePoNumber,
    extractHardFinalePoNumber,
    findCorrelatedReception,
    isCollectShipment,
    isExcludedVendor,
    isMultiDeliveryVendor,
    matchVendorFromOrigin,
    parseCollectEntry,
    pickPoForEntry,
    receiveWindowDaysForVendor,
    scoreFreightApplyConfidence,
} from "./match";
import type { LtlSelectInvoice } from "./types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Rootwise inbound COLLECT row (real shape, values representative). */
function rootwiseCollectInvoice(overrides: Partial<LtlSelectInvoice> = {}): LtlSelectInvoice {
    return {
        _id: "inv_rootwise_1",
        identifiers: {
            proNumber: "300183121811",
            bolNumber: "17165341",
            orderNumber: "124915",
            referenceNumber: null,
            pickupNumber: "20260729SLV339170",
            internalTrackingNumber: "17165341",
        },
        shipment: {
            origin: {
                name: "ROOTWISE",
                date: "2026-07-30",
                address: { city: "Evergreen", state: "CO", postal_code: "80439" },
            },
            destination: { name: "BUILDASOIL" },
            carrier: "FXFE",
            booked_at: "2026-07-29T20:00:26.000+00:00",
            rate: {
                paymentType: "COLLECT",
                direction: "CONSIGNEE",
                rateQuoteDetail: { total: 315.71 },
            },
        },
        scannedInvoiceTotal: { invoiceTotal: 393.08, currencyCode: "USD" },
        status: { currentStatus: { code: "DELIVERED" } },
        ...overrides,
    };
}

/** Outbound PREPAID customer freight — must be filtered out. */
function prepaidOutboundInvoice(): LtlSelectInvoice {
    return {
        _id: "inv_outbound_1",
        identifiers: { proNumber: "300183000001", bolNumber: "17000001", orderNumber: null },
        shipment: {
            origin: { name: "BUILDASOIL", date: "2026-07-28", address: { city: "Montrose", state: "CO" } },
            destination: { name: "ACME CUSTOMER" },
            carrier: "FXFE",
            rate: { paymentType: "PREPAID", direction: "SHIPPER", rateQuoteDetail: { total: 412.0 } },
        },
        scannedInvoiceTotal: { invoiceTotal: 412.0 },
        status: { currentStatus: { code: "DELIVERED" } },
    };
}

// ── parseCollectEntry ────────────────────────────────────────────────────────

describe("parseCollectEntry", () => {
    it("extracts the amount from scannedInvoiceTotal.invoiceTotal (not the quote)", () => {
        const entry = parseCollectEntry(rootwiseCollectInvoice());
        expect(entry).not.toBeNull();
        expect(entry!.amount).toBe(393.08);
        expect(entry!.quoteAmount).toBe(315.71);
        expect(entry!.proNumber).toBe("300183121811");
        expect(entry!.bolNumber).toBe("17165341");
        expect(entry!.originName).toBe("ROOTWISE");
        expect(entry!.pickupDate).toBe("2026-07-30");
    });

    it("falls back to the quoted total when no scanned invoice total exists", () => {
        const invoice = rootwiseCollectInvoice({ scannedInvoiceTotal: null });
        const entry = parseCollectEntry(invoice);
        expect(entry).not.toBeNull();
        expect(entry!.amount).toBe(315.71);
    });

    it("filters out PREPAID SHIPPER outbound (customer freight)", () => {
        expect(parseCollectEntry(prepaidOutboundInvoice())).toBeNull();
    });

    it("keeps COLLECT even when only direction=CONSIGNEE is set", () => {
        const invoice = rootwiseCollectInvoice({
            shipment: {
                ...rootwiseCollectInvoice().shipment!,
                rate: { paymentType: "PREPAID", direction: "CONSIGNEE", rateQuoteDetail: { total: 100 } },
            },
        });
        const entry = parseCollectEntry(invoice);
        expect(entry).not.toBeNull();
    });

    it("rejects rows with no usable amount", () => {
        const invoice = rootwiseCollectInvoice({
            shipment: { ...rootwiseCollectInvoice().shipment!, rate: { paymentType: "COLLECT", direction: "CONSIGNEE", rateQuoteDetail: { total: null } } },
            scannedInvoiceTotal: { invoiceTotal: null },
        });
        expect(parseCollectEntry(invoice)).toBeNull();
    });

    it("defensively drops a BUILDASOIL-origin row even if rate flags say COLLECT", () => {
        const invoice = rootwiseCollectInvoice({
            shipment: {
                ...rootwiseCollectInvoice().shipment!,
                origin: { name: "BUILDASOIL", address: { city: "Montrose", state: "CO" } },
            },
        });
        expect(isCollectShipment(invoice)).toBe(false);
        expect(parseCollectEntry(invoice)).toBeNull();
    });
});

// ── isCollectShipment ────────────────────────────────────────────────────────

describe("isCollectShipment", () => {
    it("true for COLLECT/CONSIGNEE inbound", () => {
        expect(isCollectShipment(rootwiseCollectInvoice())).toBe(true);
    });
    it("false for PREPAID/SHIPPER", () => {
        expect(isCollectShipment(prepaidOutboundInvoice())).toBe(false);
    });
});

// ── extractFinalePoNumber ────────────────────────────────────────────────────

describe("extractFinalePoNumber", () => {
    it("extracts a 6-digit Finale PO from orderNumber", () => {
        expect(extractFinalePoNumber(rootwiseCollectInvoice())).toBe("124915");
    });

    it("extracts a 6-digit Finale PO from referenceNumber", () => {
        const invoice = rootwiseCollectInvoice({
            identifiers: { ...rootwiseCollectInvoice().identifiers, orderNumber: null, referenceNumber: "PO 202607" },
        });
        expect(extractFinalePoNumber(invoice)).toBe("202607");
    });

    it("ignores 8-digit ecommerce order refs", () => {
        const invoice = rootwiseCollectInvoice({
            identifiers: { ...rootwiseCollectInvoice().identifiers, orderNumber: null, referenceNumber: "23412345" },
        });
        expect(extractFinalePoNumber(invoice)).toBeNull();
    });

    it("returns null when no 6-digit number exists anywhere", () => {
        const invoice = rootwiseCollectInvoice({
            identifiers: { ...rootwiseCollectInvoice().identifiers, orderNumber: null, referenceNumber: null, bolNumber: "17165341", proNumber: "300183121811" },
        });
        expect(extractFinalePoNumber(invoice)).toBeNull();
    });
});

// ── matchVendorFromOrigin ────────────────────────────────────────────────────

describe("matchVendorFromOrigin", () => {
    it("maps ROOTWISE origin name to Rootwise Soil Dynamics", () => {
        const entry = parseCollectEntry(rootwiseCollectInvoice())!;
        const match = matchVendorFromOrigin(entry);
        expect(match).toEqual({ vendor: "Rootwise Soil Dynamics", matchedBy: "name" });
    });

    it("maps an opaque LVC origin to Surepack USA via the name alias", () => {
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                shipment: {
                    ...rootwiseCollectInvoice().shipment!,
                    origin: { name: "LVC", address: { city: "Las Vegas", state: "NV", postal_code: "89118" } },
                },
            }),
        )!;
        const match = matchVendorFromOrigin(entry);
        expect(match).toEqual({ vendor: "Surepack USA", matchedBy: "name" });
    });

    it("falls back to city/state when the name is opaque", () => {
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                shipment: {
                    ...rootwiseCollectInvoice().shipment!,
                    origin: { name: "WH-LAS1", address: { city: "Las Vegas", state: "NV", postal_code: "89118" } },
                },
            }),
        )!;
        const match = matchVendorFromOrigin(entry);
        expect(match).toEqual({ vendor: "Surepack USA", matchedBy: "city_state" });
    });

    it("maps SPUSA C/O ADVANTAGE WH to Surepack USA by name", () => {
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                identifiers: { ...rootwiseCollectInvoice().identifiers, orderNumber: null },
                shipment: {
                    ...rootwiseCollectInvoice().shipment!,
                    origin: { name: "SPUSA C/O Advantage WH", address: { city: "Las Vegas", state: "NV" } },
                },
            }),
        )!;
        const match = matchVendorFromOrigin(entry);
        expect(match).toEqual({ vendor: "Surepack USA", matchedBy: "name" });
    });

    it("maps gro kashi (with space) to Grokashi", () => {
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                shipment: {
                    ...rootwiseCollectInvoice().shipment!,
                    origin: { name: "Gro Kashi Farms", address: { city: "Laytonville", state: "CA" } },
                },
            }),
        )!;
        expect(matchVendorFromOrigin(entry)?.vendor).toBe("Grokashi");
    });

    it("returns null for unknown origins", () => {
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                shipment: {
                    ...rootwiseCollectInvoice().shipment!,
                    origin: { name: "MYSTERY SUPPLY CO", address: { city: "Nowhere", state: "WY" } },
                },
            }),
        )!;
        expect(matchVendorFromOrigin(entry)).toBeNull();
    });
});

// ── Variance / exclusions / multi-delivery ───────────────────────────────────

describe("variance and vendor flags", () => {
    it("variance = scanned - quoted", () => {
        const entry = parseCollectEntry(rootwiseCollectInvoice())!;
        expect(computeVariance(entry)).toBeCloseTo(393.08 - 315.71, 2);
    });

    it("flags grokashi as excluded", () => {
        expect(isExcludedVendor("Grokashi")).toBe(true);
        expect(isExcludedVendor("Rootwise Soil Dynamics")).toBe(false);
    });

    it("flags rootwise and granite as multi-delivery", () => {
        expect(isMultiDeliveryVendor("Rootwise Soil Dynamics")).toBe(true);
        expect(isMultiDeliveryVendor("Granite Mill Farms")).toBe(true);
        expect(isMultiDeliveryVendor("Surepack USA")).toBe(false);
    });
});

// ── pickPoForEntry ───────────────────────────────────────────────────────────

describe("pickPoForEntry", () => {
    const recentPOs = [
        {
            orderId: "120000",
            vendorName: "Rootwise Soil Dynamics",
            orderDate: "2026-06-20",
            shipments: [],
        },
        {
            orderId: "120123",
            vendorName: "Rootwise Soil Dynamics",
            orderDate: "2026-06-25",
            // pickup 2026-07-30 → receive 2026-08-03 = Mon→Fri = 2 biz days
            shipments: [{ shipmentId: "SH-1", receiveDate: "2026-08-03" }],
        },
        {
            orderId: "120456",
            vendorName: "Granite Mill Farms",
            orderDate: "2026-06-25",
            // farther haul still within 10 biz days of a mid-July pickup
            shipments: [{ shipmentId: "GM-1", receiveDate: "2026-07-14" }],
        },
    ];

    it("Rootwise multi-delivery requires receive within 10 biz days of pickup", () => {
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                shipment: {
                    ...rootwiseCollectInvoice().shipment!,
                    origin: { ...rootwiseCollectInvoice().shipment!.origin!, date: "2026-07-30" },
                },
            }),
        )!;
        const pick = pickPoForEntry(entry, recentPOs, "Rootwise Soil Dynamics");
        expect(pick?.orderId).toBe("120123");
    });

    it("Rootwise does not match on orderDate alone without a receive in window", () => {
        const noRec = [
            {
                orderId: "120999",
                vendorName: "Rootwise Soil Dynamics",
                orderDate: "2026-07-20",
                shipments: [],
            },
        ];
        const entry = parseCollectEntry(rootwiseCollectInvoice())!;
        expect(pickPoForEntry(entry, noRec, "Rootwise Soil Dynamics")).toBeNull();
    });

    it("Granite allows longer calendar span still under 10 biz days", () => {
        // pickup Fri 2026-07-03, receive Fri 2026-07-17 = 10 biz days
        const granitePos = [
            {
                orderId: "124698",
                vendorName: "Granite Mill Farms",
                orderDate: "2026-06-20",
                shipments: [{ shipmentId: "GM-far", receiveDate: "2026-07-17" }],
            },
        ];
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                shipment: {
                    ...rootwiseCollectInvoice().shipment!,
                    origin: {
                        name: "Granite Mill Farms",
                        address: { city: "Missoula", state: "MT", postal_code: "59802" },
                        date: "2026-07-03",
                    },
                    rate: {
                        ...rootwiseCollectInvoice().shipment!.rate!,
                        paymentType: "COLLECT",
                        direction: "CONSIGNEE",
                    },
                },
            }),
        )!;
        expect(matchVendorFromOrigin(entry)?.vendor).toMatch(/Granite/i);
        const pick = pickPoForEntry(entry, granitePos, "Granite Mill Farms");
        expect(pick?.orderId).toBe("124698");
    });

    it("returns null when no PO of that vendor falls in the window", () => {
        const far = parseCollectEntry(
            rootwiseCollectInvoice({
                shipment: {
                    ...rootwiseCollectInvoice().shipment!,
                    origin: { ...rootwiseCollectInvoice().shipment!.origin!, date: "2025-01-01" },
                },
            }),
        )!;
        expect(pickPoForEntry(far, recentPOs, "Rootwise Soil Dynamics")).toBeNull();
    });

    it("does not match POs of other vendors", () => {
        const entry = parseCollectEntry(rootwiseCollectInvoice())!;
        const pick = pickPoForEntry(entry, recentPOs, "Surepack USA");
        expect(pick).toBeNull();
    });

    it("skips DropshipPO order ids (never freight targets)", () => {
        const withDrop = [
            ...recentPOs,
            {
                orderId: "23494827-DropshipPO",
                vendorName: "Rootwise Soil Dynamics",
                orderDate: "2026-07-20",
                shipments: [{ shipmentId: "DS-1", receiveDate: "2026-08-03" }],
            },
        ];
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                shipment: {
                    ...rootwiseCollectInvoice().shipment!,
                    origin: { ...rootwiseCollectInvoice().shipment!.origin!, date: "2026-07-30" },
                },
            }),
        )!;
        const pick = pickPoForEntry(entry, withDrop, "Rootwise Soil Dynamics");
        expect(pick?.orderId).toBe("120123");
        expect(pick?.orderId).not.toMatch(/dropship/i);
    });
});

describe("businessDaysBetween", () => {
    it("same day is 0", () => {
        expect(businessDaysBetween("2026-07-30", "2026-07-30")).toBe(0);
    });
    it("counts only Mon–Fri across a week+", () => {
        // Thu 7/30 → Fri 8/7: Fri 7/31, Mon 8/3, Tue 8/4, Wed 8/5, Thu 8/6, Fri 8/7 = 6
        expect(businessDaysBetween("2026-07-30", "2026-08-07")).toBe(6);
    });
    it("10 biz days is the multi-delivery max band", () => {
        // Fri 7/3 → Fri 7/17
        expect(businessDaysBetween("2026-07-03", "2026-07-17")).toBe(10);
        expect(receiveWindowDaysForVendor("Rootwise Soil Dynamics")).toEqual({
            mode: "business",
            maxDays: 10,
        });
        expect(receiveWindowDaysForVendor("Granite Mill Farms").maxDays).toBe(10);
    });
});

// ── findCorrelatedReception / label ──────────────────────────────────────────

describe("findCorrelatedReception & label", () => {
    it("finds a reception within the window", () => {
        const note = findCorrelatedReception(
            { shipments: [{ shipmentId: "SH-9", receiveDate: "2026-07-31" }] },
            "2026-07-30",
        );
        expect(note).toContain("SH-9");
    });

    it("returns null outside the window", () => {
        expect(
            findCorrelatedReception({ shipments: [{ shipmentId: "SH-9", receiveDate: "2026-05-01" }] }, "2026-07-30"),
        ).toBeNull();
    });

    it("builds a simple Freight + BOL label (no origin/date prose)", () => {
        const entry = parseCollectEntry(rootwiseCollectInvoice())!;
        expect(buildFreightLabel(entry)).toBe("Freight BOL 17165341");
    });

    it("falls back to PRO when BOL missing", () => {
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                identifiers: {
                    proNumber: "300183121811",
                    bolNumber: null,
                    orderNumber: null,
                    referenceNumber: null,
                },
            }),
        )!;
        expect(buildFreightLabel(entry)).toBe("Freight PRO 300183121811");
    });
});

describe("scoreFreightApplyConfidence", () => {
    function baseInput(over: Partial<Parameters<typeof scoreFreightApplyConfidence>[0]> = {}) {
        const entry = parseCollectEntry(rootwiseCollectInvoice())!;
        return {
            entry,
            hardPoRef: null as string | null,
            matchSource: "vendor_window" as const,
            finalePoId: "125080",
            vendor: "Rootwise Soil Dynamics",
            vendorMatchedBy: "name" as const,
            freightAlreadyOnPO: false,
            receiveDiffDays: 3 as number | null,
            hasScannedAmount: true,
            ...over,
        };
    }

    it("HIGH for multi-delivery with receive ≤10 biz d + scanned + name", () => {
        const s = scoreFreightApplyConfidence(baseInput());
        expect(s.confidence).toBe("high");
        expect(s.mayApply).toBe(true);
    });

    it("MEDIUM multi-delivery without receive", () => {
        const s = scoreFreightApplyConfidence(baseInput({ receiveDiffDays: null }));
        expect(s.confidence).toBe("medium");
        expect(s.mayApply).toBe(false);
        expect(s.reasons).toContain("multi_delivery_no_receive");
    });

    it("LOW unmatched / excluded / dropship / already", () => {
        expect(scoreFreightApplyConfidence(baseInput({ matchSource: "unmatched", finalePoId: null })).mayApply).toBe(false);
        expect(scoreFreightApplyConfidence(baseInput({ matchSource: "excluded" })).confidence).toBe("low");
        expect(scoreFreightApplyConfidence(baseInput({ finalePoId: "234-DropshipPO" })).confidence).toBe("low");
        expect(scoreFreightApplyConfidence(baseInput({ freightAlreadyOnPO: true })).confidence).toBe("low");
    });

    it("HIGH single-delivery with hard PO ref", () => {
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                identifiers: {
                    proNumber: "3001",
                    bolNumber: "1716",
                    orderNumber: "124909",
                    referenceNumber: null,
                },
                shipment: {
                    ...rootwiseCollectInvoice().shipment!,
                    origin: {
                        name: "Concentrates, Inc",
                        address: { city: "Milwaukie", state: "OR", postal_code: "97222" },
                        date: "2026-06-22",
                    },
                },
            }),
        )!;
        const s = scoreFreightApplyConfidence({
            entry,
            hardPoRef: "124909",
            matchSource: "po_ref",
            finalePoId: "124909",
            vendor: "Concentrates, Inc",
            vendorMatchedBy: "name",
            freightAlreadyOnPO: false,
            receiveDiffDays: null,
            hasScannedAmount: true,
        });
        expect(s.confidence).toBe("high");
        expect(s.mayApply).toBe(true);
    });

    it("hard PO extract ignores blob-only digits", () => {
        const entry = parseCollectEntry(
            rootwiseCollectInvoice({
                identifiers: {
                    proNumber: "300183121811",
                    bolNumber: "17165341",
                    orderNumber: null,
                    referenceNumber: null,
                    pickupNumber: "20260729SLV339170",
                },
            }),
        )!;
        expect(extractHardFinalePoNumber(entry)).toBeNull();
    });
});
