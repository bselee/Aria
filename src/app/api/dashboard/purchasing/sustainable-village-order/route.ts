import { NextRequest, NextResponse } from "next/server";

import { buildSustainableVillageCartPlan, type SustainableVillageProductMapping } from "@/lib/purchasing/sustainable-village-ordering";
import {
    populateSustainableVillageCart,
    verifySustainableVillageCart,
} from "@/lib/purchasing/sustainable-village-cart-live";
import {
    launchSustainableVillageSession,
    openSustainableVillageStorefrontCart,
} from "@/lib/purchasing/sustainable-village-session";

export async function POST(req: NextRequest) {
    try {
        const { items, mappings } = await req.json() as {
            items: Array<{ productId: string; quantity: number; unitPrice: number }>;
            mappings?: Record<string, SustainableVillageProductMapping>;
        };

        if (!Array.isArray(items) || items.length === 0) {
            return NextResponse.json(
                { success: false, message: "No items provided" },
                { status: 400 },
            );
        }

        const plan = buildSustainableVillageCartPlan(items, mappings ?? {});
        if (plan.status !== "ready") {
            return NextResponse.json({
                success: false,
                message: "Sustainable Village cart requires manual review before automation can continue.",
                missingMappings: plan.missingMappings,
            }, { status: 400 });
        }

        const session = await launchSustainableVillageSession({ headless: true });
        const page = session.context.pages()[0] || await session.context.newPage();

        try {
            await openSustainableVillageStorefrontCart(page);
            const observedLines = await populateSustainableVillageCart(page, plan.lines);
            const verification = verifySustainableVillageCart(plan.lines, observedLines);

            if (verification.status !== "verified") {
                return NextResponse.json({
                    success: false,
                    itemsAdded: 0,
                    message: "Sustainable Village cart fill could not be fully verified; manual review needed.",
                    verification,
                    observedLines,
                });
            }

            return NextResponse.json({
                success: true,
                itemsAdded: plan.lines.length,
                message: "Sustainable Village cart verified and ready for checkout review.",
                lines: plan.lines,
                observedLines,
                verification,
            });
        } finally {
            await session.close().catch(() => undefined);
        }

    } catch (err: any) {
        return NextResponse.json(
            { success: false, message: `Sustainable Village order planning failed: ${err.message}` },
            { status: 500 },
        );
    }
}
