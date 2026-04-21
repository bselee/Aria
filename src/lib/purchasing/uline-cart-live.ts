import type { Page } from "playwright";
import type { FinaleClient } from "../finale/client";
import {
    planDraftPOCartUpdates,
    type CartVerificationResult,
    type ExpectedUlineCartItem,
    type ObservedUlineCartRow,
} from "../../cli/order-uline-cart";

function parseCurrency(value: string | null | undefined): number | null {
    if (!value) return null;
    const cleaned = value.replace(/,/g, "");
    const match = cleaned.match(/\$?(-?\d+(?:\.\d{1,2})?)/);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractUlineModel(text: string): string | null {
    // H- prefix models (e.g. H-255BL): no word boundary before H, use lookahead for space
    // S- prefix models (e.g. S-1665, S-4796): word boundary works since S is surrounded by word chars
    const hMatch = text.match(/(?<![A-Z])H-\d{3,6}[A-Z]{0,2}(?!\d)/);
    const sMatch = text.match(/\bS-[A-Z]?\d{3,6}[A-Z]?\b/);
    if (hMatch) return hMatch[0];
    if (sMatch) return sMatch[0];
    return null;
}

function normalizeModel(model: string): string {
    return (model || "").trim().toUpperCase();
}

export async function scrapeObservedUlineCartRows(page: Page): Promise<ObservedUlineCartRow[]> {
    const rows: Array<{ text: string; quantityValue: string }> = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("tr")).map(element => {
            const text = (element.textContent || "").replace(/\s+/g, " ").trim();
            const inputs = Array.from(element.querySelectorAll("input")) as HTMLInputElement[];
            const quantityInput = inputs.find(input =>
                /ItemQty/i.test(input.name || "")
                    || /qty/i.test(input.id || "")
                    || /qty/i.test(input.name || ""),
            );
            return {
                text,
                quantityValue: quantityInput?.value || "",
            };
        });
    }).catch(() => []);

    const parsed = rows.flatMap((row) => {
        const ulineModel = extractUlineModel(row.text);
        if (!ulineModel) return [];

        const moneyMatches = Array.from(
            row.text.matchAll(/\$-?\d[\d,]*(?:\.\d{2})?/g),
            match => parseCurrency(match[0]),
        ).filter((value): value is number => value !== null);

        const quantityMatch = row.quantityValue
            || row.text.match(/\bQty(?:\s*[:#-]?\s*|\s+)(\d[\d,]*)\b/i)?.[1];

        let quantity = quantityMatch ? Number(String(quantityMatch).replace(/,/g, "")) : NaN;
        const unitPrice = moneyMatches[0] ?? null;
        const lineTotal = moneyMatches.length > 1 ? moneyMatches[moneyMatches.length - 1] : null;

        if ((!Number.isFinite(quantity) || quantity <= 0) && unitPrice && lineTotal) {
            const derivedQuantity = lineTotal / unitPrice;
            if (Number.isFinite(derivedQuantity) && derivedQuantity > 0 && Math.abs(derivedQuantity - Math.round(derivedQuantity)) < 0.0001) {
                quantity = Math.round(derivedQuantity);
            }
        }

        if (!Number.isFinite(quantity) || quantity <= 0) return [];

        return [{
            ulineModel,
            quantity,
            unitPrice,
            lineTotal,
        }];
    });

    const unique = new Map<string, ObservedUlineCartRow>();
    for (const row of parsed) {
        unique.set(row.ulineModel, row);
    }
    return Array.from(unique.values());
}

export function diffObservedUlineCartRows(
    beforeRows: ObservedUlineCartRow[],
    afterRows: ObservedUlineCartRow[],
): ObservedUlineCartRow[] {
    const beforeByModel = new Map(
        beforeRows.map((row) => [normalizeModel(row.ulineModel), row]),
    );

    return afterRows.flatMap((row) => {
        const before = beforeByModel.get(normalizeModel(row.ulineModel));
        const quantityDelta = row.quantity - (before?.quantity ?? 0);
        if (!Number.isFinite(quantityDelta) || quantityDelta <= 0) return [];

        const afterLineTotal = row.lineTotal ?? null;
        const beforeLineTotal = before?.lineTotal ?? 0;
        const lineTotalDelta = afterLineTotal === null
            ? null
            : Math.round((afterLineTotal - beforeLineTotal) * 100) / 100;

        return [{
            ulineModel: row.ulineModel,
            quantity: quantityDelta,
            unitPrice: row.unitPrice ?? null,
            lineTotal: lineTotalDelta,
        }];
    });
}

export async function syncVerifiedUlineCartPricesToDraftPO(
    finale: FinaleClient,
    orderId: string | null | undefined,
    expectedItems: ExpectedUlineCartItem[],
    observedRows: ObservedUlineCartRow[],
    verification: CartVerificationResult,
): Promise<number> {
    if (!orderId) return 0;

    const updates = planDraftPOCartUpdates(expectedItems, observedRows, verification);
    let applied = 0;

    for (const update of updates) {
        if (typeof (finale as any).updateOrderItemQuantityAndPrice === "function") {
            await (finale as any).updateOrderItemQuantityAndPrice(
                orderId,
                update.finaleSku,
                update.newQuantity,
                update.newUnitPrice,
            );
        } else {
            await finale.updateOrderItemPrice(orderId, update.finaleSku, update.newUnitPrice);
        }
        applied += 1;
    }

    return applied;
}
