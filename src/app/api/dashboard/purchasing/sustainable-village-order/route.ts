import { NextRequest, NextResponse } from "next/server";

import { buildSustainableVillageCartPlan, type SustainableVillageProductMapping } from "@/lib/purchasing/sustainable-village-ordering";

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

        return NextResponse.json({
            success: true,
            message: "Sustainable Village cart plan is ready for browser automation.",
            lines: plan.lines,
        });
    } catch (err: any) {
        return NextResponse.json(
            { success: false, message: `Sustainable Village order planning failed: ${err.message}` },
            { status: 500 },
        );
    }
}
