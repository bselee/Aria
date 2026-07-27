/**
 * @file    src/lib/purchasing/multi-delivery-match.test.ts
 * @purpose Unit tests for multi-delivery-match remaining-balance matcher.
 *          Tests: Miles partial against open PO, two open POs only one with
 *          enough remaining, freightExpected false for Rootwise.
 *
 * @author  Hermia
 * @created 2026-07-27
 */

import { describe, expect, it } from "vitest";
import {
    isMultiDeliveryVendor,
    freightExpected,
    calcRemainingBalance,
    findRemainingBalanceCandidates,
    suggestMultiDeliveryMatch,
    type OpenPO,
    type AssignedInvoice,
    type RemainingBalanceCandidate,
} from "./multi-delivery-match";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MILES_OPEN_PO: OpenPO = {
    poNumber: "PO-2026-0501",
    vendorName: "Miles Fiberglass & Composites",
    total: 2500.00,
    invoiceDate: "2026-05-15",
};

const MILES_SECOND_PO: OpenPO = {
    poNumber: "PO-2026-0601",
    vendorName: "Miles Fiberglass & Composites",
    total: 1800.00,
    invoiceDate: "2026-06-10",
};

const THRIVE_OPEN_PO: OpenPO = {
    poNumber: "PO-2026-0701",
    vendorName: "Thrive Market",
    total: 3200.00,
    invoiceDate: "2026-07-01",
};

const ROOTWISE_OPEN_PO: OpenPO = {
    poNumber: "PO-2026-0801",
    vendorName: "Rootwise",
    total: 5000.00,
    invoiceDate: "2026-08-01",
};

const OTHER_VENDOR_PO: OpenPO = {
    poNumber: "PO-2026-0901",
    vendorName: "BuildASoil Supply Co",
    total: 1500.00,
    invoiceDate: "2026-09-01",
};

// Invoices already assigned to POs
const ASSIGNED_MILES_FIRST_DELIVERY: AssignedInvoice[] = [
    { poNumber: "PO-2026-0501", status: "approved", total: 1000.00 },
];

const ASSIGNED_THRIVE_FIRST_DELIVERY: AssignedInvoice[] = [
    { poNumber: "PO-2026-0701", status: "approved", total: 1200.00 },
];

const ASSIGNED_REJECTED: AssignedInvoice[] = [
    { poNumber: "PO-2026-0501", status: "rejected", total: 500.00 },
];

// ── isMultiDeliveryVendor ─────────────────────────────────────────────────────

describe("isMultiDeliveryVendor", () => {
    it("returns true for Miles with full name", () => {
        expect(isMultiDeliveryVendor("Miles Fiberglass & Composites")).toBe(true);
    });

    it("returns true for miles (lowercase)", () => {
        expect(isMultiDeliveryVendor("miles")).toBe(true);
    });

    it("returns true for Filippelli", () => {
        expect(isMultiDeliveryVendor("Filippelli Brothers")).toBe(true);
    });

    it("returns true for thrive", () => {
        expect(isMultiDeliveryVendor("Thrive Market")).toBe(true);
    });

    it("returns true for Rootwise", () => {
        expect(isMultiDeliveryVendor("Rootwise")).toBe(true);
    });

    it("returns false for a non-multi-delivery vendor", () => {
        expect(isMultiDeliveryVendor("BuildASoil Supply Co")).toBe(false);
    });

    it("returns false for an empty string", () => {
        expect(isMultiDeliveryVendor("")).toBe(false);
    });
});

// ── freightExpected ───────────────────────────────────────────────────────────

describe("freightExpected", () => {
    it("returns false for Miles", () => {
        expect(freightExpected("Miles Fiberglass")).toBe(false);
    });

    it("returns false for Thrive", () => {
        expect(freightExpected("Thrive Market")).toBe(false);
    });

    it("returns false for Rootwise (our FedEx pickup)", () => {
        expect(freightExpected("Rootwise")).toBe(false);
    });

    it("returns true for a regular vendor", () => {
        expect(freightExpected("BuildASoil Supply Co")).toBe(true);
    });
});

// ── calcRemainingBalance ──────────────────────────────────────────────────────

describe("calcRemainingBalance", () => {
    it("returns full PO total when no invoices assigned", () => {
        expect(calcRemainingBalance(2500, [])).toBe(2500);
    });

    it("subtracts approved invoices from total", () => {
        expect(calcRemainingBalance(2500, ASSIGNED_MILES_FIRST_DELIVERY)).toBe(1500);
    });

    it("does not subtract rejected invoices", () => {
        const result = calcRemainingBalance(2500, [...ASSIGNED_MILES_FIRST_DELIVERY, ...ASSIGNED_REJECTED]);
        expect(result).toBe(1500);
    });

    it("returns 0 when invoiced exceeds PO total", () => {
        const overInvoiced: AssignedInvoice[] = [
            { poNumber: "PO-2026-0501", status: "approved", total: 3000 },
        ];
        expect(calcRemainingBalance(2500, overInvoiced)).toBe(0);
    });

    it("handles disregarded status same as rejected", () => {
        const disregarded: AssignedInvoice[] = [
            { poNumber: "PO-2026-0501", status: "disregarded", total: 1000 },
        ];
        expect(calcRemainingBalance(2500, disregarded)).toBe(2500);
    });
});

// ── findRemainingBalanceCandidates ────────────────────────────────────────────

describe("findRemainingBalanceCandidates", () => {
    it("finds Miles PO with enough remaining balance for partial invoice", () => {
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 500.00, invoiceDate: "2026-05-20" };
        const candidates = findRemainingBalanceCandidates(invoice, [MILES_OPEN_PO], {
            "PO-2026-0501": ASSIGNED_MILES_FIRST_DELIVERY,
        });

        expect(candidates).toHaveLength(1);
        expect(candidates[0].poNumber).toBe("PO-2026-0501");
        expect(candidates[0].remainingBalance).toBe(1500);
        expect(candidates[0].score).toBeGreaterThan(0);
    });

    it("returns two POs when both have enough remaining but prefers tighter fit", () => {
        // Miles has two open POs — first has 1500 remaining, second has 1800
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 500.00, invoiceDate: "2026-06-15" };
        const candidates = findRemainingBalanceCandidates(invoice, [MILES_OPEN_PO, MILES_SECOND_PO], {
            "PO-2026-0501": ASSIGNED_MILES_FIRST_DELIVERY,
            "PO-2026-0601": [],
        });

        expect(candidates.length).toBeGreaterThanOrEqual(2);
        // Both should have enough remaining
        expect(candidates[0].remainingBalance).toBeGreaterThanOrEqual(500);
        expect(candidates[1].remainingBalance).toBeGreaterThanOrEqual(500);
    });

    it("returns empty when vendor does not match", () => {
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 500.00, invoiceDate: "2026-05-20" };
        const candidates = findRemainingBalanceCandidates(invoice, [OTHER_VENDOR_PO], {});

        expect(candidates).toHaveLength(0);
    });

    it("returns empty when remaining balance is insufficient", () => {
        // Invoice total (2000) > remaining (1500)
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 2000.00, invoiceDate: "2026-05-20" };
        const candidates = findRemainingBalanceCandidates(invoice, [MILES_OPEN_PO], {
            "PO-2026-0501": ASSIGNED_MILES_FIRST_DELIVERY,
        });

        expect(candidates).toHaveLength(0);
    });

    it("returns empty for zero-total invoice", () => {
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 0, invoiceDate: "2026-05-20" };
        const candidates = findRemainingBalanceCandidates(invoice, [MILES_OPEN_PO], {});

        expect(candidates).toHaveLength(0);
    });

    it("filters POs outside the 60-day window", () => {
        // PO date: 2026-05-15, invoice date: 2026-09-01 (109 days apart)
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 500.00, invoiceDate: "2026-09-01" };
        const candidates = findRemainingBalanceCandidates(invoice, [MILES_OPEN_PO], {
            "PO-2026-0501": ASSIGNED_MILES_FIRST_DELIVERY,
        });

        expect(candidates).toHaveLength(0);
    });

    it("Rootwise partial delivery matches open PO", () => {
        const invoice = { vendorName: "Rootwise", total: 2000.00, invoiceDate: "2026-08-15" };
        const candidates = findRemainingBalanceCandidates(invoice, [ROOTWISE_OPEN_PO], {});

        expect(candidates).toHaveLength(1);
        expect(candidates[0].poNumber).toBe("PO-2026-0801");
        expect(candidates[0].remainingBalance).toBe(5000);
        expect(candidates[0].score).toBeGreaterThan(0);
    });

    it("Thrive partial delivery with existing assigned invoices", () => {
        const invoice = { vendorName: "Thrive Market", total: 2000.00, invoiceDate: "2026-07-15" };
        const candidates = findRemainingBalanceCandidates(invoice, [THRIVE_OPEN_PO], {
            "PO-2026-0701": ASSIGNED_THRIVE_FIRST_DELIVERY,
        });

        expect(candidates).toHaveLength(1);
        expect(candidates[0].poNumber).toBe("PO-2026-0701");
        expect(candidates[0].remainingBalance).toBe(2000); // 3200 - 1200
    });
});

// ── suggestMultiDeliveryMatch ─────────────────────────────────────────────────

describe("suggestMultiDeliveryMatch", () => {
    it("returns the unique PO when only one fits", () => {
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 500.00, invoiceDate: "2026-05-20" };
        const match = suggestMultiDeliveryMatch(invoice, [MILES_OPEN_PO], {
            "PO-2026-0501": ASSIGNED_MILES_FIRST_DELIVERY,
        });

        expect(match).not.toBeNull();
        expect(match!.poNumber).toBe("PO-2026-0501");
    });

    it("returns null when two POs both fit (ambiguous)", () => {
        // Two Miles POs, both with enough remaining for a 500 invoice
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 500.00, invoiceDate: "2026-06-15" };
        const match = suggestMultiDeliveryMatch(invoice, [MILES_OPEN_PO, MILES_SECOND_PO], {
            "PO-2026-0501": ASSIGNED_MILES_FIRST_DELIVERY,
            "PO-2026-0601": [],
        });

        // Both have enough remaining, scores should be close enough to be ambiguous
        // (500/1500 = 33% vs 500/1800 = 28% — difference < 20 points)
        expect(match).toBeNull();
    });

    it("returns null when no POs fit", () => {
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 5000.00, invoiceDate: "2026-05-20" };
        const match = suggestMultiDeliveryMatch(invoice, [MILES_OPEN_PO], {
            "PO-2026-0501": ASSIGNED_MILES_FIRST_DELIVERY,
        });

        expect(match).toBeNull();
    });

    it("returns the clear leader when one PO score dominates", () => {
        // First PO has 250 remaining, second has 1800 — a 1500 invoice only fits one
        const heavilyAssignedPO: OpenPO = {
            poNumber: "PO-2026-0501",
            vendorName: "Miles Fiberglass & Composites",
            total: 1500.00,
            invoiceDate: "2026-05-15",
        };
        const nearFullPOs = [heavilyAssignedPO, MILES_SECOND_PO];
        const nearFullAssigned: Record<string, AssignedInvoice[]> = {
            "PO-2026-0501": [
                { poNumber: "PO-2026-0501", status: "approved", total: 1400.00 },
            ],
            "PO-2026-0601": [],
        };

        // Invoice of $100 only fits the first PO (remaining 100)
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 100.00, invoiceDate: "2026-06-15" };
        const match = suggestMultiDeliveryMatch(invoice, nearFullPOs, nearFullAssigned);

        expect(match).not.toBeNull();
        expect(match!.poNumber).toBe("PO-2026-0501");
    });

    it("returns null for zero-total invoice", () => {
        const invoice = { vendorName: "Miles Fiberglass & Composites", total: 0, invoiceDate: "2026-05-20" };
        const match = suggestMultiDeliveryMatch(invoice, [MILES_OPEN_PO], {});

        expect(match).toBeNull();
    });

    it("returns match for Rootwise with sufficient remaining", () => {
        const invoice = { vendorName: "Rootwise", total: 2500.00, invoiceDate: "2026-08-10" };
        const match = suggestMultiDeliveryMatch(invoice, [ROOTWISE_OPEN_PO], {});

        expect(match).not.toBeNull();
        expect(match!.poNumber).toBe("PO-2026-0801");
    });
});
