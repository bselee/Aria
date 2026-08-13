/**
 * @file    completion-gate.test.ts
 * @purpose Tests for the shared 3-way completion gate (extractInvoiceLines +
 *          evaluateCompletionGate). Encodes the fail-open "skip when line data
 *          is missing" behaviour and the blocking rules for genuine mismatches
 *          (unknown SKU, over-billing, price variance).
 * @author  Aria Coder
 * @created 2026-08-12
 * @deps    vitest
 */

import { describe, expect, it } from "vitest";
import {
    evaluateCompletionGate,
    extractInvoiceLines,
    type CompletionGateInput,
} from "./completion-gate";

/** A minimal gate input for a single PO line + invoice line. */
function gateInput(overrides: Partial<CompletionGateInput> = {}): CompletionGateInput {
    return {
        orderId: "PO-TEST",
        hasReceipt: true,
        hasInvoice: true,
        poLines: [{ productId: "SKU-1", quantity: 100, unitPrice: 10 }],
        invoiceLines: [{ sku: "SKU-1", qty: 100, unitPrice: 10 }],
        receivedQtys: { "SKU-1": 100 },
        packMultipliers: {},
        ...overrides,
    };
}

describe("extractInvoiceLines", () => {
    it("extracts lines from the vendor_invoices line_items column (snake_case prices)", () => {
        const rows = extractInvoiceLines({
            line_items: [
                { qty: 36, sku: "TX70-CaseQt", ext_price: 6237, unit_price: 173.25, description: "ThermX-70 Case 12-1 qt bottles" },
            ],
            raw_data: {},
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].sku).toBe("TX70-CaseQt");
        expect(rows[0].qty).toBe(36);
        expect(rows[0].unitPrice).toBe(173.25);
    });

    it("falls back to raw_data.lineItems when the line_items column is empty", () => {
        const rows = extractInvoiceLines({
            line_items: null,
            raw_data: { lineItems: [{ productId: "SKU-A", quantity: 5, unitPrice: 7.5 }] },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].sku).toBe("SKU-A");
        expect(rows[0].qty).toBe(5);
        expect(rows[0].unitPrice).toBe(7.5);
    });

    it("parses a JSON-string line_items value", () => {
        const rows = extractInvoiceLines({
            line_items: JSON.stringify([{ sku: "SKU-B", qty: 2, unit_price: 9.99 }]),
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].sku).toBe("SKU-B");
        expect(rows[0].unitPrice).toBe(9.99);
    });

    it("returns [] for a row with no extractable lines", () => {
        expect(extractInvoiceLines({ line_items: [], raw_data: {} })).toEqual([]);
        expect(extractInvoiceLines({ line_items: null, raw_data: { lineItems: [] } })).toEqual([]);
        expect(extractInvoiceLines(null)).toEqual([]);
        expect(extractInvoiceLines(undefined)).toEqual([]);
    });
});

describe("evaluateCompletionGate — fail-open on missing data", () => {
    it("skips (ok) when no invoice is matched", () => {
        const r = evaluateCompletionGate(gateInput({ hasInvoice: false, invoiceLines: [] }));
        expect(r.ok).toBe(true);
        expect(r.summary).toMatch(/skipped/);
    });

    it("skips (ok) when the PO has no line-item data", () => {
        const r = evaluateCompletionGate(gateInput({ poLines: [] }));
        expect(r.ok).toBe(true);
        expect(r.summary).toMatch(/skipped/);
    });

    it("skips (ok) when the invoice has no extractable line items", () => {
        const r = evaluateCompletionGate(gateInput({ invoiceLines: [] }));
        expect(r.ok).toBe(true);
        expect(r.summary).toMatch(/skipped/);
    });
});

describe("evaluateCompletionGate — the happy path", () => {
    it("approves when PO, receipt, and invoice lines agree", () => {
        const r = evaluateCompletionGate(gateInput());
        expect(r.ok).toBe(true);
    });

    it("matches a case-insensitive SKU (invoice 'sku-1' vs PO 'SKU-1')", () => {
        const r = evaluateCompletionGate(
            gateInput({ invoiceLines: [{ sku: "sku-1", qty: 100, unitPrice: 10 }] }),
        );
        expect(r.ok).toBe(true);
    });
});

describe("evaluateCompletionGate — unknown SKU (the PO 125051 regression)", () => {
    it("BLOCKS an invoiced SKU that is not on the PO", () => {
        // PO line TX7101 (qty 432); invoice line TX70-CaseQt (qty 36 @ $173.25).
        // This is the exact data that slipped through the old gate.
        const r = evaluateCompletionGate(
            gateInput({
                orderId: "125051",
                poLines: [{ productId: "TX7101", quantity: 432, unitPrice: 0 }],
                invoiceLines: [{ sku: "TX70-CaseQt", qty: 36, unitPrice: 173.25, description: "ThermX-70 Case 12-1 qt bottles" }],
                receivedQtys: { TX7101: 432 },
            }),
        );
        expect(r.ok).toBe(false);
        expect(r.blockReason).toMatch(/not present on the PO/);
    });

    it("still blocks when the PO line has a missing unitPrice (local cache strips prices)", () => {
        const r = evaluateCompletionGate(
            gateInput({
                poLines: [{ productId: "TX7101", quantity: 432, unitPrice: 0 }],
                invoiceLines: [{ sku: "TX70-CaseQt", qty: 36, unitPrice: 173.25 }],
                receivedQtys: { TX7101: 432 },
            }),
        );
        expect(r.ok).toBe(false);
    });
});

describe("evaluateCompletionGate — UOM normalization", () => {
    it("approves a case-billed invoice via packMultiplier", () => {
        // PO: 120 EA. Invoice: 10 CASE @ $126 (12/case) → 120 EA @ $10.50.
        const r = evaluateCompletionGate(
            gateInput({
                poLines: [{ productId: "SKU-CASE", quantity: 120, unitPrice: 10.5 }],
                invoiceLines: [{ sku: "SKU-CASE", qty: 10, unitPrice: 126 }],
                receivedQtys: { "SKU-CASE": 120 },
                packMultipliers: { "SKU-CASE": 12 },
            }),
        );
        expect(r.ok).toBe(true);
    });
});
