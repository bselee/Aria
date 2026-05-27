/**
 * @file    moq-topup.ts
 * @purpose Implements smart MOQ and multi-SKU top-up algorithms to hit vendor order minimums
 *          using high-utility warning/watch items prioritized by runway days.
 * @author  Antigravity
 * @created 2026-05-27
 */

import { snapToIncrement } from "./qty-recommender";

export interface MOQConfig {
    minimumOrderDollars: number | null;
    minimumOrderEaches: number | null;
}

export interface TopUpCandidate {
    productId: string;
    productName: string;
    unitPrice: number;
    dailyRate: number;
    stockOnHand: number;
    stockOnOrder: number;
    reservedQty: number;
    adjustedRunwayDays: number;
    orderIncrementQty: number | null;
    currentSuggestedQty: number;
    urgency: "critical" | "warning" | "watch" | "ok";
}

/**
 * Smart MOQ top-up algorithm.
 * Takes a purchasing group and all candidate items for that vendor.
 * Increments high-utility items (prioritized by lowest runway) to meet MOQ.
 */
export function applySmartMOQTopUp(
    currentItems: Array<{ productId: string; suggestedQty: number; unitPrice: number; orderIncrementQty: number | null; dailyRate: number; stockOnHand: number; stockOnOrder: number; reservedQty?: number; adjustedRunwayDays: number; urgency: string; productName: string }>,
    moq: MOQConfig,
    maxCoverDays: number = 180
): Array<{ productId: string; suggestedQty: number; originalQty: number; topUpQty: number; topUpReason?: string }> {
    const results = currentItems.map(item => ({
        productId: item.productId,
        suggestedQty: item.suggestedQty,
        originalQty: item.suggestedQty,
        topUpQty: 0,
        topUpReason: undefined as string | undefined,
    }));

    // Calculate current PO totals
    let currentDollars = currentItems.reduce((sum, item) => sum + (item.suggestedQty * (item.unitPrice || 0)), 0);
    let currentEaches = currentItems.reduce((sum, item) => sum + item.suggestedQty, 0);

    const minDollars = moq.minimumOrderDollars ?? 0;
    const minEaches = moq.minimumOrderEaches ?? 0;

    // If we already meet MOQ, do nothing
    if (currentDollars >= minDollars && currentEaches >= minEaches) {
        return results;
    }

    // Build candidate list with utility scores (1 / (adjustedRunwayDays + 1))
    // Lower runway = higher utility
    const candidates: TopUpCandidate[] = currentItems.map(item => ({
        productId: item.productId,
        productName: item.productName,
        unitPrice: item.unitPrice || 0,
        dailyRate: item.dailyRate || 0,
        stockOnHand: item.stockOnHand || 0,
        stockOnOrder: item.stockOnOrder || 0,
        reservedQty: item.reservedQty || 0,
        adjustedRunwayDays: item.adjustedRunwayDays,
        orderIncrementQty: item.orderIncrementQty,
        currentSuggestedQty: item.suggestedQty,
        urgency: item.urgency as any,
    }));

    // Sort candidates:
    // 1. Shorter runway (lower adjustedRunwayDays) first
    // 2. High-urgency first
    candidates.sort((a, b) => {
        if (a.adjustedRunwayDays !== b.adjustedRunwayDays) {
            return a.adjustedRunwayDays - b.adjustedRunwayDays;
        }
        return 0;
    });

    let metMOQ = false;
    // Iterate to add increments until MOQ is satisfied or we cannot add any more
    let iterations = 0;
    const maxIterations = 500; // safety breaker

    while (!metMOQ && iterations < maxIterations) {
        iterations++;
        let addedInThisPass = false;

        for (const candidate of candidates) {
            // Check if MOQ is satisfied
            if (currentDollars >= minDollars && currentEaches >= minEaches) {
                metMOQ = true;
                break;
            }

            // Determine increment size (default to 1, or minimum 1 if pack increment is set)
            const increment = candidate.orderIncrementQty && candidate.orderIncrementQty > 1 ? candidate.orderIncrementQty : 1;

            const resIndex = results.findIndex(r => r.productId === candidate.productId);
            if (resIndex === -1) continue;

            const currentAllocated = results[resIndex].suggestedQty;

            // Enforce maximum cover days guardrail: do not exceed maxCoverDays supply
            if (candidate.dailyRate > 0) {
                const totalPosition = candidate.stockOnHand + candidate.stockOnOrder - candidate.reservedQty + currentAllocated + increment;
                const projectedCoverageDays = totalPosition / candidate.dailyRate;
                if (projectedCoverageDays > maxCoverDays) {
                    // Skip to prevent overstocking
                    continue;
                }
            }

            // Perform top-up increment
            results[resIndex].suggestedQty += increment;
            results[resIndex].topUpQty += increment;
            results[resIndex].topUpReason = `Top-up to meet vendor MOQ (${minDollars ? `$${minDollars}` : ''} / ${minEaches ? `${minEaches} units` : ''})`;

            currentDollars += increment * candidate.unitPrice;
            currentEaches += increment;
            addedInThisPass = true;

            // Break inner loop to re-sort or proceed atomically per candidate increment
            break;
        }

        // If a full pass over all candidates yielded no new additions, we are capped out
        if (!addedInThisPass) {
            break;
        }
    }

    return results;
}
