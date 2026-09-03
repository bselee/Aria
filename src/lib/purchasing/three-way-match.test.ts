/**
 * @file    three-way-match.test.ts
 * @purpose Tests for the canonical 3-way match gate. Each test encodes a real
 *          AP rule, not an implementation detail.
 * @author  Hermia
 * @created 2026-07-29
 * @deps    vitest
 */

import { describe, expect, it } from "vitest";
import {
    evaluateThreeWayMatch,
    DEFAULT_TOLERANCES,
    type ThreeWayLine,
} from "./three-way-match";

/** A clean line where all three documents agree: 100 units @ $10.00. */
function cleanLine(overrides: Partial<ThreeWayLine> = {}): ThreeWayLine {
    return {
        productId: "SKU-1",
        description: "Widget",
        poQty: 100,
        poUnitPrice: 10.0,
        receivedQty: 100,
        invoiceQty: 100,
        invoiceUnitPrice: 10.0,
        ...overrides,
    };
}

function input(lines: ThreeWayLine[], overrides: Record<string, unknown> = {}) {
    return {
        orderId: "PO-TEST",
        hasPurchaseOrder: true,
        hasReceipt: true,
        hasInvoice: true,
        lines,
        ...overrides,
    };
}

describe("3-way match — all three documents required", () => {
    it("cannot match without a receipt (goods not yet on the dock)", () => {
        const r = evaluateThreeWayMatch(input([cleanLine()], { hasReceipt: false }));
        expect(r.verdict).toBe("incomplete");
        expect(r.canApprove).toBe(false);
        expect(r.missingLegs).toContain("receipt");
    });

    it("cannot match without an invoice", () => {
        const r = evaluateThreeWayMatch(input([cleanLine()], { hasInvoice: false }));
        expect(r.verdict).toBe("incomplete");
        expect(r.missingLegs).toContain("invoice");
    });

    it("cannot match without a purchase order", () => {
        const r = evaluateThreeWayMatch(input([cleanLine()], { hasPurchaseOrder: false }));
        expect(r.verdict).toBe("incomplete");
        expect(r.missingLegs).toContain("purchase_order");
    });

    it("reports every missing leg at once", () => {
        const r = evaluateThreeWayMatch(
            input([cleanLine()], { hasReceipt: false, hasInvoice: false }),
        );
        expect(r.missingLegs).toEqual(
            expect.arrayContaining(["receipt", "invoice"]),
        );
    });
});

describe("3-way match — the happy path", () => {
    it("approves when PO, receipt, and invoice all agree", () => {
        const r = evaluateThreeWayMatch(input([cleanLine()]));
        expect(r.verdict).toBe("matched");
        expect(r.canApprove).toBe(true);
        expect(r.discrepancies).toHaveLength(0);
        expect(r.totalDollarImpact).toBe(0);
    });

    it("approves a small price change inside tolerance (2%)", () => {
        // $10.00 -> $10.15 is 1.5%, under the 2% band.
        const r = evaluateThreeWayMatch(input([cleanLine({ invoiceUnitPrice: 10.15 })]));
        expect(r.verdict).toBe("matched");
        expect(r.canApprove).toBe(true);
    });

    it("approves a multi-line PO where every line agrees", () => {
        const r = evaluateThreeWayMatch(
            input([
                cleanLine({ productId: "SKU-1" }),
                cleanLine({ productId: "SKU-2", poQty: 50, receivedQty: 50, invoiceQty: 50 }),
            ]),
        );
        expect(r.verdict).toBe("matched");
        expect(r.canApprove).toBe(true);
    });
});

describe("3-way match — quantity discipline", () => {
    it("BLOCKS billing for more than was received (cardinal rule)", () => {
        // Vendor bills 100, only 60 arrived. Never pay the difference.
        const r = evaluateThreeWayMatch(input([cleanLine({ receivedQty: 60 })]));
        expect(r.verdict).toBe("exception");
        expect(r.canApprove).toBe(false);
        const d = r.discrepancies.find((x) => x.kind === "qty_over_billed");
        expect(d?.blocking).toBe(true);
        expect(d?.dollarImpact).toBe(400); // 40 units × $10
    });

    it("does NOT block payment for a short shipment actually received", () => {
        // 60 of 100 arrived and the vendor billed only for those 60.
        // We owe for what we got; the shortfall is informational.
        const r = evaluateThreeWayMatch(
            input([cleanLine({ receivedQty: 60, invoiceQty: 60 })]),
        );
        expect(r.canApprove).toBe(false);          // surfaced for review
        expect(r.verdict).toBe("variance");        // not a hard exception
        const short = r.discrepancies.find((x) => x.kind === "qty_short_received");
        expect(short?.blocking).toBe(false);
    });

    it("flags an over-delivery without blocking payment", () => {
        const r = evaluateThreeWayMatch(
            input([cleanLine({ receivedQty: 130, invoiceQty: 130 })]),
        );
        const over = r.discrepancies.find((x) => x.kind === "qty_over_received");
        expect(over?.blocking).toBe(false);
    });

    it("tolerates a 1-unit rounding difference", () => {
        const r = evaluateThreeWayMatch(input([cleanLine({ invoiceQty: 101 })]));
        expect(r.discrepancies.filter((d) => d.blocking)).toHaveLength(0);
    });

    it("BLOCKS an invoice line that never appeared on the PO", () => {
        const r = evaluateThreeWayMatch(
            input([cleanLine({ productId: "GHOST", poQty: 0, poUnitPrice: 0 })]),
        );
        expect(r.verdict).toBe("exception");
        const d = r.discrepancies.find((x) => x.kind === "line_not_on_po");
        expect(d?.blocking).toBe(true);
    });
});

describe("3-way match — price discipline", () => {
    it("BLOCKS a price increase beyond tolerance", () => {
        // $10.00 -> $12.00 is 20%, far outside the 2% band.
        const r = evaluateThreeWayMatch(input([cleanLine({ invoiceUnitPrice: 12.0 })]));
        expect(r.verdict).toBe("exception");
        expect(r.canApprove).toBe(false);
        const d = r.discrepancies.find((x) => x.kind === "price_variance");
        expect(d?.blocking).toBe(true);
        expect(d?.dollarImpact).toBe(200); // $2 × 100 units
    });

    it("allows a sub-dollar variance on a cheap item via the absolute band", () => {
        // $0.50 -> $1.00 is 100%, but only $0.50 absolute — inside priceAbs $1.
        const r = evaluateThreeWayMatch(
            input([cleanLine({ poUnitPrice: 0.5, invoiceUnitPrice: 1.0 })]),
        );
        expect(r.discrepancies.filter((d) => d.blocking)).toHaveLength(0);
    });

    it("honours a tightened per-vendor tolerance", () => {
        // 1.5% passes by default but fails at a 1% tolerance.
        const r = evaluateThreeWayMatch(
            input([cleanLine({ invoiceUnitPrice: 10.15 })], {
                tolerances: { pricePct: 0.01, priceAbs: 0 },
            }),
        );
        expect(r.verdict).toBe("exception");
    });

    it("prices the variance on units received, not units billed", () => {
        // Billed 100 @ $12 but only 80 received. Price impact covers the 80.
        const r = evaluateThreeWayMatch(
            input([cleanLine({ receivedQty: 80, invoiceUnitPrice: 12.0 })]),
        );
        const price = r.discrepancies.find((x) => x.kind === "price_variance");
        expect(price?.dollarImpact).toBe(160); // $2 × 80
    });
});

describe("3-way match — unit-of-measure normalization", () => {
    it("matches a case-billed invoice against a per-each PO", () => {
        // PO: 120 EA @ $10.50. Invoice: 10 CASE @ $126.00 (12 per case).
        // Normalized: 120 EA @ $10.50 — identical.
        const r = evaluateThreeWayMatch(
            input([
                {
                    productId: "SKU-CASE",
                    poQty: 120,
                    poUnitPrice: 10.5,
                    receivedQty: 120,
                    invoiceQty: 10,
                    invoiceUnitPrice: 126.0,
                    packMultiplier: 12,
                },
            ]),
        );
        expect(r.verdict).toBe("matched");
        expect(r.canApprove).toBe(true);
    });

    it("raises a false exception when the pack multiplier is omitted", () => {
        // The exact bug this normalization prevents: 10 vs 120 looks like a
        // massive short-ship, and $126 vs $10.50 looks like a 12x price spike.
        const r = evaluateThreeWayMatch(
            input([
                {
                    productId: "SKU-CASE",
                    poQty: 120,
                    poUnitPrice: 10.5,
                    receivedQty: 120,
                    invoiceQty: 10,
                    invoiceUnitPrice: 126.0,
                    // packMultiplier omitted
                },
            ]),
        );
        expect(r.verdict).toBe("exception");
    });

    it("still catches a real overcharge on case-billed goods", () => {
        // 10 CASE @ $150 = $12.50/EA against a $10.50 PO — a genuine 19% rise.
        const r = evaluateThreeWayMatch(
            input([
                {
                    productId: "SKU-CASE",
                    poQty: 120,
                    poUnitPrice: 10.5,
                    receivedQty: 120,
                    invoiceQty: 10,
                    invoiceUnitPrice: 150.0,
                    packMultiplier: 12,
                },
            ]),
        );
        expect(r.verdict).toBe("exception");
        expect(r.discrepancies.some((d) => d.kind === "price_variance")).toBe(true);
    });
});

describe("3-way match — defaults", () => {
    it("ships with conventional AP tolerances", () => {
        expect(DEFAULT_TOLERANCES.pricePct).toBe(0.02);
        expect(DEFAULT_TOLERANCES.qtyAbsUnits).toBe(1);
    });
});

describe("3-way match — acceptance: real receipt quantities catch the faked-data bug", () => {
    it("BLOCKS when invoice bills 100 but only 60 arrived (real receivedQty=60)", () => {
        // This is the scenario the old code NEVER caught because it set
        // receivedQty = poQty when hasReceipt was true.
        const r = evaluateThreeWayMatch(input([cleanLine({ receivedQty: 60 })]));
        expect(r.verdict).toBe("exception");
        expect(r.canApprove).toBe(false);
        const d = r.discrepancies.find((x) => x.kind === "qty_over_billed");
        expect(d?.blocking).toBe(true);
        expect(d?.dollarImpact).toBe(400); // 40 units x $10
    });

    it("flags short shipment as non-blocking variance when invoice bills only what arrived", () => {
        // 60 of 100 arrived, vendor correctly billed only 60.
        // Payment for received goods should proceed; shortfall is informational.
        const r = evaluateThreeWayMatch(
            input([cleanLine({ receivedQty: 60, invoiceQty: 60 })]),
        );
        expect(r.verdict).toBe("variance");
        expect(r.canApprove).toBe(false); // surfaced for review, not auto-approved
        const short = r.discrepancies.find((x) => x.kind === "qty_short_received");
        expect(short?.blocking).toBe(false);
        expect(short?.message).toContain("short 40");
    });

    it("does NOT assert over-bill when receivedQty is null (unknown receipt, deferred load)", () => {
        // HERMIA(2026-08-27): the dashboard GET path defers Finale shipment
        // detail fetches to POST complete_po for latency, so receivedQty is
        // null on paint even for a fully-received PO. null ≠ 0: the module
        // must not claim "billed 100 but received 0" when the receipt leg
        // simply hasn't been loaded yet. PO 125212: Finale auto-completed it
        // (amounts matched), yet the panel showed a fake blocking overbill.
        const r = evaluateThreeWayMatch(input([cleanLine({ receivedQty: null })]));
        const over = r.discrepancies.find((x) => x.kind === "qty_over_billed");
        expect(over).toBeUndefined();
        // Price agreement still verified (unit prices are in the bulk payload).
        const price = r.discrepancies.find((x) => x.kind === "price_variance");
        expect(price).toBeUndefined();
    });

    it("BLOCKS over-billing through case-normalized quantity (pack multiplier)", () => {
        // PO: 120 EA @ $10.00. Received: 60 EA.
        // Invoice: 10 cases @ $120/case, 12 per case = 120 EA.
        // 120 billed vs 60 received = 60-unit overbill. $10/EA × 60 = $600.
        const r = evaluateThreeWayMatch(
            input([
                cleanLine({
                    poQty: 120,
                    receivedQty: 60,
                    invoiceQty: 10,
                    invoiceUnitPrice: 120.0,
                    packMultiplier: 12,
                }),
            ]),
        );
        expect(r.verdict).toBe("exception");
        expect(r.canApprove).toBe(false);
        const d = r.discrepancies.find((x) => x.kind === "qty_over_billed");
        expect(d?.blocking).toBe(true);
        expect(d?.dollarImpact).toBe(600); // 60 EA × $10
    });

    it("flags short shipment as non-blocking when invoice and receipt match in base units (pack multiplier)", () => {
        // PO: 120 EA @ $10.00. Received: 60 EA.
        // Invoice: 5 cases @ $120/case, 12 per case = 60 EA (correctly billed).
        // No over-bill; shortfall of 60 EA surfaced as informational variance.
        const r = evaluateThreeWayMatch(
            input([
                cleanLine({
                    poQty: 120,
                    receivedQty: 60,
                    invoiceQty: 5,
                    invoiceUnitPrice: 120.0,
                    packMultiplier: 12,
                }),
            ]),
        );
        expect(r.verdict).toBe("variance");
        expect(r.canApprove).toBe(false);
        const overBill = r.discrepancies.find((x) => x.kind === "qty_over_billed");
        expect(overBill).toBeUndefined(); // invoice matches receipt in base units
        const short = r.discrepancies.find((x) => x.kind === "qty_short_received");
        expect(short?.blocking).toBe(false);
        expect(short?.message).toContain("short 60");
    });
});
