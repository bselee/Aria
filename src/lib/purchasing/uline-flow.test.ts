import { describe, expect, it } from "vitest";

import {
    aggregateUlineDemand,
    buildDraftVerification,
    resolveUlineDraftResolution,
} from "./uline-flow";

describe("aggregateUlineDemand", () => {
    it("unions SKUs and takes the highest quantity across sources", () => {
        const aggregated = aggregateUlineDemand([
            {
                source: "finale",
                items: [
                    { sku: "S-1", description: "Box", requiredQty: 5 },
                    { sku: "S-2", description: "Tape", requiredQty: 2 },
                ],
            },
            {
                source: "request",
                items: [
                    { sku: "S-2", description: "Tape", requiredQty: 7 },
                    { sku: "S-3", description: "Mailer", requiredQty: 1 },
                ],
            },
            {
                source: "basauto",
                items: [
                    { sku: "S-1", description: "Box", requiredQty: 9 },
                ],
            },
        ]);

        expect(aggregated).toEqual([
            { sku: "S-1", description: "Box", requiredQty: 9, sources: ["basauto", "finale"] },
            { sku: "S-2", description: "Tape", requiredQty: 7, sources: ["finale", "request"] },
            { sku: "S-3", description: "Mailer", requiredQty: 1, sources: ["request"] },
        ]);
    });
});

describe("resolveUlineDraftResolution", () => {
    it("reuses the single active ORDER_CREATED draft when one exists", () => {
        const resolution = resolveUlineDraftResolution({
            activeDrafts: [
                { orderId: "124500", orderDate: "2026-04-10", finaleUrl: "https://finale/124500" },
            ],
            recentOrders: [],
        });

        expect(resolution).toEqual({
            action: "reuse_existing_draft",
            draftPO: { orderId: "124500", orderDate: "2026-04-10", finaleUrl: "https://finale/124500" },
        });
    });

    it("requires review when only committed/completed orders exist", () => {
        const resolution = resolveUlineDraftResolution({
            activeDrafts: [],
            recentOrders: [
                { orderId: "124490", status: "Committed", orderDate: "2026-04-11", finaleUrl: "https://finale/124490" },
            ],
        });

        expect(resolution.action).toBe("review_required");
        expect(resolution.reason).toContain("Committed");
    });

    it("requires review when multiple active drafts exist", () => {
        const resolution = resolveUlineDraftResolution({
            activeDrafts: [
                { orderId: "124500", orderDate: "2026-04-10", finaleUrl: "https://finale/124500" },
                { orderId: "124501", orderDate: "2026-04-11", finaleUrl: "https://finale/124501" },
            ],
            recentOrders: [],
        });

        expect(resolution.action).toBe("review_required");
        expect(resolution.reason).toContain("Multiple");
    });

    it("creates a new draft when no existing ULINE PO state blocks it", () => {
        const resolution = resolveUlineDraftResolution({
            activeDrafts: [],
            recentOrders: [],
        });

        expect(resolution).toEqual({ action: "create_new_draft" });
    });
});

describe("buildDraftVerification", () => {
    it("flags missing, too-low, and extra lines while accepting quantities above required", () => {
        const verification = buildDraftVerification(
            [
                { sku: "S-1", description: "Box", requiredQty: 5, sources: ["finale"] },
                { sku: "S-2", description: "Tape", requiredQty: 7, sources: ["request"] },
            ],
            [
                { productId: "S-1", quantity: 6, itemDescription: "Box" },
                { productId: "S-2", quantity: 4, itemDescription: "Tape" },
                { productId: "S-3", quantity: 1, itemDescription: "Extra" },
            ],
        );

        expect(verification.verified).toBe(false);
        expect(verification.quantityRaises).toEqual([
            { sku: "S-2", currentQty: 4, requiredQty: 7, description: "Tape", sources: ["request"] },
        ]);
        expect(verification.missingItems).toEqual([]);
        expect(verification.extraDraftLines).toEqual([
            { sku: "S-3", quantity: 1, description: "Extra" },
        ]);
    });
});
