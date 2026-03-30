import type { AssessedPurchasingLine } from "./assessment-service";

export interface DraftPOItemInput {
    productId: string;
    quantity: number;
    unitPrice: number;
    orderIncrementQty: number | null;
    isBulkDelivery: boolean;
}

export interface DraftPOPolicyResult {
    items: DraftPOItemInput[];
    blockedLines: AssessedPurchasingLine[];
}

export function buildDraftPOItemsFromAssessment(lines: AssessedPurchasingLine[]): DraftPOPolicyResult {
    const items: DraftPOItemInput[] = [];
    const blockedLines: AssessedPurchasingLine[] = [];

    for (const line of lines) {
        if (line.assessment.decision === "order" || line.assessment.decision === "reduce") {
            items.push({
                productId: line.item.productId,
                quantity: line.assessment.recommendedQty,
                unitPrice: line.item.unitPrice,
                orderIncrementQty: line.item.orderIncrementQty,
                isBulkDelivery: line.item.isBulkDelivery,
            });
            continue;
        }

        blockedLines.push(line);
    }

    return { items, blockedLines };
}

export function summarizeDraftPOPolicyResult(result: DraftPOPolicyResult): string {
    const parts = [`${result.items.length} actionable line${result.items.length === 1 ? "" : "s"}`];

    if (result.blockedLines.length > 0) {
        const blocked = result.blockedLines
            .map(line => `${line.item.productId}: ${line.assessment.explanation}`)
            .join("; ");
        parts.push(`${result.blockedLines.length} blocked`);
        parts.push(blocked);
    }

    return parts.join(" | ");
}
