import type { Page } from "playwright";

import type { SustainableVillageCartLine } from "./sustainable-village-ordering";

export interface ObservedSustainableVillageCartLine {
    productId: string;
    variantId: string;
    quantity: number;
    unitPrice: number | null;
    lineTotal: number | null;
    title: string | null;
}

export interface SustainableVillageCartVerification {
    status: "verified" | "manual_review";
    missingProducts: string[];
    quantityMismatches: string[];
    priceMismatches: string[];
    unexpectedProducts: string[];
}

interface SustainableVillageCartSnapshotItem {
    variant_id: number | null;
    quantity: number;
    price: number | null;
    final_line_price: number | null;
    product_title: string | null;
}

interface SustainableVillageCartSnapshot {
    items?: SustainableVillageCartSnapshotItem[];
}

function centsToDollars(value: number | null | undefined): number | null {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    return Number((value / 100).toFixed(2));
}

export function toSustainableVillageVariantId(variantId: string): number {
    const cleaned = String(variantId || "").trim();
    const gidMatch = cleaned.match(/(\d+)$/);
    const parsed = Number(gidMatch ? gidMatch[1] : cleaned);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid Sustainable Village variant id: ${variantId}`);
    }

    return parsed;
}

function normalizeVariantId(variantId: string | number): string {
    return String(toSustainableVillageVariantId(String(variantId)));
}

function normalizeObservedCart(
    snapshot: SustainableVillageCartSnapshot,
    expected: SustainableVillageCartLine[],
): ObservedSustainableVillageCartLine[] {
    const expectedByVariant = new Map(
        expected.map(line => [normalizeVariantId(line.variantId), line]),
    );

    return (snapshot.items ?? []).flatMap(item => {
        const variantId = item.variant_id ? String(item.variant_id) : "";
        const expectedLine = expectedByVariant.get(variantId);
        if (!expectedLine) return [];

        return [{
            productId: expectedLine.productId,
            variantId,
            quantity: item.quantity,
            unitPrice: centsToDollars(item.price),
            lineTotal: centsToDollars(item.final_line_price),
            title: item.product_title ?? expectedLine.title ?? null,
        }];
    });
}

export async function populateSustainableVillageCart(
    page: Page,
    expected: SustainableVillageCartLine[],
    options: { clearFirst?: boolean } = {},
): Promise<ObservedSustainableVillageCartLine[]> {
    const items = expected.map(line => ({
        id: toSustainableVillageVariantId(line.variantId),
        quantity: line.quantity,
    }));

    const snapshot = await page.evaluate(async ({ items, clearFirst }) => {
        const shopify = (window as any).Shopify;
        const root = typeof shopify?.routes?.root === "string" ? shopify.routes.root : "/";

        if (clearFirst) {
            await fetch(`${root}cart/clear.js`, {
                method: "POST",
                headers: { Accept: "application/json" },
            });
        }

        const addResponse = await fetch(`${root}cart/add.js`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ items }),
        });

        if (!addResponse.ok) {
            const text = await addResponse.text();
            throw new Error(`Sustainable Village cart add failed: ${addResponse.status} ${text.slice(0, 200)}`);
        }

        const cartResponse = await fetch(`${root}cart.js`, {
            headers: { Accept: "application/json" },
        });

        if (!cartResponse.ok) {
            const text = await cartResponse.text();
            throw new Error(`Sustainable Village cart fetch failed: ${cartResponse.status} ${text.slice(0, 200)}`);
        }

        return await cartResponse.json();
    }, {
        items,
        clearFirst: options.clearFirst ?? true,
    }) as SustainableVillageCartSnapshot;

    return normalizeObservedCart(snapshot, expected);
}

export function verifySustainableVillageCart(
    expected: SustainableVillageCartLine[],
    observed: ObservedSustainableVillageCartLine[],
): SustainableVillageCartVerification {
    const observedByProduct = new Map(observed.map(line => [line.productId, line]));
    const expectedProducts = new Set(expected.map(line => line.productId));
    const missingProducts: string[] = [];
    const quantityMismatches: string[] = [];
    const priceMismatches: string[] = [];

    for (const line of expected) {
        const found = observedByProduct.get(line.productId);
        if (!found) {
            missingProducts.push(line.productId);
            continue;
        }
        if (found.quantity !== line.quantity) {
            quantityMismatches.push(line.productId);
        }
        if (
            found.unitPrice !== null &&
            Math.abs(found.unitPrice - line.unitPrice) >= 0.01
        ) {
            priceMismatches.push(line.productId);
        }
    }

    const unexpectedProducts = observed
        .map(line => line.productId)
        .filter(productId => !expectedProducts.has(productId));

    return {
        status: missingProducts.length === 0
            && quantityMismatches.length === 0
            && priceMismatches.length === 0
            && unexpectedProducts.length === 0
            ? "verified"
            : "manual_review",
        missingProducts,
        quantityMismatches,
        priceMismatches,
        unexpectedProducts,
    };
}
