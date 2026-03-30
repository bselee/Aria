import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
    populateSustainableVillageCart,
    verifySustainableVillageCart,
} from "../lib/purchasing/sustainable-village-cart-live";
import { buildSustainableVillageCartPlan, type SustainableVillageProductMapping } from "../lib/purchasing/sustainable-village-ordering";
import {
    launchSustainableVillageSession,
    openSustainableVillageStorefrontCart,
} from "../lib/purchasing/sustainable-village-session";

export interface SustainableVillageOrderInput {
    items: Array<{
        productId: string;
        quantity: number;
        unitPrice: number;
    }>;
    mappings: Record<string, SustainableVillageProductMapping>;
}

export async function planSustainableVillageOrder(input: SustainableVillageOrderInput) {
    return buildSustainableVillageCartPlan(input.items, input.mappings);
}

export async function runSustainableVillageCartPlan(
    input: SustainableVillageOrderInput,
    options: { headless?: boolean } = {},
) {
    const plan = buildSustainableVillageCartPlan(input.items, input.mappings);
    if (plan.status !== "ready") {
        return {
            success: false,
            itemsAdded: 0,
            message: "Sustainable Village cart requires manual review before automation can continue.",
            missingMappings: plan.missingMappings,
        };
    }

    const session = await launchSustainableVillageSession({ headless: options.headless ?? true });
    const page = session.context.pages()[0] || await session.context.newPage();

    try {
        await openSustainableVillageStorefrontCart(page);
        const observedLines = await populateSustainableVillageCart(page, plan.lines);
        const verification = verifySustainableVillageCart(plan.lines, observedLines);

        if (verification.status !== "verified") {
            return {
                success: false,
                itemsAdded: 0,
                message: "Sustainable Village cart fill could not be fully verified; manual review needed.",
                verification,
                observedLines,
            };
        }

        return {
            success: true,
            itemsAdded: plan.lines.length,
            message: "Sustainable Village cart verified and ready for checkout review.",
            verification,
            observedLines,
        };
    } finally {
        await session.close().catch(() => undefined);
    }
}

const isDirectRun = process.argv[1]?.replace(/\\/g, "/").endsWith("cli/order-sustainable-village.ts")
    || process.argv[1]?.replace(/\\/g, "/").endsWith("cli/order-sustainable-village.js");

if (isDirectRun) {
    console.log("Sustainable Village ordering is ready. Import runSustainableVillageCartPlan() or use the dashboard route to build and verify the cart.");
}
