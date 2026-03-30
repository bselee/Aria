import type { SustainableVillageCartLine } from "./sustainable-village-ordering";

export interface ObservedSustainableVillageCartLine {
    productId: string;
    quantity: number;
    unitPrice: number | null;
}

export interface SustainableVillageCartVerification {
    status: "verified" | "manual_review";
    missingProducts: string[];
    quantityMismatches: string[];
}

export function verifySustainableVillageCart(
    expected: SustainableVillageCartLine[],
    observed: ObservedSustainableVillageCartLine[],
): SustainableVillageCartVerification {
    const observedByProduct = new Map(observed.map(line => [line.productId, line]));
    const missingProducts: string[] = [];
    const quantityMismatches: string[] = [];

    for (const line of expected) {
        const found = observedByProduct.get(line.productId);
        if (!found) {
            missingProducts.push(line.productId);
            continue;
        }
        if (found.quantity !== line.quantity) {
            quantityMismatches.push(line.productId);
        }
    }

    return {
        status: missingProducts.length === 0 && quantityMismatches.length === 0 ? "verified" : "manual_review",
        missingProducts,
        quantityMismatches,
    };
}
