import { describe, it, expect } from "vitest";
import { checkAutoCompleteEligibility, type POForCompletion } from "./po-auto-complete";
import type { PatternEvidence } from "./vendor-freight-pattern";

const NOW = Date.UTC(2026, 4, 15, 12, 0, 0);

function basPO(overrides: Partial<POForCompletion> = {}): POForCompletion {
    return {
        orderId: "PO-001",
        vendorName: "Test Vendor",
        completionState: "complete",
        completionStateSince: new Date(NOW - 50 * 3600 * 1000).toISOString(), // 50h before NOW
        poFreightAmount: 0,
        invoiceFreight: 0,
        hasMatchedInvoice: true,
        ...overrides,
    };
}

// 16 vendor_freight samples → high-confidence "vendor_freight" pattern
function highVendorFreightEvidence(): PatternEvidence[] {
    return Array.from({ length: 16 }, (_, i) => ({
        poId: `prior-${i}`,
        hadFreightOnPO: true,
        invoiceFreight: 100,
        matched: true,
    }));
}

// 16 bas_freight samples → high-confidence "bas_freight" pattern
function highBasFreightEvidence(): PatternEvidence[] {
    return Array.from({ length: 16 }, (_, i) => ({
        poId: `prior-${i}`,
        hadFreightOnPO: true,
        invoiceFreight: 0,
        matched: false,
    }));
}

// 16 no_freight samples → high-confidence "no_freight" pattern
function highNoFreightEvidence(): PatternEvidence[] {
    return Array.from({ length: 16 }, (_, i) => ({
        poId: `prior-${i}`,
        hadFreightOnPO: false,
        invoiceFreight: 0,
        matched: false,
    }));
}

// ── Gate 1: completionState ────────────────────────────────────────────────

describe("checkAutoCompleteEligibility — Gate 1 (state)", () => {
    it("not eligible when completionState is not 'complete'", () => {
        const r = checkAutoCompleteEligibility(
            basPO({ completionState: "received_pending_invoice" }),
            highVendorFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/completionState/);
    });
});

// ── Gate 2: dwell time ─────────────────────────────────────────────────────

describe("checkAutoCompleteEligibility — Gate 2 (dwell time)", () => {
    it("not eligible if completion state is younger than 48h", () => {
        const r = checkAutoCompleteEligibility(
            basPO({
                completionStateSince: new Date(NOW - 10 * 3600 * 1000).toISOString(),
                vendorName: "Bulk Freight Vendor",
                invoiceFreight: 100,
                poFreightAmount: 100,
            }),
            highVendorFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/dwell/);
    });

    it("not eligible when dwell timestamp is missing entirely", () => {
        const r = checkAutoCompleteEligibility(
            basPO({ completionStateSince: null }),
            highVendorFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/no dwell timestamp/);
    });

    it("eligible when dwell exceeds 48h", () => {
        const r = checkAutoCompleteEligibility(
            basPO({
                completionStateSince: new Date(NOW - 49 * 3600 * 1000).toISOString(),
                vendorName: "Bulk Freight Vendor",
                invoiceFreight: 100,
                poFreightAmount: 100,
            }),
            highVendorFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(true);
    });
});

// ── Gate 3: HARD RULE — invoice freight without matching PO freight ────────

describe("checkAutoCompleteEligibility — Gate 3 (red flag: invoice freight without PO match)", () => {
    it("not eligible when invoice has freight but PO has none", () => {
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "Bulk Freight Vendor",
                invoiceFreight: 200,
                poFreightAmount: 0,
            }),
            highVendorFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/red flag/);
    });

    it("not eligible when invoice freight does not match PO freight (>$0.01 delta)", () => {
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "Bulk Freight Vendor",
                invoiceFreight: 200,
                poFreightAmount: 150,
            }),
            highVendorFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/red flag/);
    });

    it("the red flag overrides ALL other gates — even a Will-known override vendor", () => {
        // Miles is no_freight by override, but the invoice has freight that
        // doesn't land on the PO → red flag still wins.
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "Miles Nursery LLC",
                invoiceFreight: 50,
                poFreightAmount: 0,
            }),
            [],
            NOW,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/red flag/);
    });
});

// ── Gate 4: pattern + confidence ───────────────────────────────────────────

describe("checkAutoCompleteEligibility — Gate 4 (vendor pattern allowlist)", () => {
    it("not eligible when pattern confidence is not 'high'", () => {
        // 10 samples = medium confidence (above MIN, below HIGH).
        const evidence: PatternEvidence[] = Array.from({ length: 10 }, () => ({
            poId: "x",
            hadFreightOnPO: true,
            invoiceFreight: 100,
            matched: true,
        }));
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "Small Sample Vendor",
                invoiceFreight: 100,
                poFreightAmount: 100,
            }),
            evidence,
            NOW,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/confidence=medium/);
    });

    it("not eligible when pattern is 'mixed'", () => {
        const evidence: PatternEvidence[] = [
            ...Array.from({ length: 8 }, () => ({ poId: "x", hadFreightOnPO: true, invoiceFreight: 100, matched: true })),
            ...Array.from({ length: 8 }, () => ({ poId: "x", hadFreightOnPO: true, invoiceFreight: 0, matched: false })),
        ];
        const r = checkAutoCompleteEligibility(
            basPO({ vendorName: "Inconsistent Vendor", invoiceFreight: 0, poFreightAmount: 0 }),
            evidence,
            NOW,
        );
        expect(r.eligible).toBe(false);
    });

    it("eligible for vendor_freight pattern when invoice freight matches PO", () => {
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "Bulk Freight Vendor",
                invoiceFreight: 100,
                poFreightAmount: 100,
            }),
            highVendorFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(true);
    });

    it("eligible for bas_freight pattern when PO has freight (regardless of invoice)", () => {
        // Will-known vendor: Rootwise has bas_freight pattern via override.
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "Rootwise Soil Dynamics",
                invoiceFreight: 0,
                poFreightAmount: 75,
            }),
            [],
            NOW,
        );
        expect(r.eligible).toBe(true);
    });

    it("not eligible for bas_freight pattern when PO is missing freight", () => {
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "Rootwise Soil Dynamics",
                invoiceFreight: 0,
                poFreightAmount: 0,
            }),
            [],
            NOW,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/bas_freight pattern expects/);
    });

    it("eligible for no_freight pattern when neither side has freight (Miles)", () => {
        const r = checkAutoCompleteEligibility(
            basPO({ vendorName: "Miles Nursery LLC", invoiceFreight: 0, poFreightAmount: 0 }),
            [],
            NOW,
        );
        expect(r.eligible).toBe(true);
    });

    it("not eligible for no_freight pattern when PO has a freight line", () => {
        const r = checkAutoCompleteEligibility(
            basPO({ vendorName: "Miles Nursery LLC", invoiceFreight: 0, poFreightAmount: 50 }),
            [],
            NOW,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/no_freight pattern but found/);
    });
});

// ── Gate 5: invoice correlation ────────────────────────────────────────────

describe("checkAutoCompleteEligibility — Gate 5 (invoice correlated)", () => {
    it("not eligible when no matched invoice is on file", () => {
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "Bulk Freight Vendor",
                invoiceFreight: 100,
                poFreightAmount: 100,
                hasMatchedInvoice: false,
            }),
            highVendorFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(false);
        if (!r.eligible) expect(r.reason).toMatch(/no matched invoice/);
    });
});

// ── Smoke test of every pattern + happy path ───────────────────────────────

describe("checkAutoCompleteEligibility — happy paths across all patterns", () => {
    it("vendor_freight: complete + dwell + invoice freight matched → eligible", () => {
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "Bulk Freight Vendor",
                invoiceFreight: 100,
                poFreightAmount: 100,
            }),
            highVendorFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(true);
    });

    it("bas_freight: complete + dwell + PO freight + no invoice freight → eligible", () => {
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "FedEx-Scheduled Vendor",
                invoiceFreight: 0,
                poFreightAmount: 25,
            }),
            highBasFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(true);
    });

    it("no_freight: complete + dwell + zero freight both sides → eligible", () => {
        const r = checkAutoCompleteEligibility(
            basPO({
                vendorName: "Pickup Vendor",
                invoiceFreight: 0,
                poFreightAmount: 0,
            }),
            highNoFreightEvidence(),
            NOW,
        );
        expect(r.eligible).toBe(true);
    });
});
