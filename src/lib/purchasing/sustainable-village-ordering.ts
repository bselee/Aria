export interface SustainableVillageDraftItem {
    productId: string;
    quantity: number;
    unitPrice: number;
}

export interface SustainableVillageProductMapping {
    variantId: string;
    productUrl?: string | null;
    title?: string | null;
}

export interface SustainableVillageCartLine extends SustainableVillageDraftItem {
    variantId: string;
    productUrl: string | null;
    title: string | null;
}

export interface SustainableVillageCartPlan {
    status: "ready" | "manual_review";
    lines: SustainableVillageCartLine[];
    missingMappings: string[];
}

export function buildSustainableVillageCartPlan(
    items: SustainableVillageDraftItem[],
    mappings: Record<string, SustainableVillageProductMapping>,
): SustainableVillageCartPlan {
    const lines: SustainableVillageCartLine[] = [];
    const missingMappings: string[] = [];

    for (const item of items) {
        const mapping = mappings[item.productId];
        if (!mapping?.variantId) {
            missingMappings.push(item.productId);
            continue;
        }

        lines.push({
            ...item,
            variantId: mapping.variantId,
            productUrl: mapping.productUrl ?? null,
            title: mapping.title ?? null,
        });
    }

    return {
        status: missingMappings.length === 0 ? "ready" : "manual_review",
        lines: missingMappings.length === 0 ? lines : [],
        missingMappings,
    };
}
