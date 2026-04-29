/**
 * @file    route.ts
 * @purpose Headless ULINE ordering for the dashboard purchasing panel.
 *
 * Finale quantities are interpreted in eaches, then converted into the
 * ULINE ordering format through the shared vendor rule layer.
 */

import { NextRequest, NextResponse } from "next/server";
import { runUlineOrder } from "../../../../../lib/purchasing/uline-order-service";

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
        const result = await runUlineOrder({ items, draftPO: draftPO ?? null });
        return NextResponse.json(result, { status: result.success ? 200 : result.message === "No items provided" ? 400 : 200 });
    } catch (err: any) {
        console.error("[uline-order] Error:", err.message);
        return NextResponse.json(
            { success: false, itemsAdded: 0, message: `ULINE order failed: ${err.message}` },
            { status: 500 },
        );
    }
}
