import { describe, it, expect } from "vitest";
import {
    classifyVendorFreightPattern,
    type PatternEvidence,
    VENDOR_PATTERN_CONFIG,
} from "./vendor-freight-pattern";

function ev(overrides: Partial<PatternEvidence> = {}): PatternEvidence {
    return {
        poId: "PO-X",
        hadFreightOnPO: false,
        invoiceFreight: 0,
        matched: false,
        ...overrides,
    };
}

// ── Will-known overrides win regardless of evidence ─────────────────────────

describe("classifyVendorFreightPattern — Will-known overrides", () => {
    it("Miles → no_freight, high confidence, source=override", () => {
        const r = classifyVendorFreightPattern("Miles Nursery LLC", []);
        expect(r.pattern).toBe("no_freight");
        expect(r.confidence).toBe("high");
        expect(r.source).toBe("override");
    });

    it("Thrive → no_freight regardless of historical contradiction", () => {
        // Even if history would say otherwise, the override wins.
        const evidence: PatternEvidence[] = Array.from({ length: 20 }, () =>
            ev({ hadFreightOnPO: true, invoiceFreight: 100, matched: true }),
        );
        const r = classifyVendorFreightPattern("Thrive Agricultural Solutions", evidence);
        expect(r.pattern).toBe("no_freight");
        expect(r.source).toBe("override");
    });

    it("Colorado Worm → no_freight", () => {
        const r = classifyVendorFreightPattern("Colorado Worm Company", []);
        expect(r.pattern).toBe("no_freight");
    });

    it("Rootwise → bas_freight (we schedule FedEx)", () => {
        const r = classifyVendorFreightPattern("Rootwise Soil Dynamics", []);
        expect(r.pattern).toBe("bas_freight");
        expect(r.source).toBe("override");
    });

    it("Uline → bas_freight", () => {
        const r = classifyVendorFreightPattern("Uline Shipping Supplies", []);
        expect(r.pattern).toBe("bas_freight");
    });

    it("match is case-insensitive substring", () => {
        expect(classifyVendorFreightPattern("MILES, INC.", []).pattern).toBe("no_freight");
        expect(classifyVendorFreightPattern("rootwise inc", []).pattern).toBe("bas_freight");
    });
});

// ── Historical classification ──────────────────────────────────────────────

describe("classifyVendorFreightPattern — historical classification", () => {
    it("classifies as insufficient_data when sample < MIN", () => {
        const evidence = Array.from({ length: VENDOR_PATTERN_CONFIG.MIN_SAMPLE_SIZE - 1 }, () =>
            ev({ hadFreightOnPO: true, invoiceFreight: 100, matched: true }),
        );
        const r = classifyVendorFreightPattern("New Vendor LLC", evidence);
        expect(r.pattern).toBe("insufficient_data");
    });

    it("classifies as vendor_freight at HIGH_CONFIDENCE_SAMPLE × dominance", () => {
        // 18 samples: 16 vendor_freight, 2 no_freight (89% dominance, > 80% HIGH).
        const evidence: PatternEvidence[] = [
            ...Array.from({ length: 16 }, () => ev({ hadFreightOnPO: true, invoiceFreight: 100, matched: true })),
            ...Array.from({ length: 2 }, () => ev({})),
        ];
        const r = classifyVendorFreightPattern("Bulk Freight Vendor", evidence);
        expect(r.pattern).toBe("vendor_freight");
        expect(r.confidence).toBe("high");
        expect(r.source).toBe("history");
    });

    it("classifies as bas_freight when freight is on PO but never on invoice", () => {
        const evidence: PatternEvidence[] = [
            ...Array.from({ length: 16 }, () => ev({ hadFreightOnPO: true, invoiceFreight: 0, matched: false })),
            ...Array.from({ length: 2 }, () => ev({})),
        ];
        const r = classifyVendorFreightPattern("FedEx-Scheduled Vendor", evidence);
        expect(r.pattern).toBe("bas_freight");
        expect(r.confidence).toBe("high");
    });

    it("classifies as no_freight when neither side ever has freight", () => {
        const evidence: PatternEvidence[] = Array.from({ length: 16 }, () => ev({}));
        const r = classifyVendorFreightPattern("Pickup Vendor", evidence);
        expect(r.pattern).toBe("no_freight");
        expect(r.confidence).toBe("high");
    });

    it("classifies as mixed when no single bucket exceeds dominance threshold", () => {
        // 8 vendor_freight, 8 bas_freight, 4 no_freight — no winner above 70%
        const evidence: PatternEvidence[] = [
            ...Array.from({ length: 8 }, () => ev({ hadFreightOnPO: true, invoiceFreight: 100, matched: true })),
            ...Array.from({ length: 8 }, () => ev({ hadFreightOnPO: true, invoiceFreight: 0, matched: false })),
            ...Array.from({ length: 4 }, () => ev({})),
        ];
        const r = classifyVendorFreightPattern("Inconsistent Vendor", evidence);
        expect(r.pattern).toBe("mixed");
    });

    it("classifies as mixed when ambiguous samples (invoice freight didn't match PO) exceed 30%", () => {
        // 12 ambiguous (invoice freight, mismatched PO) + 8 clean vendor_freight — 60% ambiguous
        const evidence: PatternEvidence[] = [
            ...Array.from({ length: 12 }, () => ev({ hadFreightOnPO: true, invoiceFreight: 100, matched: false })),
            ...Array.from({ length: 8 }, () => ev({ hadFreightOnPO: true, invoiceFreight: 50, matched: true })),
        ];
        const r = classifyVendorFreightPattern("Ambiguous Vendor", evidence);
        expect(r.pattern).toBe("mixed");
    });

    it("returns medium confidence when sample size is between MIN and HIGH_CONFIDENCE_SAMPLE", () => {
        // 10 samples (MIN=8 but HIGH=15), all vendor_freight
        const evidence: PatternEvidence[] = Array.from({ length: 10 }, () =>
            ev({ hadFreightOnPO: true, invoiceFreight: 100, matched: true }),
        );
        const r = classifyVendorFreightPattern("Small-Sample Vendor", evidence);
        expect(r.pattern).toBe("vendor_freight");
        expect(r.confidence).toBe("medium");
    });
});
