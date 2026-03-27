/**
 * @file    route.ts
 * @purpose Headless ULINE ordering for the dashboard purchasing panel.
 *
 * Finale quantities are interpreted in eaches, then converted into the
 * ULINE ordering format through the shared vendor rule layer.
 */

import { NextRequest, NextResponse } from "next/server";
import { FinaleClient } from "../../../../../lib/finale/client";
import { verifyUlineCart } from "../../../../../cli/order-uline-cart";
import {
    scrapeObservedUlineCartRows,
    syncVerifiedUlineCartPricesToDraftPO,
} from "../../../../../lib/purchasing/uline-cart-live";
import { convertFinaleItemToUlineOrder } from "../../../../../lib/purchasing/uline-ordering";
import {
    launchUlineSession,
    openUlinePasteItemsPage,
} from "../../../../../lib/purchasing/uline-session";

interface UlineOrderItem {
    productId: string;
    quantity: number;
    unitPrice?: number;
}

interface UlineOrderResult {
    success: boolean;
    itemsAdded: number;
    message: string;
    priceUpdatesApplied?: number;
    errors?: string[];
}

export async function POST(req: NextRequest): Promise<NextResponse<UlineOrderResult>> {
    try {
        const { items, draftPO } = await req.json() as { items: UlineOrderItem[]; draftPO?: string };

        if (!Array.isArray(items) || items.length === 0) {
            return NextResponse.json(
                { success: false, itemsAdded: 0, message: "No items provided" },
                { status: 400 },
            );
        }

        const convertedItems = items.map(item => convertFinaleItemToUlineOrder({
            finaleSku: item.productId,
            finaleEachQuantity: item.quantity,
            finaleUnitPrice: item.unitPrice ?? 0,
            description: item.productId,
        }));
        const blockingWarnings = convertedItems.flatMap(item =>
            item.guardrailWarnings.filter(warning => warning.includes("exceeds the")),
        );

        if (blockingWarnings.length > 0) {
            return NextResponse.json(
                {
                    success: false,
                    itemsAdded: 0,
                    message: `ULINE guardrail blocked the order: ${blockingWarnings[0]}`,
                    errors: blockingWarnings,
                },
                { status: 400 },
            );
        }

        const pasteText = convertedItems
            .map(item => `${item.ulineModel}, ${item.quantity}`)
            .join("\n");

        console.log(`[uline-order] Adding ${convertedItems.length} items to ULINE cart (headless)...`);
        console.log(`[uline-order] Paste text:\n${pasteText}`);

        const session = await launchUlineSession({ headless: true });
        const { context } = session;

        const page = context.pages()[0] || await context.newPage();

        try {
            await openUlinePasteItemsPage(page);
            await page.fill("#txtPaste", pasteText);
            await page.waitForTimeout(500);

            let addClicked = false;
            const selectors = [
                "#btnAddPastedItemsToCart",
                "#btnAddToCart",
                "input[type=\"submit\"][value*=\"Add\"]",
                "input[type=\"button\"][value*=\"Add\"]",
                "button:has-text(\"Add to Cart\")",
                "input[value*=\"Add to Cart\"]",
                "a:has-text(\"Add to Cart\")",
                "input[value*=\"Add Items\"]",
                "button:has-text(\"Add Items\")",
            ];

            for (const selector of selectors) {
                const button = await page.$(selector);
                if (button && await button.isVisible().catch(() => false)) {
                    await button.click();
                    addClicked = true;
                    break;
                }
            }

            if (!addClicked) {
                try {
                    const roleButton = page.getByRole("button", { name: /add/i }).first();
                    if (await roleButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
                        await roleButton.click();
                        addClicked = true;
                    }
                } catch {
                    // no-op
                }
            }

            await page.waitForTimeout(3_000);

            const errors: string[] = [];
            const observedRows = addClicked
                ? await scrapeObservedUlineCartRows(page)
                : [];
            const verification = verifyUlineCart(convertedItems, observedRows);
            const errorText = await page.$eval(
                ".error, .errorMessage, .alert-danger",
                element => element.textContent?.trim() || "",
            ).catch(() => "");
            if (errorText) {
                errors.push(errorText);
            }

            await session.close();

            if (!addClicked) {
                return NextResponse.json({
                    success: false,
                    itemsAdded: 0,
                    message: "Items were pasted but the Add to Cart button was not found",
                    errors,
                });
            }

            if (verification.status !== "verified") {
                return NextResponse.json({
                    success: false,
                    itemsAdded: 0,
                    message: "ULINE cart fill could not be verified; manual review needed.",
                    priceUpdatesApplied: 0,
                    errors: errors.length > 0 ? errors : undefined,
                });
            }

            let priceUpdatesApplied = 0;
            if (draftPO) {
                const finale = new FinaleClient();
                priceUpdatesApplied = await syncVerifiedUlineCartPricesToDraftPO(
                    finale,
                    draftPO,
                    convertedItems,
                    observedRows,
                    verification,
                );
            }

            const priceMessage = priceUpdatesApplied > 0
                ? ` Applied ${priceUpdatesApplied} verified price update(s) to draft PO ${draftPO}.`
                : "";

            return NextResponse.json({
                success: true,
                itemsAdded: convertedItems.length,
                message: `Added ${convertedItems.length} verified item(s) to ULINE cart.${priceMessage}`.trim(),
                priceUpdatesApplied,
                errors: errors.length > 0 ? errors : undefined,
            });
        } catch (err) {
            try {
                await session.close();
            } catch {
                // best effort
            }
            throw err;
        }
    } catch (err: any) {
        console.error("[uline-order] Error:", err.message);
        return NextResponse.json(
            { success: false, itemsAdded: 0, message: `ULINE order failed: ${err.message}` },
            { status: 500 },
        );
    }
}
