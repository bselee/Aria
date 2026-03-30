import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { buildSustainableVillageCartPlan, type SustainableVillageProductMapping } from "../lib/purchasing/sustainable-village-ordering";

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

const isDirectRun = process.argv[1]?.replace(/\\/g, "/").endsWith("cli/order-sustainable-village.ts")
    || process.argv[1]?.replace(/\\/g, "/").endsWith("cli/order-sustainable-village.js");

if (isDirectRun) {
    console.log("Sustainable Village ordering scaffold is ready. Use the dashboard route or import planSustainableVillageOrder() to build a cart plan.");
}
