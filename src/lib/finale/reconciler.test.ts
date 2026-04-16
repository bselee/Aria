/**
 * @file    reconciler.test.ts
 * @purpose Unit tests for critical reconciliation business logic.
 *          Covers: validateInvoiceBalance (M2 two-tier gating),
 *          normalizeLineTotal (UOM conversion), reconcileFees (H2 vendor labels + C5 discounts).
 * @author  Aria (Antigravity)
 * @created 2026-03-10
 * @updated 2026-03-10
 * @deps    vitest
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({
    createClientMock: vi.fn(),
}));

import {
    validateInvoiceBalance,
    normalizeLineTotal,
    reconcileFees,
    reconcileInvoiceToPO,
    buildAuditMetadata,
} from "./reconciler";
import type { InvoiceData } from "../pdf/invoice-parser";

vi.mock("../supabase", () => ({
    createClient: createClientMock,
}));

vi.mock("../intelligence/vendor-memory", () => ({
    getVendorPattern: vi.fn().mockResolvedValue(null),
    storeVendorPattern: vi.fn().mockResolvedValue(undefined),
}));

// ──────────────────────────────────────────────────
// TEST HELPERS
// ──────────────────────────────────────────────────

/**
 * Creates a minimal InvoiceData object with sensible defaults.
 * Override any field by passing a partial object.
 */
function makeInvoice(overrides: Partial<InvoiceData> = {}): InvoiceData {
    return {
        documentType: "invoice",
        invoiceNumber: "TEST-001",
        vendorName: "Acme Soil",
        invoiceDate: "2026-03-10",
        lineItems: [
            { description: "Organic Compost", qty: 10, unitPrice: 50, total: 500 },
        ],
        subtotal: 500,
        total: 500,
        amountDue: 500,
        confidence: "high",
        ...overrides,
    } as InvoiceData;
}

// ──────────────────────────────────────────────────
// validateInvoiceBalance
// ──────────────────────────────────────────────────

describe("validateInvoiceBalance", () => {
    it("should return valid when line items sum matches total exactly", () => {
        const invoice = makeInvoice({
            lineItems: [
                { description: "Item A", qty: 10, unitPrice: 20, total: 200 },
                { description: "Item B", qty: 5, unitPrice: 60, total: 300 },
            ],
            total: 500,
        });
        const result = validateInvoiceBalance(invoice);
        expect(result.valid).toBe(true);
        expect(result.gap).toBe(0);
    });

    it("should return valid when total is zero (skip balance check)", () => {
        const invoice = makeInvoice({ total: 0 });
        const result = validateInvoiceBalance(invoice);
        expect(result.valid).toBe(true);
    });

    it("should return valid when fees account for the gap", () => {
        const invoice = makeInvoice({
            lineItems: [
                { description: "Item A", qty: 10, unitPrice: 20, total: 200 },
            ],
            freight: 25,
            tax: 10,
            total: 235,
        });
        const result = validateInvoiceBalance(invoice);
        expect(result.valid).toBe(true);
    });

    it("should return valid when discount accounts for the gap", () => {
        const invoice = makeInvoice({
            lineItems: [
                { description: "Item A", qty: 10, unitPrice: 20, total: 200 },
            ],
            discount: 10,
            total: 190,
        });
        const result = validateInvoiceBalance(invoice);
        expect(result.valid).toBe(true);
    });

    it("should return warn severity for small gaps (>$1 / >2%)", () => {
        // Line items: 10 * 20 = 200. Total: 210. Gap = $10 / 4.76% => warn
        const invoice = makeInvoice({
            lineItems: [
                { description: "Item A", qty: 10, unitPrice: 20, total: 200 },
            ],
            total: 210,
        });
        const result = validateInvoiceBalance(invoice);
        expect(result.valid).toBe(false);
        expect((result as any).severity).toBe("warn");
    });

    it("should return gate severity for large gaps (>$5 / >5%)", () => {
        // Line items: 10 * 20 = 200. Total: 250. Gap = $50 / 20% => gate
        const invoice = makeInvoice({
            lineItems: [
                { description: "Item A", qty: 10, unitPrice: 20, total: 200 },
            ],
            total: 250,
        });
        const result = validateInvoiceBalance(invoice);
        expect(result.valid).toBe(false);
        expect((result as any).severity).toBe("gate");
    });

    it("should skip line items with zero qty or unitPrice", () => {
        // Line items with qty=0 or unitPrice=0 should be excluded from the sum
        const invoice = makeInvoice({
            lineItems: [
                { description: "Item A", qty: 10, unitPrice: 20, total: 200 },
                { description: "Adjustment", qty: 0, unitPrice: 0, total: 0 },
            ],
            total: 200,
        });
        const result = validateInvoiceBalance(invoice);
        expect(result.valid).toBe(true);
    });
});

// ──────────────────────────────────────────────────
// normalizeLineTotal
// ──────────────────────────────────────────────────

describe("normalizeLineTotal", () => {
    it("should return unchanged values when no UOM is provided", () => {
        const result = normalizeLineTotal(10, 5.00);
        expect(result.baseQty).toBe(10);
        expect(result.normalizedPrice).toBe(5.00);
        expect(result.normalized).toBe(false);
    });

    it("should return unchanged values for EA unit", () => {
        const result = normalizeLineTotal(10, 5.00, "EA");
        expect(result.normalized).toBe(false);
        expect(result.baseQty).toBe(10);
    });

    it("should normalize CASE/12 to individual items", () => {
        // 5 cases of 12 at $60/case => 60 EA at $5/EA
        const result = normalizeLineTotal(5, 60.00, "CASE/12");
        expect(result.normalized).toBe(true);
        expect(result.baseQty).toBe(60);
        expect(result.normalizedPrice).toBe(5.00);
    });

    it("should normalize CASE/24 to individual items", () => {
        // 2 cases of 24 at $48/case => 48 EA at $2/EA
        const result = normalizeLineTotal(2, 48.00, "CASE/24");
        expect(result.normalized).toBe(true);
        expect(result.baseQty).toBe(48);
        expect(result.normalizedPrice).toBe(2.00);
    });

    it("should normalize bag to 50 lb", () => {
        // 3 bags at $100/bag => 150 lb at $2/lb
        const result = normalizeLineTotal(3, 100.00, "bag");
        expect(result.normalized).toBe(true);
        expect(result.baseQty).toBe(150);
        expect(result.normalizedPrice).toBe(2.00);
    });

    it("should normalize kg to lb", () => {
        // 10 kg at $5/kg => 22.0462 lb at ~$2.27/lb
        const result = normalizeLineTotal(10, 5.00, "kg");
        expect(result.normalized).toBe(true);
        expect(result.baseQty).toBeCloseTo(22.0462, 2);
        expect(result.normalizedPrice).toBeCloseTo(2.268, 2);
    });

    it("should handle case-insensitive UOM", () => {
        const result = normalizeLineTotal(5, 60.00, "case/12");
        expect(result.normalized).toBe(true);
        expect(result.baseQty).toBe(60);
    });

    it("should return unchanged for LB", () => {
        // LB is already the base unit
        const result = normalizeLineTotal(10, 5.00, "LB");
        expect(result.normalized).toBe(false);
        expect(result.baseQty).toBe(10);
    });
});

// ──────────────────────────────────────────────────
// reconcileFees
// ──────────────────────────────────────────────────

/**
 * Creates a minimal PO summary for reconcileFees testing.
 */
function makePO(adjustments: Array<{ description: string; amount: number }> = []) {
    return {
        orderId: "PO-001",
        status: "open",
        vendorName: "Acme Soil",
        lineItems: [],
        adjustments,
        total: 1000,
        subtotal: 1000,
    } as any;
}

describe("reconcileFees", () => {
    it("should detect new freight fee when PO has none", () => {
        const invoice = makeInvoice({ freight: 50 });
        const po = makePO([]);
        const changes = reconcileFees(invoice, po);
        expect(changes.length).toBeGreaterThanOrEqual(1);
        const freightChange = changes.find(c => c.feeType === "FREIGHT");
        expect(freightChange).toBeDefined();
        expect(freightChange!.amount).toBe(50);
        expect(freightChange!.isNew).toBe(true);
    });

    it("should detect tax fee", () => {
        const invoice = makeInvoice({ tax: 25 });
        const po = makePO([]);
        const changes = reconcileFees(invoice, po);
        const taxChange = changes.find(c => c.feeType === "TAX");
        expect(taxChange).toBeDefined();
        expect(taxChange!.amount).toBe(25);
    });

    it("should skip fees with zero or missing amounts", () => {
        const invoice = makeInvoice({ freight: 0, tax: undefined });
        const po = makePO([]);
        const changes = reconcileFees(invoice, po);
        expect(changes.length).toBe(0);
    });

    it("should skip fee when PO already has same amount", () => {
        const invoice = makeInvoice({ freight: 50 });
        const po = makePO([{ description: "Freight", amount: 50 }]);
        const changes = reconcileFees(invoice, po);
        const freightChange = changes.find(c => c.feeType === "FREIGHT");
        expect(freightChange).toBeUndefined();
    });

    it("should detect fee update when amounts differ materially", () => {
        const invoice = makeInvoice({ freight: 75 });
        const po = makePO([{ description: "Freight", amount: 50 }]);
        const changes = reconcileFees(invoice, po);
        const freightChange = changes.find(c => c.feeType === "FREIGHT");
        expect(freightChange).toBeDefined();
        expect(freightChange!.amount).toBe(75);
        expect(freightChange!.isNew).toBe(false);
    });

    it("should map fuelSurcharge to SHIPPING fee type", () => {
        const invoice = makeInvoice({ fuelSurcharge: 30 });
        const po = makePO([]);
        const changes = reconcileFees(invoice, po);
        const fuelChange = changes.find(c => c.feeType === "SHIPPING");
        expect(fuelChange).toBeDefined();
        expect(fuelChange!.amount).toBe(30);
    });

    it("should apply C5 discount as negative amount via DISCOUNT_20", () => {
        const invoice = makeInvoice({ discount: 25 });
        const po = makePO([]);
        const changes = reconcileFees(invoice, po);
        const discountChange = changes.find(c => c.feeType === "DISCOUNT_20");
        expect(discountChange).toBeDefined();
        expect(discountChange!.amount).toBe(-25);  // Negative!
    });

    it("should flag large fee deltas as needs_approval", () => {
        // Freight above the truckload-safe cap should still require approval
        const invoice = makeInvoice({ freight: 4500 });
        const po = makePO([]);
        const changes = reconcileFees(invoice, po);
        const freightChange = changes.find(c => c.feeType === "FREIGHT");
        expect(freightChange).toBeDefined();
        expect(freightChange!.verdict).toBe("needs_approval");
    });

    it("should auto-approve small fee deltas", () => {
        // Freight of $50 is below $250 auto-approve cap
        const invoice = makeInvoice({ freight: 50 });
        const po = makePO([]);
        const changes = reconcileFees(invoice, po);
        const freightChange = changes.find(c => c.feeType === "FREIGHT");
        expect(freightChange).toBeDefined();
        expect(freightChange!.verdict).toBe("auto_approve");
    });

    // H2: Vendor fee label matching
    it("should match PO adjustments using vendor-learned labels (H2)", () => {
        const invoice = makeInvoice({ freight: 75 });
        // PO has a non-standard label that wouldn't match the hardcoded "Freight"
        const po = makePO([{ description: "Frt Chg Alan to BAS", amount: 50 }]);
        // Without vendor map: should NOT match (different label)
        const changesWithout = reconcileFees(invoice, po, {});
        const freightWithout = changesWithout.find(c => c.feeType === "FREIGHT");
        expect(freightWithout?.isNew).toBe(true);  // Doesn't find existing

        // With vendor map: "frt chg" learned to map to FREIGHT
        const changesWith = reconcileFees(invoice, po, { "frt chg": "FREIGHT" });
        const freightWith = changesWith.find(c => c.feeType === "FREIGHT");
        // Should find the existing PO adjustment via vendor-learned label
        expect(freightWith?.isNew).toBe(false);
    });
});

describe("reconcileInvoiceToPO guardrails", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createClientMock.mockReturnValue(null);
    });

    it("auto-approves freight-only truckload charges when product pricing is unchanged", async () => {
        const invoice = makeInvoice({
            vendorName: "Acme Soil",
            poNumber: "PO-001",
            lineItems: [
                { sku: "SKU-1", description: "Organic Compost", qty: 10, unitPrice: 50, total: 500 },
            ],
            subtotal: 500,
            freight: 3500,
            total: 4000,
            amountDue: 4000,
        });
        const client = {
            getOrderSummary: vi.fn().mockResolvedValue({
                orderId: "PO-001",
                supplier: "Acme Soil",
                supplierName: "Acme Soil",
                status: "Open",
                orderDate: "2026-03-10",
                total: 500,
                subtotal: 500,
                adjustments: [],
                items: [
                    { productId: "SKU-1", quantity: 10, unitPrice: 50, description: "Organic Compost" },
                ],
            }),
        } as any;

        const result = await reconcileInvoiceToPO(invoice, "PO-001", client);

        expect(result.overallVerdict).toBe("auto_approve");
        expect(result.feeChanges.find((fc) => fc.feeType === "FREIGHT")?.verdict).toBe("auto_approve");
    });

    it("still requires approval for non-trivial product price changes", async () => {
        const invoice = makeInvoice({
            vendorName: "Acme Soil",
            poNumber: "PO-001",
            lineItems: [
                { sku: "SKU-1", description: "Organic Compost", qty: 10, unitPrice: 54, total: 540 },
            ],
            subtotal: 540,
            total: 540,
            amountDue: 540,
        });
        const client = {
            getOrderSummary: vi.fn().mockResolvedValue({
                orderId: "PO-001",
                supplier: "Acme Soil",
                supplierName: "Acme Soil",
                status: "Open",
                orderDate: "2026-03-10",
                total: 500,
                subtotal: 500,
                adjustments: [],
                items: [
                    { productId: "SKU-1", quantity: 10, unitPrice: 50, description: "Organic Compost" },
                ],
            }),
        } as any;

        const result = await reconcileInvoiceToPO(invoice, "PO-001", client);

        expect(result.overallVerdict).toBe("needs_approval");
        expect(result.priceChanges[0]?.verdict).toBe("needs_approval");
    });

    it("does not treat the same invoice as a duplicate when it was previously logged against a different PO", async () => {
        const canonicalLimitMock = vi.fn().mockResolvedValue({
            data: [],
            error: null,
        });
        const canonicalOrderMock = vi.fn(() => ({ limit: canonicalLimitMock }));
        const fallbackLimitMock = vi.fn().mockResolvedValue({
            data: [],
            error: null,
        });
        const fallbackOrderMock = vi.fn(() => ({ limit: fallbackLimitMock }));
        const fallbackIlikeMock = vi.fn(() => ({ order: fallbackOrderMock }));
        const fallbackFilterOrderIdMock = vi.fn(() => ({ ilike: fallbackIlikeMock }));
        const eqMock = vi.fn(() => ({
            filter: vi.fn((field: string) => {
                if (field === "metadata->>reconciliationKey") {
                    return { order: canonicalOrderMock };
                }
                return { filter: fallbackFilterOrderIdMock };
            }),
        }));
        const selectMock = vi.fn(() => ({ eq: eqMock }));

        createClientMock.mockReturnValue({
            from: vi.fn(() => ({
                select: selectMock,
            })),
        });

        const invoice = makeInvoice({
            invoiceNumber: "INV-1001",
            vendorName: "Acme Soil",
            poNumber: "PO-001",
            lineItems: [
                { sku: "SKU-1", description: "Organic Compost", qty: 10, unitPrice: 50, total: 500 },
            ],
            subtotal: 500,
            total: 500,
            amountDue: 500,
        });
        const client = {
            getOrderSummary: vi.fn().mockResolvedValue({
                orderId: "PO-001",
                supplier: "Acme Soil",
                supplierName: "Acme Soil",
                status: "Open",
                orderDate: "2026-03-10",
                total: 500,
                subtotal: 500,
                adjustments: [],
                items: [
                    { productId: "SKU-1", quantity: 10, unitPrice: 50, description: "Organic Compost" },
                ],
            }),
        } as any;

        const result = await reconcileInvoiceToPO(invoice, "PO-001", client);

        expect(result.overallVerdict).not.toBe("duplicate");
    });

    it("includes a canonical reconciliation key in audit metadata", () => {
        const metadata = buildAuditMetadata(
            {
                orderId: "PO-001",
                invoiceNumber: "INV-1001",
                vendorName: "Acme Soil LLC",
                invoiceTotal: 500,
                priceChanges: [],
                feeChanges: [],
                trackingUpdate: null,
                overallVerdict: "auto_approve",
                summary: "ok",
                totalDollarImpact: 0,
                autoApplicable: true,
                warnings: [],
            } as any,
            { applied: [], skipped: [], errors: [] },
            "auto",
        );

        expect(metadata).toEqual(expect.objectContaining({
            reconciliationKey: "acme_soil_llc::inv_1001::po_001",
            orderId: "PO-001",
            invoiceNumber: "INV-1001",
            vendorName: "Acme Soil LLC",
        }));
    });
});
