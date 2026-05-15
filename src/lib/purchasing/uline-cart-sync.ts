/**
 * @file    uline-cart-sync.ts
 * @purpose Final-check step for the ULINE order flow: after Aria pastes
 *          items into the cart, scrape the cart, diff against the source
 *          Finale PO, and (optionally) sync the PO to match the cart
 *          exactly. Catches:
 *            - items in cart that aren't on the PO (Will manually added,
 *              or pre-existing cart contents from before the script ran)
 *            - items on the PO that didn't land in cart (out of stock,
 *              removed manually)
 *            - quantity mismatches (Will reduced from Aria's suggestion)
 *            - unit price mismatches (already handled by existing
 *              syncVerifiedCartPricesToDraftPO; we don't re-do it here)
 *
 *          PO is updated to match what is actually being ordered, so the
 *          incoming ULINE invoice reconciles cleanly.
 *
 *          Pure planning function + Finale-write apply function. Default
 *          behavior in the CLI is: compute plan, print it, do NOT apply
 *          unless --sync-cart-to-po flag is set.
 */

import type {
    CartVerificationResult,
} from "../../cli/order-uline-cart";

export interface ObservedUlineCartRow {
    ulineModel: string;
    quantity: number;
    unitPrice: number | null;
    lineTotal: number | null;
}

export interface ExpectedItem {
    finaleSku: string;
    ulineModel: string;
    quantity: number;
    unitPrice: number;
}

export interface CartPOSyncPlan {
    /** ULINE models in cart but not on the PO — likely manual adds. */
    addToPO: Array<{
        ulineModel: string;
        quantity: number;
        unitPrice: number | null;
        /** Best-guess Finale SKU. ULINE models usually match the Finale
         *  SKU 1:1; the CLI/operator should confirm before applying. */
        suggestedFinaleSku: string;
    }>;
    /** Items on PO but absent from cart — should be removed from the PO. */
    removeFromPO: Array<{
        finaleSku: string;
        ulineModel: string;
        quantity: number;
    }>;
    /** Items present on both with different quantity — PO follows cart. */
    updateQuantity: Array<{
        finaleSku: string;
        ulineModel: string;
        poQuantity: number;
        cartQuantity: number;
        unitPrice: number;
    }>;
    /** Items that match exactly — no action. Surfaced for confidence. */
    matched: string[];
    hasDrift: boolean;
}

function normalizeModel(model: string): string {
    return (model || "").trim().toUpperCase();
}

/**
 * Compute the diff between the cart (observed) and the PO source manifest
 * (expected). Pure function — caller is responsible for fetching cart +
 * PO data.
 */
export function planCartToPOSync(
    expected: ExpectedItem[],
    observed: ObservedUlineCartRow[],
    verification: CartVerificationResult,
): CartPOSyncPlan {
    const expectedByModel = new Map(expected.map(e => [normalizeModel(e.ulineModel), e]));
    const observedByModel = new Map(observed.map(o => [normalizeModel(o.ulineModel), o]));

    // 1. Items in cart that aren't on the PO. verifyUlineCart already
    //    surfaces these via unexpectedModels — promote each to a
    //    structured "add to PO" entry with quantity + price from cart.
    const addToPO: CartPOSyncPlan["addToPO"] = [];
    for (const model of verification.unexpectedModels) {
        const cartRow = observedByModel.get(normalizeModel(model));
        if (!cartRow) continue;
        addToPO.push({
            ulineModel: model,
            quantity: cartRow.quantity,
            unitPrice: cartRow.unitPrice,
            // ULINE models map 1:1 to Finale SKUs for the vast majority
            // of products. The CLI surface confirms before applying.
            suggestedFinaleSku: model,
        });
    }

    // 2. Items on PO but not in cart. verifyUlineCart surfaces these
    //    via missingModels.
    const removeFromPO: CartPOSyncPlan["removeFromPO"] = [];
    for (const model of verification.missingModels) {
        const expectedItem = expectedByModel.get(normalizeModel(model));
        if (!expectedItem) continue;
        removeFromPO.push({
            finaleSku: expectedItem.finaleSku,
            ulineModel: expectedItem.ulineModel,
            quantity: expectedItem.quantity,
        });
    }

    // 3. Items in both with different qty. verifyUlineCart's
    //    quantityMismatches already has this.
    const updateQuantity: CartPOSyncPlan["updateQuantity"] = [];
    for (const mismatch of verification.quantityMismatches) {
        const expectedItem = expectedByModel.get(normalizeModel(mismatch.ulineModel));
        if (!expectedItem) continue;
        updateQuantity.push({
            finaleSku: expectedItem.finaleSku,
            ulineModel: mismatch.ulineModel,
            poQuantity: mismatch.expectedQuantity,
            cartQuantity: mismatch.observedQuantity,
            unitPrice: expectedItem.unitPrice,
        });
    }

    const matched = verification.matchedModels.slice();
    const hasDrift = addToPO.length > 0 || removeFromPO.length > 0 || updateQuantity.length > 0;

    return { addToPO, removeFromPO, updateQuantity, matched, hasDrift };
}

/**
 * Format a sync plan for terminal output. Returns lines joined with newlines.
 */
export function formatSyncPlanForCLI(plan: CartPOSyncPlan): string {
    const lines: string[] = [];
    lines.push("");
    lines.push("   ╔══════════════════════════════════════════════════╗");
    lines.push("   ║   ULINE Cart vs PO — Final Verify                ║");
    lines.push("   ╚══════════════════════════════════════════════════╝");

    if (!plan.hasDrift) {
        lines.push(`   ✅ Cart matches PO exactly (${plan.matched.length} items aligned)`);
        return lines.join("\n");
    }

    if (plan.addToPO.length > 0) {
        lines.push(`   ➕ In cart, NOT on PO (${plan.addToPO.length}) — likely manual adds:`);
        for (const a of plan.addToPO) {
            const price = a.unitPrice != null ? `$${a.unitPrice.toFixed(2)}` : "$?";
            lines.push(`      • ${a.ulineModel}  qty=${a.quantity}  ${price}`);
        }
    }
    if (plan.removeFromPO.length > 0) {
        lines.push(`   ➖ On PO, NOT in cart (${plan.removeFromPO.length}) — removed / out of stock:`);
        for (const r of plan.removeFromPO) {
            lines.push(`      • ${r.ulineModel} (${r.finaleSku})  poQty=${r.quantity}`);
        }
    }
    if (plan.updateQuantity.length > 0) {
        lines.push(`   ⚠️  Quantity mismatches (${plan.updateQuantity.length}) — Will likely reduced:`);
        for (const u of plan.updateQuantity) {
            lines.push(`      • ${u.ulineModel}  PO=${u.poQuantity}  →  cart=${u.cartQuantity}`);
        }
    }
    if (plan.matched.length > 0) {
        lines.push(`   ✅ Matched (${plan.matched.length}): ${plan.matched.slice(0, 5).join(", ")}${plan.matched.length > 5 ? ", ..." : ""}`);
    }
    return lines.join("\n");
}

// ── Apply path (writes to Finale) ──────────────────────────────────────────

/**
 * Result of applying a sync plan to a Finale PO.
 */
export interface CartPOSyncResult {
    added: string[];
    removed: string[];
    updated: string[];
    errors: string[];
}

/**
 * Apply a sync plan to a Finale PO. Each operation is independent —
 * partial failure is logged but doesn't abort the whole sync.
 *
 * @param finale  - FinaleClient instance
 * @param orderId - Finale PO id
 * @param plan    - Sync plan from planCartToPOSync
 */
export async function applyCartToPOSync(
    finale: any,
    orderId: string,
    plan: CartPOSyncPlan,
): Promise<CartPOSyncResult> {
    const result: CartPOSyncResult = { added: [], removed: [], updated: [], errors: [] };

    // 1. Add items from cart that aren't on the PO.
    for (const add of plan.addToPO) {
        try {
            // Need to confirm the SKU exists in Finale before adding.
            const product = await finale.lookupProduct(add.suggestedFinaleSku);
            if (!product) {
                result.errors.push(`${add.ulineModel}: Finale SKU ${add.suggestedFinaleSku} not found — skipped`);
                continue;
            }
            await finale.addItemsToPO(orderId, [{
                productId: add.suggestedFinaleSku,
                quantity: add.quantity,
                unitPrice: add.unitPrice ?? 0,
            }]);
            result.added.push(`${add.ulineModel} × ${add.quantity}`);
        } catch (err: any) {
            result.errors.push(`${add.ulineModel} add failed: ${err?.message ?? err}`);
        }
    }

    // 2. Update quantities for mismatched items. Preserve the PO's existing
    //    unit price — qty change only.
    for (const upd of plan.updateQuantity) {
        try {
            await finale.updateOrderItemQuantityAndPrice(
                orderId,
                upd.finaleSku,
                upd.cartQuantity,
                upd.unitPrice,
            );
            result.updated.push(`${upd.ulineModel}: ${upd.poQuantity} → ${upd.cartQuantity}`);
        } catch (err: any) {
            result.errors.push(`${upd.ulineModel} qty update failed: ${err?.message ?? err}`);
        }
    }

    // 3. Remove items from PO that weren't in cart.
    // Note: leaving this commented for safety — removing a PO line is
    // a destructive op and Will may want to keep the line for audit.
    // Surface in CLI output instead; if Will wants to remove, do it manually.
    for (const rem of plan.removeFromPO) {
        result.errors.push(
            `${rem.ulineModel} on PO but not in cart — leaving on PO for manual review (auto-remove disabled)`,
        );
    }

    return result;
}
