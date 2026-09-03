/**
 * @file    three-way-match-runner.test.ts
 * @purpose Tests for the 3-way automation caller + the golden fixture that
 *          documents a clean PO × receipt × invoice verdict. Also locks the
 *          verdict→outcome mapping so "missing receipt" is NEVER recorded as
 *          match_failed.
 * @author  Aria Coder
 * @created 2026-08-12
 * @deps    vitest
 */

import { describe, expect, it } from "vitest";
import {
    evaluateInvoiceThreeWay,
    mapVerdictToOutcome,
    totalLevelVerdict,
} from "./three-way-match-runner";
import type { GatePoLine } from "./completion-gate";
import type { InvoiceLine } from "./completion-gate";

/**
 * ── GOLDEN FIXTURE ──────────────────────────────────────────────────────────
 * A clean 3-way match across the three documents. This is the reference
 * example for "all three legs agree within tolerance → three_way_matched".
 */
const GOLDEN = {
    orderId: "125169",
    poLines: [
        {
            productId: "SKU-SOIL-1",
            description: "BuildASoil 3.0 1.5cuft",
            quantity: 100,
            unitPrice: 50.0,
        },
    ] as GatePoLine[],
    invoiceLines: [
        { sku: "SKU-SOIL-1", qty: 100, unitPrice: 50.0, description: "BuildASoil 3.0 1.5cuft" },
    ] as InvoiceLine[],
    receivedQtys: { "SKU-SOIL-1": 100 },
    packMultipliers: {} as Record<string, number>,
    invoiceTotal: 5000.0,
    poTotal: 5000.0,
};

describe("golden fixture — clean 3-way match", () => {
    it("returns verdict=matched with zero impact", () => {
        const ev = evaluateInvoiceThreeWay({
            orderId: GOLDEN.orderId,
            poLines: GOLDEN.poLines,
            invoiceLines: GOLDEN.invoiceLines,
            hasReceipt: true,
            hasInvoice: true,
            receivedQtys: GOLDEN.receivedQtys,
            packMultipliers: GOLDEN.packMultipliers,
            invoiceTotal: GOLDEN.invoiceTotal,
            poTotal: GOLDEN.poTotal,
        });
        expect(ev.verdict).toBe("matched");
        expect(ev.totalDollarImpact).toBe(0);
        expect(ev.missingLegs).toEqual([]);
    });

    it("maps a clean verdict to three_way_matched (writes confirmed_po_matches)", () => {
        expect(mapVerdictToOutcome("matched")).toBe("three_way_matched");
    });
});

describe("verdict → outcome mapping (never collapse incomplete into match_failed)", () => {
    it("covers every verdict distinctly", () => {
        expect(mapVerdictToOutcome("matched")).toBe("three_way_matched");
        expect(mapVerdictToOutcome("variance")).toBe("three_way_variance");
        expect(mapVerdictToOutcome("exception")).toBe("three_way_exception");
        expect(mapVerdictToOutcome("incomplete")).toBe("three_way_incomplete");
    });
});

describe("missing receipt leg → incomplete (not exception, not match_failed)", () => {
    it("records incomplete when the receipt leg is absent", () => {
        const ev = evaluateInvoiceThreeWay({
            orderId: GOLDEN.orderId,
            poLines: GOLDEN.poLines,
            invoiceLines: GOLDEN.invoiceLines,
            hasReceipt: false,
            hasInvoice: true,
            receivedQtys: {},
            packMultipliers: {},
            invoiceTotal: GOLDEN.invoiceTotal,
            poTotal: GOLDEN.poTotal,
        });
        expect(ev.verdict).toBe("incomplete");
        expect(ev.missingLegs).toContain("receipt");
        expect(mapVerdictToOutcome(ev.verdict)).toBe("three_way_incomplete");
        expect(mapVerdictToOutcome(ev.verdict)).not.toBe("match_failed");
    });
});

describe("over-billing → exception", () => {
    it("blocks when the vendor bills for more than was received", () => {
        const ev = evaluateInvoiceThreeWay({
            orderId: GOLDEN.orderId,
            poLines: GOLDEN.poLines,
            invoiceLines: [{ sku: "SKU-SOIL-1", qty: 100, unitPrice: 50.0 }],
            hasReceipt: true,
            hasInvoice: true,
            receivedQtys: { "SKU-SOIL-1": 60 },
            packMultipliers: {},
            invoiceTotal: GOLDEN.invoiceTotal,
            poTotal: GOLDEN.poTotal,
        });
        expect(ev.verdict).toBe("exception");
        expect(mapVerdictToOutcome(ev.verdict)).toBe("three_way_exception");
    });
});

describe("total-level fallback for invoices without itemized lines", () => {
    it("matches on totals within ±2% (no false price variance)", () => {
        const ev = evaluateInvoiceThreeWay({
            orderId: GOLDEN.orderId,
            poLines: GOLDEN.poLines,
            invoiceLines: [],
            hasReceipt: true,
            hasInvoice: true,
            receivedQtys: GOLDEN.receivedQtys,
            packMultipliers: {},
            invoiceTotal: 5050.0, // 1% over $5000
            poTotal: 5000.0,
        });
        expect(ev.verdict).toBe("matched");
    });

    it("flags a total outside ±2% as variance (review, not exception)", () => {
        const t = totalLevelVerdict(5600.0, 5000.0);
        expect(t.verdict).toBe("variance");
    });

    it("returns incomplete when either side has no amount", () => {
        expect(totalLevelVerdict(0, 5000).verdict).toBe("incomplete");
    });
});
