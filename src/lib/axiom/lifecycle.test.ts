import { describe, expect, it } from "vitest";

import { assessAxiomDraftPO } from "./lifecycle";

const baseDraft = {
    poNumber: "124900",
    vendorName: "Axiom Print",
    vendorPartyId: "AXIOM",
    items: [
        { productId: "APL102", quantity: 5000, unitPrice: 0.4 },
        { productId: "JPS101", quantity: 250, unitPrice: 0.33704 },
    ],
};

describe("assessAxiomDraftPO", () => {
    it("requires approved templates for every draft PO SKU before order prep", () => {
        const result = assessAxiomDraftPO({
            draft: baseDraft,
            templates: [{ finale_sku: "APL102", axiom_job_name: "APL102", approved: true }],
            activeLifecycles: [],
        });

        expect(result.status).toBe("needs_spec");
        expect(result.missingTemplateSkus).toEqual(["JPS101"]);
        expect(result.templateSkus).toEqual(["APL102"]);
    });

    it("marks the draft ready when every SKU has an approved template", () => {
        const result = assessAxiomDraftPO({
            draft: baseDraft,
            templates: [
                { finale_sku: "APL102", axiom_job_name: "APL102", approved: true },
                { finale_sku: "JPS101", axiom_job_name: "JPS101", approved: true },
            ],
            activeLifecycles: [],
        });

        expect(result.status).toBe("ready_for_order_prep");
        expect(result.missingTemplateSkus).toEqual([]);
        expect(result.duplicateBlockers).toEqual([]);
    });

    it("blocks order prep when the SKU is already active on another Axiom lifecycle", () => {
        const result = assessAxiomDraftPO({
            draft: baseDraft,
            templates: [
                { finale_sku: "APL102", axiom_job_name: "APL102", approved: true },
                { finale_sku: "JPS101", axiom_job_name: "JPS101", approved: true },
            ],
            activeLifecycles: [
                { po_number: "124899", status: "ready_for_order_prep", finale_skus: ["JPS101"] },
            ],
        });

        expect(result.status).toBe("blocked_duplicate");
        expect(result.duplicateBlockers).toEqual([
            { poNumber: "124899", sku: "JPS101", status: "ready_for_order_prep" },
        ]);
    });
});
