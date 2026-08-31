import { describe, it, expect } from "vitest";
import {
    resolveVendorLeadOverride,
    resolveVendorLeadFloor,
} from "./vendor-lead-overrides";
import { resolveLeadTimeDays } from "./oag-powder-policy";

describe("vendor-lead-overrides", () => {
    it("resolves fixed overrides (multi-delivery inflation / long-lead import)", () => {
        expect(resolveVendorLeadOverride("CR Minerals Company, LLC")?.days).toBe(14);
        expect(resolveVendorLeadOverride("Covico")?.days).toBe(188);
        expect(resolveVendorLeadOverride("Some Other Vendor")).toBeNull();
        expect(resolveVendorLeadOverride(null)).toBeNull();
    });

    it("resolves minimum floors (made-to-order / working-day cycle)", () => {
        expect(resolveVendorLeadFloor("Colorful Packaging Ltd")?.days).toBe(50);
        expect(resolveVendorLeadFloor("Sustainable Village")?.days).toBe(14);
        expect(resolveVendorLeadFloor("Some Other Vendor")).toBeNull();
    });

    it("fixed override beats SKU observed (CR Minerals 33d → 14d)", () => {
        const r = resolveLeadTimeDays({
            productId: "PU100",
            vendorName: "CR Minerals Company, LLC",
            skuObservedLeadDays: 33,
            skuObservedProvenance: "33d SKU plan",
            baseLeadDays: 33,
        });
        expect(r.days).toBe(14);
        expect(r.provenance).toContain("multi-delivery");
    });

    it("long-lead import override applies with no history (Covico default 21d → 188d)", () => {
        const r = resolveLeadTimeDays({
            productId: "CWP09",
            vendorName: "Covico",
            baseLeadDays: 21,
        });
        expect(r.days).toBe(188);
        expect(r.provenance).toContain("coconut water powder");
    });

    it("made-to-order floor raises PO-after-order low (Colorful 17d → 50d)", () => {
        const r = resolveLeadTimeDays({
            productId: "BBV101BAG",
            vendorName: "Colorful Packaging Ltd",
            skuObservedLeadDays: 17,
            skuObservedProvenance: "17d SKU plan",
            baseLeadDays: 17,
        });
        expect(r.days).toBe(50);
        expect(r.provenance).toContain("vendor floor");
    });

    it("floor never lowers a healthy measured lead (Colorful 57d stays 57d)", () => {
        const r = resolveLeadTimeDays({
            productId: "CRAFT1BAG",
            vendorName: "Colorful Packaging Ltd",
            skuObservedLeadDays: 57,
            skuObservedProvenance: "57d SKU plan",
            baseLeadDays: 57,
        });
        expect(r.days).toBe(57);
    });

    it("OAG powder MTO still wins over vendor override", () => {
        const r = resolveLeadTimeDays({
            productId: "OAG222",
            vendorName: "CR Minerals Company, LLC",
            baseLeadDays: 14,
        });
        expect(r.days).toBe(120);
    });

    it("SKU observed passes through for non-overridden vendors", () => {
        const r = resolveLeadTimeDays({
            productId: "RAWKELPMEAL",
            vendorName: "Thorvin",
            skuObservedLeadDays: 34,
            skuObservedProvenance: "34d SKU plan",
            baseLeadDays: 34,
        });
        expect(r.days).toBe(34);
    });
});
